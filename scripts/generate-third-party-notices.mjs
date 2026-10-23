#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');
const pnpmCli = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const packages = new Map();

const result = spawnSync(
  process.execPath,
  [pnpmCli, '-C', 'engine', 'licenses', 'list', '--prod', '--json'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (result.error !== undefined) fail(`could not start pnpm: ${result.error.message}`);
if (result.status !== 0) {
  fail(`pnpm licenses failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  fail(`pnpm returned invalid license JSON: ${String(error)}`);
}

for (const [reportedLicense, entries] of Object.entries(report)) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    const entryPaths = Array.isArray(entry.paths) ? entry.paths : [];
    let foundManifest = false;
    for (const packagePath of entryPaths) {
      const manifestPath = path.join(packagePath, 'package.json');
      if (!existsSync(manifestPath)) continue;
      foundManifest = true;
      addPackage(packagePath, reportedLicense, entry);
    }
    if (!foundManifest) {
      for (const version of entry.versions ?? ['unknown']) {
        mergePackage({
          name: String(entry.name ?? 'unknown'),
          version: String(version),
          license: String(entry.license ?? reportedLicense),
          author: authorText(entry.author),
          homepage: String(entry.homepage ?? ''),
          notices: [],
        });
      }
    }
  }
}

for (const relativePath of [
  'node_modules/electron',
  'node_modules/@fontsource-variable/cormorant-garamond',
  'node_modules/@fontsource-variable/noto-serif-sc',
]) {
  const packagePath = path.join(root, relativePath);
  if (existsSync(path.join(packagePath, 'package.json'))) {
    addPackage(packagePath, undefined, {});
  }
}

mergePackage({
  name: 'Kimi Code (vendored engine)',
  version: 'c9f01f0',
  license: 'MIT',
  author: 'Moonshot AI',
  homepage: 'https://github.com/MoonshotAI/kimi-code',
  notices: [readNotice(path.join(root, 'engine', 'LICENSE'))],
});

mergePackage({
  name: 'OpenAqua (external backend compatibility target and brand assets)',
  version: '0e39908',
  license: 'MIT',
  author: 'ElijahMoulton and OpenAqua contributors',
  homepage: 'https://github.com/zhaorui-bi/OpenAqua',
  notices: [readNotice(path.join(root, 'OPENAQUA_UPSTREAM_LICENSE'))],
});

const content = renderNotices([...packages.values()]);
if (checkOnly) {
  const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (committed !== content) {
    fail(
      `THIRD_PARTY_NOTICES.md is stale; run \`npm run licenses\` and commit the result. ${firstDifference(committed, content)}`,
    );
  }
  process.stdout.write(
    `third-party notices: current (${String(packages.size)} packages)\n`,
  );
} else {
  writeFileSync(outputPath, content, 'utf8');
  process.stdout.write(
    `third-party notices: wrote ${path.relative(root, outputPath)} (${String(packages.size)} packages)\n`,
  );
}

function addPackage(packagePath, reportedLicense, fallback) {
  const manifest = JSON.parse(readFileSync(path.join(packagePath, 'package.json'), 'utf8'));
  const notices = [];
  for (const entry of readdirSync(packagePath, { withFileTypes: true })) {
    if (!entry.isFile() || !isNoticeFile(entry.name)) continue;
    const noticePath = path.join(packagePath, entry.name);
    if (statSync(noticePath).size > 2 * 1024 * 1024) continue;
    notices.push(readNotice(noticePath));
  }
  const declaredLicense = licenseText(manifest.license ?? manifest.licenses);
  mergePackage({
    name: String(manifest.name ?? fallback.name ?? path.basename(packagePath)),
    version: String(manifest.version ?? fallback.versions?.[0] ?? 'unknown'),
    license:
      declaredLicense ||
      inferLicenseFromNotices(notices) ||
      licenseText(fallback.license ?? reportedLicense),
    author: authorText(manifest.author ?? fallback.author),
    homepage: homepageText(manifest),
    notices,
  });
}

function mergePackage(record) {
  const key = `${record.name}@${record.version}`;
  const existing = packages.get(key);
  if (existing === undefined) {
    packages.set(key, {
      ...record,
      notices: uniqueNotices(record.notices),
    });
    return;
  }
  existing.notices = uniqueNotices([...existing.notices, ...record.notices]);
  if (existing.license === '' && record.license !== '') existing.license = record.license;
  if (existing.author === '' && record.author !== '') existing.author = record.author;
  if (existing.homepage === '' && record.homepage !== '') existing.homepage = record.homepage;
}

function renderNotices(records) {
  records.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName || left.version.localeCompare(right.version);
  });

  const noticeGroups = new Map();
  const withoutNotice = [];
  for (const record of records) {
    if (record.notices.length === 0) withoutNotice.push(`${record.name}@${record.version}`);
    for (const notice of record.notices) {
      const hash = createHash('sha256').update(notice).digest('hex');
      const group = noticeGroups.get(hash) ?? { text: notice, packages: [] };
      group.packages.push(`${record.name}@${record.version}`);
      noticeGroups.set(hash, group);
    }
  }

  const lines = [
    '<!-- Generated by scripts/generate-third-party-notices.mjs. Do not edit manually. -->',
    '',
    '# Third-party notices',
    '',
    'OpenAqua Harness bundles the open-source Kimi Code engine, OpenAqua-derived brand assets,',
    'its production dependency graph, Electron, and self-hosted fonts. This file records package metadata and license or notice',
    'texts available in the installed dependency trees at build time.',
    '',
    'Electron’s complete Chromium attribution file is shipped beside this document as',
    '`ELECTRON_THIRD_PARTY_NOTICES.html`. Font license files are also retained beside the Web UI',
    'font assets. An entry in this inventory does not imply endorsement by its authors.',
    '',
    '## Package inventory',
    '',
    '| Package | Version | License | Author | Homepage |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const record of records) {
    lines.push(
      `| ${cell(record.name)} | ${cell(record.version)} | ${cell(record.license || 'UNKNOWN')} | ${cell(record.author)} | ${cell(record.homepage)} |`,
    );
  }

  lines.push('', '## License and notice texts', '');
  const groups = [...noticeGroups.entries()].sort((left, right) => {
    const leftName = [...left[1].packages].sort()[0] ?? '';
    const rightName = [...right[1].packages].sort()[0] ?? '';
    return leftName.localeCompare(rightName) || left[0].localeCompare(right[0]);
  });
  for (const [hash, group] of groups) {
    group.packages.sort();
    lines.push(
      `<details><summary>${html(group.packages.join(', '))} — ${hash.slice(0, 12)}</summary>`,
      '',
      '<pre>',
      html(group.text),
      '</pre>',
      '',
      '</details>',
      '',
    );
  }

  if (withoutNotice.length > 0) {
    lines.push(
      '## Packages without a bundled root notice file',
      '',
      'The following installed packages declared a license expression but did not expose a small',
      'root-level LICENSE, LICENCE, COPYING, or NOTICE file. Their declared license and homepage',
      'remain recorded in the inventory above.',
      '',
    );
    withoutNotice.sort();
    for (const packageName of withoutNotice) lines.push(`- ${packageName}`);
    lines.push('');
  }

  return `${lines.join('\n').replaceAll(/[ \t]+$/gm, '').trimEnd()}\n`;
}

