import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { compileCatalog } from '../dist/catalog.js';

const check = process.argv.includes('--check');
const sourceArgument = process.argv.slice(2).find(arg => arg !== '--check');
const source = sourceArgument ? resolve(sourceArgument) : new URL('../../anon/docs/openapi.yaml', import.meta.url);
const snapshot = new URL('../resources/anon-openapi.yaml', import.meta.url);
const documentation = new URL('../docs/tools.md', import.meta.url);

try {
  const content = await readFile(source, 'utf8');
  const operations = compileCatalog(parse(content));
  const hash = createHash('sha256').update(content).digest('hex');
  const rows = operations.map(({ tool, module, method, path }) =>
    `| \`${tool.name}\` | ${module} | ${method} | \`${path}\` |`);
  const doc = `# 工具目录\n\n` +
    '由 `scripts/sync-api.mjs` 从 ANON 的 `docs/openapi.yaml` 生成。请勿手工编辑。\n\n' +
    `规范 SHA-256：\`${hash}\`\n\n` +
    `共 ${operations.length} 个工具。项目参数 ` + '`{id}` 由密钥身份自动确定。\n\n' +
    `仅包含健康检查、密钥身份自查及项目域接口；排除密码查看与自定义工具启动令牌签发。\n\n` +
    `| 工具名 | 模块 | 方法 | HTTP 路径 |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  const markdown = doc;
  if (check) {
    if (await readFile(snapshot, 'utf8') !== content || await readFile(documentation, 'utf8') !== markdown) {
      throw new Error('API 快照或工具目录已过期，请运行 npm run sync:api');
    }
    console.log(`API 快照与工具目录一致（${operations.length} 个工具）`);
  } else {
    await mkdir(new URL('../resources/', import.meta.url), { recursive: true });
    await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
    await writeFile(snapshot, content);
    await writeFile(documentation, markdown);
    console.log(`已同步 API 快照与工具目录（${operations.length} 个工具）`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'API 同步失败');
  process.exitCode = 1;
}
