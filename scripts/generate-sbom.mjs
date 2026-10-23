#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'SBOM.spdx.json');
const checkOnly = process.argv.includes('--check');
const rootPackage = readJson(path.join(root, 'package.json'));
const pnpmManifest = readJson(path.join(root, 'node_modules', 'pnpm', 'package.json'));
const pnpmCli = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');

const result = spawnSync(
  process.execPath,
  [
    pnpmCli,
    '-C',
    'engine',
    'sbom',
    '--prod',
    '--sbom-format',
    'spdx',
    '--sbom-type',
    'application',
    '--lockfile-only',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (result.error !== undefined) fail(`could not start pnpm: ${result.error.message}`);
if (result.status !== 0) {
  fail(`pnpm sbom failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
}

let sbom;
try {
  sbom = JSON.parse(result.stdout);
} catch (error) {
  fail(`pnpm returned invalid SPDX JSON: ${String(error)}`);
}
canonicalizePnpmIds(sbom);
applyNoticeLicenses(sbom, path.join(root, 'THIRD_PARTY_NOTICES.md'));

const releaseDate = /^date-released:\s*["']?([^"'\s]+)["']?$/m.exec(
  readFileSync(path.join(root, 'CITATION.cff'), 'utf8'),
)?.[1];
if (releaseDate === undefined) fail('CITATION.cff has no date-released value');

const harnessId = 'SPDXRef-OpenAqua-Harness';
const engineId = 'SPDXRef-RootPackage';
const versionRef = /^\d/.test(rootPackage.version)
  ? `v${rootPackage.version}`
  : rootPackage.version;
const addedPackages = [
  {
    SPDXID: harnessId,
    name: rootPackage.name,
    versionInfo: rootPackage.version,
    downloadLocation: `${rootPackage.repository.url}#${versionRef}`,
    filesAnalyzed: false,
    primaryPackagePurpose: 'APPLICATION',
    licenseConcluded: rootPackage.license,
    licenseDeclared: rootPackage.license,
    copyrightText: 'NOASSERTION',
    supplier: `Person: ${authorName(rootPackage.author)}`,
    homepage: rootPackage.homepage,
    externalRefs: [purlRef(`pkg:github/zhaorui-bi/OpenAqua-Harness@${rootPackage.version}`)],
  },
  {
    SPDXID: 'SPDXRef-Upstream-OpenAqua-0e39908',
    name: 'OpenAqua',
    versionInfo: '0e39908',
    downloadLocation: 'https://github.com/zhaorui-bi/OpenAqua/tree/0e3990817946f1786828fabbfa9ba4bc06af96e8',
    filesAnalyzed: false,
    primaryPackagePurpose: 'OTHER',
    licenseConcluded: 'MIT',
    licenseDeclared: 'MIT',
    copyrightText: 'Copyright (c) 2026 ElijahMoulton',
    supplier: 'Person: ElijahMoulton',
    homepage: 'https://github.com/zhaorui-bi/OpenAqua',
    externalRefs: [purlRef('pkg:github/zhaorui-bi/OpenAqua@0e39908')],
    comment:
      'External backend compatibility target; the desktop package includes OpenAqua-derived brand assets but not the OpenAqua Python source or dataset.',
  },
  componentPackage('node_modules/electron', 'LIBRARY', 'MIT'),
  componentPackage(
    'node_modules/@fontsource-variable/cormorant-garamond',
    'LIBRARY',
    'OFL-1.1',
  ),
  componentPackage(
    'node_modules/@fontsource-variable/noto-serif-sc',
    'LIBRARY',
    'OFL-1.1',
  ),
];

const existingIds = new Set(sbom.packages.map((entry) => entry.SPDXID));
for (const entry of addedPackages) {
  if (existingIds.has(entry.SPDXID)) fail(`duplicate SPDX package id: ${entry.SPDXID}`);
  sbom.packages.push(entry);
  existingIds.add(entry.SPDXID);
}
if (!existingIds.has(engineId)) fail(`pnpm SBOM omitted engine root ${engineId}`);

sbom.name = `OpenAqua Harness ${rootPackage.version}`;
sbom.documentNamespace = `https://github.com/zhaorui-bi/OpenAqua-Harness/releases/tag/${versionRef}/SBOM.spdx.json`;
sbom.creationInfo = {
  created: `${releaseDate}T00:00:00Z`,
  creators: [
    'Organization: OpenAqua Harness contributors',
    `Tool: pnpm-${pnpmManifest.version}`,
    'Tool: scripts/generate-sbom.mjs',
  ],
  comment:
    'Production dependency graph for the vendored engine, OpenAqua-derived brand assets and compatibility metadata, plus Electron and self-hosted font components shipped by the desktop application.',
};

// pnpm currently assigns workspace dependency edges nondeterministically when
// several importers share one lockfile. A release SBOM must be reproducible, so
// represent the flattened shipped inventory with stable CONTAINS relationships.
sbom.relationships = [
  relationship('SPDXRef-DOCUMENT', 'DESCRIBES', harnessId),
  ...sbom.packages
    .filter((entry) => entry.SPDXID !== harnessId)
    .map((entry) => relationship(harnessId, 'CONTAINS', entry.SPDXID)),
];

sbom.packages.sort((left, right) => left.SPDXID.localeCompare(right.SPDXID));
sbom.relationships.sort((left, right) => {
  const leftKey = `${left.spdxElementId}\0${left.relationshipType}\0${left.relatedSpdxElement}`;
  const rightKey = `${right.spdxElementId}\0${right.relationshipType}\0${right.relatedSpdxElement}`;
  return leftKey.localeCompare(rightKey);
});

const content = `${JSON.stringify(sbom, null, 2)}\n`;
if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== content) {
    fail('SBOM.spdx.json is stale; run `npm run licenses` and commit the result');
  }
  process.stdout.write(`SPDX SBOM: current (${String(sbom.packages.length)} packages)\n`);
} else {
  writeFileSync(outputPath, content, 'utf8');
  process.stdout.write(
    `SPDX SBOM: wrote ${path.relative(root, outputPath)} (${String(sbom.packages.length)} packages)\n`,
  );
}

