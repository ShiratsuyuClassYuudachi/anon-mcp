import { Ajv } from 'ajv';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { AnonClient, AnonError } from './client.js';
import { loadCatalog, selectOperations } from './catalog.js';
import type { Config } from './types.js';

export const guide = `ANON MCP 使用说明
1. 先调用 anon_get_open_me 查看当前项目、有效权限和密钥有效期。
2. 所有项目工具自动绑定密钥所属项目；path 中只传实体 ID，query 放过滤条件，body 放请求体。
3. 时间字段使用带时区的 ISO 8601；金额单位为元。先查询成员 ID 再分配任务。
4. 工具可见不代表具有写权限，ANON 后端每次请求实时校验 scopes 与角色权限。
5. 附件使用 {filename, mimeType?, base64}，单个最多 20 MiB。二进制响应返回 base64，响应上限 8 MiB。
6. 401 请更新密钥；403 检查 scope/角色；429 稍后重试。写操作不自动重试。
7. 不提供登录、创建/枚举项目、创建密钥、浏览器启动令牌、密码查看、/api/files 全局下载。
8. 模块选择与只读模式在进程启动时生效；切换配置后重启 MCP。
`;

export function createServer(config: Config, fetcher?: typeof fetch): Server {
  const operations = selectOperations(loadCatalog(), config);
  const client = new AnonClient(config, fetcher);
  const ajv = new Ajv({ allErrors: true, strict: false, formats: fullFormats });
  const tools = new Map(operations.map(operation =>
    [operation.tool.name, { operation, validate: ajv.compile(operation.tool.inputSchema) }]));
  const server = new Server({ name: 'anon-mcp', version: '0.1.0' }, {
    capabilities: { tools: {}, resources: {} },
    instructions: guide,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: operations.map(o => o.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = tools.get(request.params.name);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, '未知或当前配置未开放的 ANON 工具');
    const args = request.params.arguments ?? {};
    if (!entry.validate(args)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: {
          code: 'invalid_arguments',
          message: ajv.errorsText(entry.validate.errors, { dataVar: 'arguments' }),
        } }) }],
      };
    }
    try {
      const result = await client.call(entry.operation, args, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const failure = error instanceof AnonError ? error : new AnonError('internal_error', 'MCP 调用失败');
      const result = { error: { code: failure.code, message: failure.message, status: failure.status } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{
    uri: 'anon://guide', name: 'ANON MCP 使用说明', mimeType: 'text/plain',
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== 'anon://guide') throw new McpError(ErrorCode.InvalidParams, '未知资源');
    return { contents: [{ uri: 'anon://guide', mimeType: 'text/plain', text: guide }] };
  });
  return server;
}
