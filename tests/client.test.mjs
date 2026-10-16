import test from 'node:test';
import assert from 'node:assert/strict';
import { AnonClient, AnonError } from '../dist/client.js';
import { loadCatalog } from '../dist/catalog.js';
import { readConfig } from '../dist/config.js';

const project = 'a'.repeat(24);
const key = 'anonk_' + 'b'.repeat(64);
const config = (env = {}) => readConfig({ ANON_API_KEY: key, ...env });
const catalog = loadCatalog();
const operation = name => {
  const result = catalog.find(o => o.tool.name === name);
  assert.ok(result, `Missing operation ${name}`);
  return result;
};
const json = (body, status = 200) => Response.json(body, { status });
const identity = () => json({ project: { id: project, name: '测试活动' }, permissions: ['todo:create'], expiresAt: null });

function backend(handler) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url: new URL(url), init });
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.redirect, 'error');
    if (new URL(url).pathname === '/api/open/me') return identity();
    return handler(new URL(url), init);
  };
  return { requests, fetcher };
}

test('binds project from identity, serializes filters and caches only project ID', async () => {
  const fake = backend(url => {
    assert.equal(url.pathname, `/api/projects/${project}/todos`);
    assert.equal(url.searchParams.get('status'), 'open');
    return json({ todos: [] });
  });
  const client = new AnonClient(config(), fake.fetcher);
  const result = await client.call(operation('anon_get_todos'), { query: { status: 'open' } });
  assert.deepEqual(result, { status: 200, data: { todos: [] } });
  await client.call(operation('anon_get_todos'), { query: { status: 'open' } });
  assert.equal(fake.requests.filter(r => r.url.pathname === '/api/open/me').length, 1);
  await client.identity();
  assert.equal(fake.requests.filter(r => r.url.pathname === '/api/open/me').length, 2);
});

test('sends writes once as JSON without retry', async () => {
  const fake = backend((url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { title: '现场签到' });
    return json({ todo: { id: 'todo1' } }, 201);
  });
  const result = await new AnonClient(config(), fake.fetcher).call(operation('anon_post_todos'), { body: { title: '现场签到' } });
  assert.equal(result.status, 201);
  assert.equal(fake.requests.length, 2);
});

test('uploads real multipart fields and file bytes', async () => {
  const fake = backend(async (url, init) => {
    assert.equal(init.headers['Content-Type'], undefined);
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('completionNote'), '已完成');
    const file = init.body.get('files');
    assert.equal(file.name, '说明.txt');
    assert.equal(await file.text(), '活动说明');
    return json({ todo: { status: 'done' } });
  });
  await new AnonClient(config(), fake.fetcher).call(operation('anon_post_todos_todo_id_complete'), {
    path: { todoId: 'todo1' },
    body: { completionNote: '已完成', files: [{ filename: '说明.txt', mimeType: 'text/plain', base64: Buffer.from('活动说明').toString('base64') }] },
  });
});

test('multipart supports file-only material uploads and scalar stage fields', async () => {
  const fake = backend((url, init) => {
    if (url.pathname.endsWith('/versions')) assert.equal(init.body.get('file').name, 'poster.png');
    else {
      assert.equal(init.body.get('durationMin'), '5');
      assert.equal(init.body.get('participants'), '[{"cn":"演出者"}]');
    }
    return json({ ok: true }, 201);
  });
  const client = new AnonClient(config(), fake.fetcher);
  await client.call(operation('anon_post_materials_resource_id_versions'), {
    path: { resourceId: 'material1' }, body: { file: { filename: 'poster.png', base64: 'aGk=' } },
  });
  await client.call(operation('anon_post_stage_rundowns_rid_items'), {
    path: { rid: 'rundown1' }, body: { name: '开场', durationMin: 5, participants: '[{"cn":"演出者"}]' },
  });
});

test('accepts large canonical base64 attachments without regex stack limits', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  const fake = backend(async (_url, init) => {
    assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), bytes);
    return json({ ok: true }, 201);
  });
  await new AnonClient(config(), fake.fetcher).call(operation('anon_post_files'), {
    body: { file: { filename: 'large.bin', base64: bytes.toString('base64') } },
  });
});

test('rejects malformed base64 and oversized file uploads before sending a write', async () => {
  const fake = backend(() => assert.fail('Must not send invalid upload'));
  const client = new AnonClient(config(), fake.fetcher);
  for (const base64 of ['data:image/png;base64,aGk=', 'not-base64!', 'a'.repeat(28 * 1024 * 1024)]) {
    await assert.rejects(client.call(operation('anon_post_files'), {
      body: { file: { filename: 'file', base64 } },
    }), { code: 'invalid_arguments' });
  }
});

