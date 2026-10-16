import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type Schema = Record<string, any>;

export interface Operation {
  tool: Tool;
  module: string;
  method: string;
  path: string;
  bodyType?: 'application/json' | 'multipart/form-data';
  multipartSchema?: Schema;
  queryParameters: { name: string; explode?: boolean }[];
}

export interface Config {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  modules: string[];
  readOnly: boolean;
  timeoutMs: number;
}
