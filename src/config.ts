import type { Config } from './types.js';

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let base: URL;
  try {
    base = new URL(env.ANON_BASE_URL ?? 'http://localhost:4000');
  } catch {
    throw new Error('ANON_BASE_URL 必须是有效的 HTTP(S) 源地址');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || !['/', '/api', '/api/'].includes(base.pathname)) {
    throw new Error('ANON_BASE_URL 只能包含 HTTP(S) 源地址（可带 /api），不能包含凭证、查询或 fragment');
  }
  const apiKey = env.ANON_API_KEY?.trim() ?? '';
  if (!/^anonk_[a-f0-9]{64}$/.test(apiKey)) {
    throw new Error('请配置 ANON_API_KEY：在 ANON「我的 → API 密钥」生成 anonk_ 密钥');
  }
  const readOnly = env.ANON_READ_ONLY ?? 'false';
  if (!['true', 'false'].includes(readOnly)) {
    throw new Error('ANON_READ_ONLY 必须是 true 或 false');
  }
  const timeoutMs = Number(env.ANON_TIMEOUT_MS ?? '30000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
    throw new Error('ANON_TIMEOUT_MS 必须是 100–300000 之间的整数');
  }
  const projectId = env.ANON_PROJECT_ID?.trim() || undefined;
  if (projectId && !/^[a-fA-F0-9]{24}$/.test(projectId)) {
    throw new Error('ANON_PROJECT_ID 必须是 24 位十六进制项目 ID');
  }
  return {
    baseUrl: base.origin,
    apiKey,
    projectId,
    modules: [...new Set((env.ANON_MODULES ?? '').split(',').map(s => s.trim()).filter(Boolean))],
    readOnly: readOnly === 'true',
    timeoutMs,
  };
}