test('blocks mismatched project and read-only writes', async () => {
  const fake = backend(() => assert.fail('Must not call project endpoint'));
  await assert.rejects(new AnonClient(config({ ANON_PROJECT_ID: 'c'.repeat(24) }), fake.fetcher)
    .call(operation('anon_get_todos'), {}), { code: 'api_key_wrong_project' });
  await assert.rejects(new AnonClient(config({ ANON_READ_ONLY: 'true' }), fake.fetcher)
    .call(operation('anon_post_todos'), { body: { title: 'test' } }), { code: 'read_only' });
});

test('encodes entity IDs without allowing query injection or dot traversal', async () => {
  const fake = backend((url) => {
    assert.equal(url.pathname, `/api/projects/${project}/todos/a%2Fb%3Fstatus%3Ddone`);
    assert.equal(url.search, '');
    return json({ ok: true });
  });
  const client = new AnonClient(config(), fake.fetcher);
  await client.call(operation('anon_patch_todos_todo_id'), { path: { todoId: 'a/b?status=done' }, body: {} });
  await assert.rejects(client.call(operation('anon_patch_todos_todo_id'), { path: { todoId: '..' }, body: {} }), { code: 'invalid_arguments' });
});

for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'internal']]) {
  test(`preserves HTTP ${status} and ANON error code without retrying`, async () => {
    const fake = backend(() => json({ error: { code, message: '后端错误' } }, status));
    const client = new AnonClient(config(), fake.fetcher);
    await assert.rejects(client.call(operation('anon_post_todos'), { body: { title: 'test' } }), error =>
      error instanceof AnonError && error.status === status && error.code === code && error.message.includes('后端错误'));
    assert.equal(fake.requests.length, 2);
  });
}

test('failed identity lookup is not cached', async () => {
  let count = 0;
  const client = new AnonClient(config(), async url => {
    if (url.endsWith('/api/open/me')) return ++count === 1 ? json({ error: { code: 'unauthorized' } }, 401) : identity();
    return json({ todos: [] });
  });
  await assert.rejects(client.call(operation('anon_get_todos'), {}), { code: 'unauthorized' });
  assert.equal((await client.call(operation('anon_get_todos'), {})).status, 200);
});

test('returns CSV and file bytes using their actual content type', async () => {
  const fake = backend(url => url.pathname.endsWith('/export') ?
    new Response('姓名,金额\n小明,10', { headers: { 'content-type': 'text/csv; charset=utf-8' } }) :
    new Response('%PDF-file', { headers: { 'content-type': 'application/pdf' } }));
  const client = new AnonClient(config(), fake.fetcher);
  const csv = await client.call(operation('anon_get_finance_export'), { query: { userId: 'member' } });
  assert.equal(csv.contentType, 'text/csv');
  assert.match(csv.text, /小明/);
  const file = await client.call(operation('anon_get_materials_resource_id_versions_version_download'), {
    path: { resourceId: 'material1', version: '1' },
  });
  assert.equal(file.contentType, 'application/pdf');
  assert.equal(Buffer.from(file.base64, 'base64').toString(), '%PDF-file');
});

test('redacts API keys from upstream errors and JSON results', async () => {
  const fake = backend(() => json({ error: { code: 'bad_request', message: `unexpected ${key}` } }, 400));
  await assert.rejects(new AnonClient(config(), fake.fetcher).call(operation('anon_get_todos'), {}), error =>
    !error.message.includes(key) && error.message.includes('[REDACTED_API_KEY]'));
});

test('handles HTML errors and malformed JSON without exposing response bodies', async () => {
  for (const response of [
    new Response('<html>proxy secret</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    new Response('broken JSON', { headers: { 'content-type': 'application/json' } }),
  ]) {
    const fake = backend(() => response);
    await assert.rejects(new AnonClient(config(), fake.fetcher).call(operation('anon_get_todos'), {}), error =>
      ['http_502', 'invalid_response'].includes(error.code) && !error.message.includes('proxy secret'));
  }
});

test('bounds response size and JSON request size', async () => {
  const fake = backend(() => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  const client = new AnonClient(config(), fake.fetcher);
  await assert.rejects(client.call(operation('anon_get_todos'), {}), { code: 'response_too_large' });
  await assert.rejects(client.call(operation('anon_post_todos'), { body: { title: 'a'.repeat(2 * 1024 * 1024) } }), { code: 'request_too_large' });
});

test('maps connection failures, timeout and cancellation without leaking underlying errors', async () => {
  const offline = new AnonClient(config(), async () => { throw new Error(`connection failed ${key}`); });
  await assert.rejects(offline.identity(), error => error.code === 'connection_failed' && !error.message.includes(key));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(offline.identity(controller.signal), { code: 'request_cancelled' });
  const timed = new AnonClient(config({ ANON_TIMEOUT_MS: '100' }), async (_url, init) => {
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      // AbortSignal.timeout is unref'd; keep this isolated test's event loop live.
      const timer = setTimeout(() => {}, 150);
      init.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
    return identity();
  });
  await assert.rejects(timed.identity(), { code: 'request_timeout' });
});
