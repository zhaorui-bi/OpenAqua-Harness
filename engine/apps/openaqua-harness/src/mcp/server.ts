import path from 'node:path';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { packageVersion, resolveOpenAquaHome, resolveUserPath } from '../paths';
import {
  openAquaToolAnnotations,
  OPENAQUA_TOOLS,
  type ToolContext,
} from '../openaqua/tools';

const homeDir = resolveOpenAquaHome();
const jobsRoot = resolveUserPath(
  process.env['OPENAQUA_JOBS_DIR'] ?? path.join(process.cwd(), 'openaqua-jobs'),
);

const ctx: ToolContext = {
  homeDir,
  jobsRoot,
  env: process.env,
};

const server = new McpServer({
  name: 'openaqua',
  version: packageVersion(),
});

for (const tool of OPENAQUA_TOOLS) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: openAquaToolAnnotations(tool.name),
    },
    async (args) => tool.run(args as Record<string, unknown>, ctx),
  );
}

await server.connect(new StdioServerTransport());
