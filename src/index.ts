#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer(readConfig());
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  // stdout is reserved for MCP JSON-RPC. Never log environment values or requests.
  console.error(error instanceof Error ? error.message : 'ANON MCP 启动失败');
  process.exitCode = 1;
});
