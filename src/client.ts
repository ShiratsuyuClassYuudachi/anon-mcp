import type { Config, Operation, Schema } from './types.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export class AnonError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
  }
}

function redact(text: string): string {
  return text.replace(/anonk_[a-f0-9]{64}/gi, '[REDACTED_API_KEY]');
}

function encodeSegment(value: unknown): string {
  const segment = String(value);
  if (!segment || segment === '.' || segment === '..' || /[\x00-\x1f\x7f]/.test(segment)) {
    throw new AnonError('invalid_arguments', '路径参数不能为空、点路径或包含控制字符');
  }
  return encodeURIComponent(segment);
}

function appendFile(form: FormData, key: string, file: Record<string, string>) {
  const base64 = file.base64;
  if (base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || base64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(base64)) {
    throw new AnonError('invalid_arguments', '附件必须为标准 Base64，解码后不超过 20 MiB');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== base64) {
    throw new AnonError('invalid_arguments', '附件 Base64 无效或超过 20 MiB');
  }
  if (/[\r\n\x00]/.test(file.filename)) throw new AnonError('invalid_arguments', '文件名包含无效字符');
  form.append(key, new Blob([Uint8Array.from(bytes)], { type: file.mimeType || 'application/octet-stream' }), file.filename);
}

export function multipartBody(body: Record<string, any>, schema: Schema): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    const property = schema.properties?.[key];
    if (property?.format === 'binary') appendFile(form, key, value);
    else if (property?.items?.format === 'binary') {
      if (value.length > 10) throw new AnonError('invalid_arguments', '每次最多上传 10 个附件');
      for (const file of value) appendFile(form, key, file);
    } else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

async function boundedBytes(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AnonError('response_too_large', '响应超过 8 MiB，请缩小查询范围或通过 ANON 页面下载文件');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export class AnonClient {
  private project?: string;

  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}

  async identity(signal?: AbortSignal): Promise<Record<string, any>> {
    const result = await this.request('/api/open/me', 'GET', undefined, undefined, signal);
    const data = result.data as Record<string, any>;
    if (!data?.project?.id || !/^[a-fA-F0-9]{24}$/.test(data.project.id)) {
      throw new AnonError('invalid_response', '身份接口没有返回有效的项目 ID');
    }
    if (this.config.projectId && data.project.id.toLowerCase() !== this.config.projectId.toLowerCase()) {
      throw new AnonError('api_key_wrong_project', 'ANON_PROJECT_ID 与当前密钥绑定的项目不一致', 403);
    }
    return data;
  }

  private async projectId(signal?: AbortSignal): Promise<string> {
    if (!this.project) {
      // Cache only the immutable project binding, never permissions. Each caller
      // owns its cancellation signal; an initial request cannot cancel a peer.
      this.project = (await this.identity(signal)).project.id as string;
    }
    return this.project;
  }

  async call(operation: Operation, args: Record<string, any>, signal?: AbortSignal): Promise<Record<string, any>> {
    if (this.config.readOnly && operation.method !== 'GET') {
      throw new AnonError('read_only', 'ANON_READ_ONLY=true，写操作已禁用');
    }
    if (operation.path === '/api/open/me') return { status: 200, data: await this.identity(signal) };
    const projectId = operation.path.startsWith('/api/projects/{id}') ? await this.projectId(signal) : undefined;
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const value = key === 'id' ? projectId : args.path?.[key];
      if (value === undefined) throw new AnonError('invalid_arguments', `缺少路径参数 ${key}`);
      return encodeSegment(value);
    });
    const query = new URLSearchParams();
    for (const parameter of operation.queryParameters) {
      const value = args.query?.[parameter.name];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (parameter.explode === false) query.set(parameter.name, value.map(String).join(','));
        else value.forEach(item => query.append(parameter.name, String(item)));
      } else query.set(parameter.name, String(value));
    }
    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (args.body !== undefined) {
      if (operation.bodyType === 'multipart/form-data') {
        body = multipartBody(args.body, operation.multipartSchema!);
      } else {
        body = JSON.stringify(args.body);
        if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new AnonError('request_too_large', 'JSON 请求体不能超过 2 MiB');
        contentType = 'application/json';
      }
    }
    return this.request(path + (query.size ? `?${query}` : ''), operation.method, body, contentType, signal);
  }

  private async request(path: string, method: string, body?: BodyInit, contentType?: string,
    cancellation?: AbortSignal): Promise<Record<string, any>> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
    try {
      const response = await this.fetcher(`${this.config.baseUrl}${path}`, {
        method, body, signal,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'application/json, text/csv, image/*, application/octet-stream',
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
      });
      const bytes = await boundedBytes(response);
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      let data: unknown;
      if (type === 'application/json' || type.endsWith('+json')) {
        try { data = JSON.parse(redact(bytes.toString('utf8')) || 'null'); }
        catch { throw new AnonError('invalid_response', 'ANON 返回了无效的 JSON', response.status); }
      }
      if (!response.ok) {
        const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
        const hints: Record<number, string> = {
          401: '密钥可能已过期或撤销，请在 ANON「我的 → API 密钥」重新生成并更新配置。',
          403: '请检查密钥所属项目、scope 和当前角色权限。',
          429: '请求被限流，请稍后再试；写操作不会自动重试。',
        };
        throw new AnonError(typeof error?.code === 'string' ? error.code : `http_${response.status}`,
          [typeof error?.message === 'string' ? error.message.slice(0, 1000) : `ANON 请求失败（HTTP ${response.status}）`,
            hints[response.status]].filter(Boolean).join(' '), response.status);
      }
      if (data !== undefined) return { status: response.status, data };
      if (!bytes.length) return { status: response.status, data: null };
      if (type.startsWith('text/') && type !== 'text/html') {
        return { status: response.status, contentType: type, text: redact(bytes.toString('utf8')) };
      }
      // Project download/preview endpoints use the stored file's actual MIME
      // type, which can be PDF/audio/video rather than application/octet-stream.
      if (type && type !== 'text/html') {
        return { status: response.status, contentType: type, base64: bytes.toString('base64') };
      }
      throw new AnonError('invalid_response', `ANON 返回了不支持的响应类型：${type || '(无 Content-Type)'}`, response.status);
    } catch (error) {
      if (error instanceof AnonError) throw error;
      if (cancellation?.aborted) throw new AnonError('request_cancelled', '调用已取消；已提交的写操作请在 ANON 中核实结果');
      if (timeout.aborted) throw new AnonError('request_timeout', 'ANON 请求超时；已提交的写操作请核实结果后再决定是否重试');
      throw new AnonError('connection_failed', '无法连接 ANON，请检查 ANON_BASE_URL、网络和服务状态（不跟随 HTTP 重定向）');
    }
  }
}
