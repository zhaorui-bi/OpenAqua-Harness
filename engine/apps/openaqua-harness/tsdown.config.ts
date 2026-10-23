import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  entry: {
    cli: './src/cli.ts',
    'mcp-server': './src/mcp/server.ts',
    'job-runner': './src/openaqua/job-runner.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  hash: false,
  define: {
    __OPENAQUA_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rawTextPlugin()],
  deps: {
    onlyBundle: false,
  },
  outputOptions: {
    entryFileNames: '[name].mjs',
  },
});
