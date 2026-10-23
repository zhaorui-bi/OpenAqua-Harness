#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
const rootPackage = readJson('package.json');
const packageLock = readJson('package-lock.json');
const harnessPackage = readJson('engine/apps/openaqua-harness/package.json');

check(rootPackage.private === true, 'root package must remain private');
check(
  rootPackage.name === 'openaqua-harness',
  `unexpected root package name: ${rootPackage.name}`,
);
check(
  harnessPackage.name === rootPackage.name,
  `package name mismatch: root=${rootPackage.name}, harness=${harnessPackage.name}`,
);
check(
  /^\d+\.\d+\.\d+-beta\.\d+$/.test(rootPackage.version ?? ''),
  `current OpenAqua Harness release must remain a numbered beta SemVer: ${String(rootPackage.version)}`,
);
check(rootPackage.engines?.node === '>=24.15.0', 'Node.js engine floor changed unexpectedly');
check(
  rootPackage.version === harnessPackage.version,
  `package version mismatch: root=${rootPackage.version}, harness=${harnessPackage.version}`,
);
check(
  rootPackage.version === packageLock.version,
  `package-lock version mismatch: root=${rootPackage.version}, lock=${packageLock.version}`,
);
check(
  rootPackage.version === packageLock.packages?.['']?.version,
  `package-lock root entry mismatch: root=${rootPackage.version}, ` +
    `lock root=${String(packageLock.packages?.['']?.version)}`,
);

const citation = readFileSync(path.join(root, 'CITATION.cff'), 'utf8');
const citationVersion = /^version:\s*['"]?([^'"\s]+)['"]?$/m.exec(citation)?.[1];
const citationDate = /^date-released:\s*['"]?([^'"\s]+)['"]?$/m.exec(citation)?.[1];
check(
  citationVersion === harnessPackage.version,
  `citation version mismatch: citation=${String(citationVersion)}, harness=${harnessPackage.version}`,
);
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
check(
  changelog.includes(`## [${harnessPackage.version}] - ${String(citationDate)}`),
  `CHANGELOG.md release heading must match version ${harnessPackage.version} and citation date ${String(citationDate)}`,
);
for (const relativePath of [
  'README.md',
  'README.zh-CN.md',
  'engine/apps/openaqua-harness/README.md',
]) {
  check(
    readFileSync(path.join(root, relativePath), 'utf8').includes(harnessPackage.version),
    `${relativePath} does not identify the current beta version ${harnessPackage.version}`,
  );
}
const adapter = readFileSync(
  path.join(root, 'engine/apps/openaqua-harness/backend/openaqua_cli.py'),
  'utf8',
);
const adapterVersion = /^ADAPTER_VERSION\s*=\s*["']([^"']+)["']$/m.exec(adapter)?.[1];
check(
  adapterVersion === harnessPackage.version,
  `adapter version mismatch: adapter=${String(adapterVersion)}, harness=${harnessPackage.version}`,
);

const requiredFiles = [
  'CHANGELOG.md',
  'CITATION.cff',
  'CONTRIBUTING.md',
  'LICENSE',
  'OPENAQUA_UPSTREAM_LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'SBOM.spdx.json',
  'build/logo.png',
  'build/logo-256.png',
  'build/icon.ico',
  'scripts/check-adapter.mjs',
  'engine/apps/openaqua-harness/backend/openaqua_cli.py',
  'engine/apps/openaqua-harness/test-python/test_openaqua_cli.py',
  'docs/RELEASE.md',
  'docs/SCIENTIFIC_WORKFLOWS.md',
];
for (const relativePath of requiredFiles) {
  check(existsSync(path.join(root, relativePath)), `required file missing: ${relativePath}`);
}

