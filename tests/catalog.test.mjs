import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { loadCatalog, selectOperations, convertSchema } from '../dist/catalog.js';
import { readConfig } from '../dist/config.js';

const key = 'anonk_' + 'a'.repeat(64);
const catalog = loadCatalog();
const byName = name => catalog.find(o => o.tool.name === name);
const ajv = new Ajv({ strict: false, formats: fullFormats });

test('all generated tools have unique, valid names and compilable schemas', () => {
  assert.ok(catalog.length > 100);
  assert.equal(new Set(catalog.map(o => o.tool.name)).size, catalog.length);
  for (const { tool, path, method } of catalog) {
    assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
    ajv.compile(tool.inputSchema);
    assert.equal(tool.annotations.readOnlyHint, method === 'GET');
    assert.ok(path.startsWith('/api/projects/{id}') || ['/api/health', '/api/open/me'].includes(path));
    assert.equal(tool.inputSchema.properties?.path?.properties?.id, undefined);
  }
});

test('credential issuing, password reveal and non-project endpoints are excluded', () => {
  assert.ok(byName('anon_get_open_me'));
  assert.ok(byName('anon_get_health'));
  assert.ok(catalog.every(o => !/\/reveal$|\/launch$|\/auth\/|\/open\/keys|\/cron\//.test(o.path)));
});

test('module and read-only restrictions retain identity and reject misspelled modules', () => {
  const filtered = selectOperations(catalog, { modules: ['todos'], readOnly: true });
  assert.ok(filtered.some(o => o.tool.name === 'anon_get_todos'));
  assert.ok(filtered.some(o => o.tool.name === 'anon_get_open_me'));
  assert.ok(filtered.every(o => o.method === 'GET' && ['todos', 'system'].includes(o.module)));
  assert.throws(() => selectOperations(catalog, { modules: ['typo'], readOnly: false }), /未知/);
});

test('schema validates required bodies, query enums, dates and project override attempts', () => {
  const create = ajv.compile(byName('anon_post_todos').tool.inputSchema);
  assert.equal(create({}), false);
  assert.equal(create({ body: { title: '场地确认' } }), true);
  assert.equal(create({ body: { title: '场地确认', dueAt: 'tomorrow' } }), false);
  const list = ajv.compile(byName('anon_get_todos').tool.inputSchema);
  assert.equal(list({ query: { status: 'unknown' } }), false);
  assert.equal(list({ query: { status: 'open' } }), true);
  assert.equal(list({ projectId: 'other-project' }), false);
  const update = ajv.compile(byName('anon_patch_todos_todo_id').tool.inputSchema);
  assert.equal(update({ path: { todoId: 'todo', id: 'other-project' }, body: {} }), false);
});

test('nullable references and enums accept null without weakening validation', () => {
  const doc = { components: { schemas: { Status: { type: 'string', enum: ['open', 'done'] } } } };
  const validate = ajv.compile(convertSchema({ $ref: '#/components/schemas/Status', nullable: true }, doc));
  assert.equal(validate(null), true);
  assert.equal(validate('open'), true);
  assert.equal(validate('other'), false);
  assert.throws(() => convertSchema({ $ref: 'https://example.com/schema' }, doc), /Unsupported/);
});

test('configuration normalizes /api and validates key, origin, flags and timeout', () => {
  const config = readConfig({ ANON_API_KEY: key, ANON_BASE_URL: 'https://example.com/api/' });
  assert.equal(config.baseUrl, 'https://example.com');
  assert.equal(config.readOnly, false);
  for (const env of [
    { ANON_API_KEY: 'jwt' },
    { ANON_BASE_URL: 'https://user:password@example.com' },
    { ANON_BASE_URL: 'https://example.com?token=secret' },
    { ANON_BASE_URL: 'file:///tmp' },
    { ANON_BASE_URL: 'https://example.com/backend' },
    { ANON_READ_ONLY: 'yes' },
    { ANON_TIMEOUT_MS: '0' },
    { ANON_PROJECT_ID: '../other' },
  ]) assert.throws(() => readConfig({ ANON_API_KEY: key, ...env }));
});
