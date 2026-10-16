import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Config, Operation, Schema } from './types.js';

const projectPrefix = '/api/projects/{id}';
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const fileSchema: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['filename', 'base64'],
  properties: {
    filename: { type: 'string', minLength: 1, description: '文件名，例如 poster.png' },
    mimeType: { type: 'string', description: 'MIME 类型，默认 application/octet-stream' },
    base64: { type: 'string', description: '文件内容的标准 Base64，不含 data: 前缀，解码后最多 20 MiB' },
  },
};

/** Expand local references and translate OpenAPI 3.0 schemas to JSON Schema. */
export function convertSchema(value: Schema, document: Schema, refs: string[] = []): Schema {
  let schema = value;
  if (value.$ref) {
    const ref = String(value.$ref);
    if (!ref.startsWith('#/') || refs.includes(ref)) throw new Error(`Unsupported schema reference: ${ref}`);
    const target = ref.slice(2).split('/').reduce((obj, key) => obj?.[key], document);
    if (!target) throw new Error(`Missing schema reference: ${ref}`);
    const { $ref: _, ...siblings } = value;
    schema = { ...convertSchema(target, document, [...refs, ref]), ...siblings };
  }
  const result: Schema = {};
  for (const [key, item] of Object.entries(schema)) {
    if (['nullable', 'example', 'xml', 'discriminator', 'deprecated'].includes(key)) continue;
    if (key === 'properties') {
      result.properties = Object.fromEntries(Object.entries(item).map(([name, child]) =>
        [name, convertSchema(child as Schema, document, refs)]));
    } else if (['items', 'additionalProperties', 'not'].includes(key) && typeof item === 'object' && item !== null) {
      result[key] = convertSchema(item, document, refs);
    } else if (['allOf', 'oneOf', 'anyOf'].includes(key)) {
      result[key] = item.map((child: Schema) => convertSchema(child, document, refs));
    } else {
      result[key] = item;
    }
  }
  if (result.format === 'binary') return { ...structuredClone(fileSchema), description: result.description };
  if (schema.nullable) {
    // anyOf also handles nullable $ref/enum schemas correctly.
    return { anyOf: [result, { type: 'null' }] };
  }
  return result;
}

function objectSchema(): Schema {
  return { type: 'object', properties: {}, required: [], additionalProperties: false };
}

function snake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '').toLowerCase();
}

export function compileCatalog(document: Schema): Operation[] {
  const operations: Operation[] = [];
  const names = new Set<string>();
  for (const [path, item] of Object.entries(document.paths) as [string, Schema][]) {
    if (path !== '/api/open/me' && path !== '/api/health' &&
        path !== projectPrefix && !path.startsWith(`${projectPrefix}/`)) continue;
    // Browser credential exchange and password reveal are separate user workflows.
    if (/\/custom-tools\/\{toolId\}\/launch$|\/accounts\/\{accountId\}\/reveal$/.test(path)) continue;
    for (const [method, operation] of Object.entries(item) as [string, Schema][]) {
      if (!methods.has(method)) continue;
      const suffix = path.startsWith(projectPrefix) ? path.slice(projectPrefix.length) || '/project' : path.slice(5);
      const name = `anon_${method}_${snake(suffix)}`;
      if (names.has(name) || name.length > 64) throw new Error(`Invalid or duplicate tool name: ${name}`);
      names.add(name);
      const input = objectSchema();
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])] as Schema[];
      const queryParameters: Operation['queryParameters'] = [];
      for (const location of ['path', 'query']) {
        const group = objectSchema();
        for (const parameter of parameters) {
          if (parameter.in !== location || (location === 'path' && parameter.name === 'id')) continue;
          if (parameter.style && !['simple', 'form'].includes(parameter.style)) {
            throw new Error(`Unsupported parameter serialization: ${name}/${parameter.name}`);
          }
          group.properties[parameter.name] = convertSchema(parameter.schema ?? { type: 'string' }, document);
          if (location === 'path') {
            group.properties[parameter.name] = { ...group.properties[parameter.name], minLength: 1 };
          }
          if (parameter.description) group.properties[parameter.name].description = parameter.description;
          if (parameter.required) group.required.push(parameter.name);
          if (location === 'query') queryParameters.push({ name: parameter.name, explode: parameter.explode });
        }
        if (Object.keys(group.properties).length) {
          input.properties[location] = group;
          if (group.required.length) input.required.push(location);
        }
      }
      const request = operation.requestBody;
      let bodyType: Operation['bodyType'];
      let multipartSchema: Schema | undefined;
      if (request) {
        bodyType = request.content['application/json'] ? 'application/json' :
          request.content['multipart/form-data'] ? 'multipart/form-data' : undefined;
        if (!bodyType) throw new Error(`Unsupported request body: ${name}`);
        const originalSchema = request.content[bodyType].schema;
        input.properties.body = convertSchema(originalSchema, document);
        if (request.required) input.required.push('body');
        if (bodyType === 'multipart/form-data') multipartSchema = originalSchema;
      }
      const readOnly = method === 'get';
      operations.push({
        module: path.startsWith(projectPrefix) ? path.slice(projectPrefix.length).split('/')[1] || 'project' : 'system',
        method: method.toUpperCase(), path, bodyType, multipartSchema, queryParameters,
        tool: {
          name,
          description: `${operation.summary ?? name}。${operation.description ?? ''}\n${method.toUpperCase()} ${path}` +
            (path.startsWith(projectPrefix) ? '\n项目由当前 API 密钥自动确定，无需传 projectId。' : ''),
          inputSchema: input as Operation['tool']['inputSchema'],
          annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
        },
      });
    }
  }
  return operations.sort((a, b) => a.tool.name.localeCompare(b.tool.name, 'en'));
}

export function loadCatalog(): Operation[] {
  return compileCatalog(parse(readFileSync(new URL('../resources/anon-openapi.yaml', import.meta.url), 'utf8')));
}

export function selectOperations(operations: Operation[], config: Pick<Config, 'modules' | 'readOnly'>): Operation[] {
  const modules = new Set(operations.map(operation => operation.module));
  for (const name of config.modules) {
    if (!modules.has(name)) throw new Error(`未知 ANON_MODULES 模块：${name}；可选：${[...modules].sort().join(',')}`);
  }
  return operations.filter(operation =>
    (!config.readOnly || operation.method === 'GET') &&
    (operation.module === 'system' || !config.modules.length || config.modules.includes(operation.module)));
}
