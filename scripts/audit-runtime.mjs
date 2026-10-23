#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCli = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const result = spawnSync(
  process.execPath,
  [pnpmCli, '-C', 'engine', 'audit', '--prod', '--json'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

if (result.error !== undefined) {
  fail(`could not start pnpm: ${result.error.message}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
  fail(`pnpm returned an unreadable audit report: ${detail}`);
}

if (report.error !== undefined) {
  const detail =
    typeof report.error === 'string' ? report.error : JSON.stringify(report.error);
  fail(`pnpm audit failed: ${detail}`);
}
if (result.status !== 0 && result.status !== 1) {
  fail(`pnpm audit exited with status ${String(result.status)}: ${result.stderr.trim()}`);
}

// These workspaces are upstream development/documentation surfaces and are not
// built into the OpenAqua CLI, Web UI, MCP server, or desktop application.
const nonShippedRoots = new Set(['apps__vscode', 'docs']);
const runtimeAdvisories = new Map();
const excludedAdvisories = new Set();

for (const [id, advisory] of Object.entries(report.advisories ?? {})) {
  const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
  const runtimePaths = paths.filter((dependencyPath) => {
    const workspaceRoot = dependencyPath.split('>', 1)[0];
    return !nonShippedRoots.has(workspaceRoot);
  });
  if (runtimePaths.length === 0) {
    if (paths.length > 0) excludedAdvisories.add(id);
    continue;
  }
  runtimeAdvisories.set(id, { advisory, paths: [...new Set(runtimePaths)] });
}

if (runtimeAdvisories.size > 0) {
  process.stderr.write(
    `runtime dependency audit: ${String(runtimeAdvisories.size)} vulnerable advisories found\n`,
  );
  const severityOrder = new Map([
    ['critical', 0],
    ['high', 1],
    ['moderate', 2],
    ['low', 3],
    ['info', 4],
  ]);
  const findings = [...runtimeAdvisories.values()].sort((left, right) => {
    const severityDifference =
      (severityOrder.get(left.advisory.severity) ?? 5) -
      (severityOrder.get(right.advisory.severity) ?? 5);
    return (
      severityDifference ||
      String(left.advisory.module_name).localeCompare(String(right.advisory.module_name))
    );
  });
  for (const { advisory, paths } of findings) {
    process.stderr.write(
      `${advisory.severity}: ${advisory.module_name} — ${advisory.title}\n`,
    );
    for (const dependencyPath of paths) process.stderr.write(`  ${dependencyPath}\n`);
  }
  process.exit(1);
}

const dependencyCount = report.metadata?.dependencies;
const dependencySummary =
  typeof dependencyCount === 'number'
    ? `${String(dependencyCount)} production dependencies checked`
    : 'production dependencies checked';
const excludedSummary =
  excludedAdvisories.size === 0
    ? 'no excluded findings'
    : `${String(excludedAdvisories.size)} advisories confined to non-shipped docs/VS Code workspaces`;
process.stdout.write(`runtime dependency audit: ok (${dependencySummary}; ${excludedSummary})\n`);

function fail(message) {
  process.stderr.write(`runtime dependency audit: ${message}\n`);
  process.exit(1);
}