function applyNoticeLicenses(sbomDocument, noticesPath) {
  if (!existsSync(noticesPath)) {
    fail('THIRD_PARTY_NOTICES.md is missing; run `npm run licenses`');
  }
  const declaredLicenses = new Map();
  for (const line of readFileSync(noticesPath, 'utf8').split('\n')) {
    const match = /^\| ((?:\\\||[^|])*) \| ([^|]+) \| ([^|]+) \|/.exec(line);
    if (match === null || match[1] === 'Package' || match[1] === '---') continue;
    const name = match[1].replaceAll('\\|', '|').trim();
    const version = match[2].trim();
    const license = match[3].trim();
    if (license !== '' && license !== 'UNKNOWN') {
      declaredLicenses.set(`${name}@${version}`, license);
    }
  }
  for (const entry of sbomDocument.packages) {
    if (entry.licenseDeclared !== 'NOASSERTION') continue;
    const declared = declaredLicenses.get(`${entry.name}@${entry.versionInfo}`);
    if (declared !== undefined) entry.licenseDeclared = declared;
  }
}

function canonicalizePnpmIds(sbomDocument) {
  const idMap = new Map();
  const canonicalIds = new Set(['SPDXRef-RootPackage']);
  for (const entry of sbomDocument.packages) {
    if (entry.SPDXID === 'SPDXRef-RootPackage') continue;
    const identity = JSON.stringify([
      entry.name ?? '',
      entry.versionInfo ?? '',
      entry.downloadLocation ?? '',
    ]);
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    const canonicalId = `SPDXRef-Package-${spdxToken(entry.name)}-${spdxToken(entry.versionInfo ?? 'unknown')}-${digest}`;
    if (canonicalIds.has(canonicalId)) {
      fail(`pnpm SBOM contains duplicate package identity: ${identity}`);
    }
    canonicalIds.add(canonicalId);
    idMap.set(entry.SPDXID, canonicalId);
    entry.SPDXID = canonicalId;
  }
  for (const entry of sbomDocument.relationships) {
    entry.spdxElementId = idMap.get(entry.spdxElementId) ?? entry.spdxElementId;
    entry.relatedSpdxElement =
      idMap.get(entry.relatedSpdxElement) ?? entry.relatedSpdxElement;
  }
}

function componentPackage(relativePath, purpose, fallbackLicense) {
  const manifest = readJson(path.join(root, relativePath, 'package.json'));
  return {
    SPDXID: `SPDXRef-Bundled-${spdxToken(manifest.name)}-${spdxToken(manifest.version)}`,
    name: manifest.name,
    versionInfo: manifest.version,
    downloadLocation: `https://registry.npmjs.org/${manifest.name}/-/${packageArchiveName(manifest.name)}-${manifest.version}.tgz`,
    filesAnalyzed: false,
    primaryPackagePurpose: purpose,
    licenseConcluded: licenseText(manifest.license) || fallbackLicense,
    licenseDeclared: licenseText(manifest.license) || fallbackLicense,
    copyrightText: 'NOASSERTION',
    supplier: authorName(manifest.author) === '' ? 'NOASSERTION' : `Person: ${authorName(manifest.author)}`,
    homepage: homepage(manifest),
    externalRefs: [purlRef(npmPurl(manifest.name, manifest.version))],
  };
}

function relationship(from, type, to) {
  return {
    spdxElementId: from,
    relationshipType: type,
    relatedSpdxElement: to,
  };
}

function purlRef(locator) {
  return {
    referenceCategory: 'PACKAGE-MANAGER',
    referenceType: 'purl',
    referenceLocator: locator,
  };
}

function packageArchiveName(name) {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

function npmPurl(name, version) {
  if (!name.startsWith('@')) return `pkg:npm/${name}@${version}`;
  const [scope, packageName] = name.split('/');
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`;
}

function spdxToken(value) {
  return String(value).replaceAll(/[^A-Za-z0-9.-]/g, '-');
}

function licenseText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(licenseText).filter(Boolean).join(' OR ');
  if (value !== null && typeof value === 'object') {
    return String(value.type ?? value.name ?? '');
  }
  return '';
}

function authorName(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    return String(value.name ?? value.email ?? '');
  }
  return '';
}

function homepage(manifest) {
  if (typeof manifest.homepage === 'string') return manifest.homepage;
  if (typeof manifest.repository === 'string') return manifest.repository;
  if (typeof manifest.repository?.url === 'string') return manifest.repository.url;
  return 'NOASSERTION';
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function fail(message) {
  process.stderr.write(`SPDX SBOM: ${message}\n`);
  process.exit(1);
}
