#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDirectory = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const outputPath = path.join(artifactsDirectory, 'SHA256SUMS');
const artifactPattern = /\.(?:AppImage|dmg|exe|tar\.gz|zip)$/;
const complianceArtifacts = new Set(['SBOM.spdx.json', 'THIRD_PARTY_NOTICES.md']);

if (!existsSync(artifactsDirectory)) {
  fail(`artifact directory does not exist: ${artifactsDirectory}`);
}
const artifacts = readdirSync(artifactsDirectory, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      (artifactPattern.test(entry.name) || complianceArtifacts.has(entry.name)),
  )
  .map((entry) => entry.name)
  .sort();
if (artifacts.length === 0) fail(`no release artifacts found in ${artifactsDirectory}`);

const lines = [];
for (const artifact of artifacts) {
  lines.push(`${await sha256(path.join(artifactsDirectory, artifact))}  ${artifact}`);
}
writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(
  `checksums: wrote ${path.relative(root, outputPath)} (${String(artifacts.length)} artifacts)\n`,
);

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function fail(message) {
  process.stderr.write(`checksums: ${message}\n`);
  process.exit(1);
}