function firstDifference(committed, generated) {
  const committedLines = committed.split('\n');
  const generatedLines = generated.split('\n');
  const sharedLength = Math.min(committedLines.length, generatedLines.length);
  let index = 0;
  while (index < sharedLength && committedLines[index] === generatedLines[index]) index++;
  const committedLine = committedLines[index] ?? '<end of file>';
  const generatedLine = generatedLines[index] ?? '<end of file>';
  return `First difference at line ${String(index + 1)}; committed=${JSON.stringify(committedLine.slice(0, 300))}; generated=${JSON.stringify(generatedLine.slice(0, 300))}`;
}

function uniqueNotices(notices) {
  return [...new Set(notices.filter((notice) => notice !== ''))];
}

function readNotice(filePath) {
  return readFileSync(filePath, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll(/[ \t]+$/gm, '')
    .trim();
}

function isNoticeFile(name) {
  return /^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(name);
}

function inferLicenseFromNotices(notices) {
  for (const notice of notices) {
    if (
      /Permission is hereby granted,\s+free of charge,\s+to any person obtaining a\s+copy/.test(
        notice,
      ) &&
      notice.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')
    ) {
      return 'MIT';
    }
  }
  return '';
}

function licenseText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(licenseText).filter(Boolean).join(' OR ');
  if (typeof value === 'object') {
    return String(value.type ?? value.name ?? JSON.stringify(value));
  }
  return String(value);
}

function authorText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return String(value.name ?? value.email ?? JSON.stringify(value));
  }
  return String(value);
}

function homepageText(manifest) {
  if (typeof manifest.homepage === 'string') return manifest.homepage;
  if (typeof manifest.repository === 'string') return manifest.repository;
  if (typeof manifest.repository?.url === 'string') return manifest.repository.url;
  return '';
}

function cell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function html(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function fail(message) {
  process.stderr.write(`third-party notices: ${message}\n`);
  process.exit(1);
}
