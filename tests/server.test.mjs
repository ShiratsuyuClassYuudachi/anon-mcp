import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { readConfig } from '../dist/config.js';

const key = 'anonk_' + 'd'.repeat(64);

test('MCP handshake, listing, resources, validated calls and tool errors', { timeout: 10000 }, async t => {
  let calls = 0;
  const server = createServer(readConfig({ ANON_API_KEY: key, ANON_MODULES: 'todos' }), async url => {
    calls++;
    if (url.endsWith('/api/open/me')) return Response.json({ project: { id: 'a'.repeat(24) } });
    return Response.json({ error: { code: 'forbidden', message: '没有权限' } }, { status: 403 });
  });
  const client = new Client({ name: 'anon-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion().name, 'anon-mcp');
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'anon_post_todos'));
  assert.ok(!tools.some(tool => tool.name === 'anon_get_finance'));
  assert.equal(calls, 0, 'Discovery must not need an ANON connection');
  const resources = await client.listResources();
  assert.equal(resources.resources[0].uri, 'anon://guide');
  const guide = await client.readResource({ uri: 'anon://guide' });
  assert.match(guide.contents[0].text, /anon_get_open_me/);
  const bad = await client.callTool({ name: 'anon_post_todos', arguments: {} });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /invalid_arguments/);
  assert.equal(calls, 0);
  const me = await client.callTool({ name: 'anon_get_open_me', arguments: {} });
  assert.equal(me.structuredContent.data.project.id, 'a'.repeat(24));
  const forbidden = await client.callTool({ name: 'anon_post_todos', arguments: { body: { title: '检查场地' } } });
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden.structuredContent.error.code, 'forbidden');
  assert.equal(forbidden.structuredContent.error.status, 403);
  await assert.rejects(client.callTool({ name: 'anon_get_finance', arguments: {} }), /未开放/);
});

test('real stdio subprocess initializes and lists tools without protocol pollution', { timeout: 10000 }, async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ANON_API_KEY: key, ANON_MODULES: 'todos', ANON_READ_ONLY: 'true' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'anon_get_todos'));
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  assert.equal(stderr, '');
});

test('invalid configuration exits with actionable stderr and empty stdout', { timeout: 10000 }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
    env: { ...process.env, ANON_API_KEY: 'invalid-secret-value' },
  }), error => error.code === 1 && error.stdout === '' && error.stderr.includes('ANON_API_KEY') &&
    !error.stderr.includes('invalid-secret-value'));
});