const ignoreRules = new Set(
  readFileSync(path.join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#')),
);
for (const rule of [
  '/.openaqua/',
  '/.kimi-code/',
  '/openaqua-data/',
  '/kimi-data/',
  '**/openaqua-jobs/',
  '/mcp.json',
  '/server.token',
]) {
  check(ignoreRules.has(rule), `.gitignore must exclude sensitive runtime path: ${rule}`);
}

const markdownFiles = [
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...markdownFilesUnder('docs'),
  'engine/apps/openaqua-harness/README.md',
  ...markdownFilesUnder('engine/apps/openaqua-harness/skills'),
  'engine/apps/openaqua-harness/theme/RESEARCH.md',
].sort();
for (const relativePath of markdownFiles) validateMarkdown(relativePath);

const skillsRoot = path.join(root, 'engine/apps/openaqua-harness/skills');
const skillNames = [];
for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const relativePath = path.join(
    'engine/apps/openaqua-harness/skills',
    entry.name,
    'SKILL.md',
  );
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) continue;
  const text = readFileSync(absolutePath, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  const name = /^name:\s*(.+)$/m.exec(frontmatter ?? '')?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(frontmatter ?? '')?.[1]?.trim();
  check(name !== undefined && name !== '', `${relativePath}: missing skill name`);
  check(
    description !== undefined && description !== '',
    `${relativePath}: missing skill description`,
  );
  if (name !== undefined) skillNames.push(name);
}
check(skillNames.includes('openaqua'), 'openaqua skill is missing');
check(skillNames.includes('openaqua-campaign'), 'openaqua-campaign skill is missing');
check(new Set(skillNames).size === skillNames.length, 'skill names must be unique');

for (const resource of rootPackage.build?.extraResources ?? []) {
  const source = path.join(root, resource.from);
  check(existsSync(source), `packaged resource source missing: ${resource.from}`);
}
check(
  existsSync(path.join(root, 'engine/apps/openaqua-harness/dist/search-worker.mjs')),
  'built global-search worker is missing; run npm run build:engine',
);
for (const destination of [
  'licenses/OPENAQUA_HARNESS_LICENSE',
  'licenses/KIMI_CODE_LICENSE',
  'licenses/OPENAQUA_UPSTREAM_LICENSE',
  'licenses/THIRD_PARTY_NOTICES.md',
  'licenses/SBOM.spdx.json',
  'licenses/ELECTRON_LICENSE',
  'licenses/ELECTRON_THIRD_PARTY_NOTICES.html',
]) {
  check(
    (rootPackage.build?.extraResources ?? []).some((resource) => resource.to === destination),
    `packaged license resource missing: ${destination}`,
  );
}

const generatedMark = path.join(
  root,
  'engine/apps/openaqua-harness/web-ui/openaqua-logo.png',
);
if (existsSync(generatedMark)) {
  check(
    sha256(generatedMark) === sha256(path.join(root, 'build/logo-256.png')),
    'generated Web UI mark differs from build/logo-256.png',
  );
}

validateTrackedFiles();

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`repository check: ${error}\n`);
  process.exit(1);
}
process.stdout.write(
  `repository check: ok (${String(skillNames.length)} skills, ${String(markdownFiles.length)} Markdown files)\n`,
);

function markdownFilesUnder(relativeDirectory) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(path.join(root, directory), {
      withFileTypes: true,
    })) {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relativePath);
    }
  };
  visit(relativeDirectory);
  return found;
}

function validateMarkdown(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const text = readFileSync(absolutePath, 'utf8');
  check(text.split('```').length % 2 === 1, `${relativePath}: unbalanced code fences`);
  const links = text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    const target = match[1];
    if (
      target.startsWith('#') ||
      target.startsWith('mailto:') ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
    ) {
      continue;
    }
    const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
    if (withoutFragment === '') continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      errors.push(`${relativePath}: invalid URL encoding in ${target}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(absolutePath), decoded);
    check(existsSync(resolved), `${relativePath}: broken local link ${target}`);
  }
}

function validateTrackedFiles() {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    check(process.env['CI'] !== 'true', 'repository root is not a Git worktree');
    return;
  }
  const runtimeDirectory =
    /(^|\/)(?:\.openaqua|\.kimi-code|openaqua-data|kimi-data|openaqua-jobs)(?:\/|$)/;
  const rootSecret = /^(?:\.env(?:\.|$)|mcp\.json$|server\.token$|run\.log$)/;
  for (const tracked of result.stdout.split('\0').filter(Boolean)) {
    check(
      !runtimeDirectory.test(tracked) && !rootSecret.test(tracked),
      `sensitive runtime path is tracked: ${tracked}`,
    );
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function check(condition, message) {
  if (!condition) errors.push(message);
}
