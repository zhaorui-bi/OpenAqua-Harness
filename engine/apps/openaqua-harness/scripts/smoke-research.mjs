#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.resolve(process.argv[2] ?? path.join(packageRoot, 'dist', 'cli.mjs'));
const scratch = mkdtempSync(path.join(tmpdir(), 'openaqua-research-smoke-'));
const queryFile = path.join(scratch, 'query.json');
const inputFile = path.join(scratch, 'request.json');
const backendFile = path.join(scratch, 'adapter-fixture.mjs');
const callsFile = path.join(scratch, 'calls.jsonl');
const query = {
  source_water: 'groundwater',
  contaminants: ['arsenic'],
  water_quality: { arsenic_ug_L: 150, pH: 7, extra: { arsenic_speciation: 'As(V)' } },
  treatment_targets: { arsenic_ug_L: 10 },
  constraints: { budget: 'low', brine_disposal: false, use_for_drinking: false },
};
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|^OPENAQUA_|^KIMI_/i.test(key)) delete env[key];
}
Object.assign(env, {
  OPENAQUA_HOME: path.join(scratch, 'home'),
  OPENAQUA_WORKDIR: scratch,
  OPENAQUA_JOBS_DIR: path.join(scratch, 'jobs'),
  OPENAQUA_COMMAND: JSON.stringify([process.execPath, backendFile]),
  KIMI_LOG_LEVEL: 'off',
});

writeFileSync(queryFile, JSON.stringify(query));
writeFileSync(backendFile, [
  "import assert from 'node:assert/strict';",
  "import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';",
  "import path from 'node:path';",
  "import {fileURLToPath} from 'node:url';",
  "import {setTimeout as delay} from 'node:timers/promises';",
  `await (${adapterFixture.toString()})();`,
].join('\n'));

let taskId;
try {
  const request = {
    requestId: 'cli-smoke-arsenic-case',
    objective: 'Compare early-stage arsenic treatment options',
    queryFile,
    topK: 3,
    maxJobs: 4,
  };
  const created = command('create', request);
  taskId = created.id;
  assert.match(taskId, /^research_[a-f0-9]{24}$/);
  assert.equal(created.version, 1);
  assert.equal(created.status, 'open');
  assert.equal(created.assignments.length, 0);
  assert.equal(existsSync(callsFile), false, 'registration launched the fixture backend');
  assert.equal(command('create', request).id, taskId, 'repeated create produced another task');

  const originalSnapshot = created.queryRevisions[0];
  writeFileSync(queryFile, JSON.stringify({ source_water: 'seawater' }));
  assert.equal(hashFile(originalSnapshot.path), originalSnapshot.sha256, 'source edit changed frozen query');
  assert.deepEqual(JSON.parse(readFileSync(originalSnapshot.path, 'utf8')), query);
  writeFileSync(queryFile, JSON.stringify(query));

  const invalid = invoke(['research', 'status']);
  assert.notEqual(invalid.status, 0, 'status accepted a missing task id');
  command('create', { ...request, requestId: 'invalid-budget', maxJobs: 17 }, true);
  const listed = command('list', {});
  assert.equal(listed.returned, 1, 'invalid input created a task');
  assert.equal(listed.tasks[0].id, taskId);

  let task = command('advance', { taskId });
  assert.equal(task.assignments.length, 1, 'first advance did not assign one assessment');
  const firstJob = task.assignments[0].jobId;
  const recovered = direct('status', taskId);
  assert.equal(recovered.assignments[0].jobId, firstJob, 'new CLI process did not recover the original assignment');
  assert.equal(recovered.version, task.version, 'read-only status mutated the task');

  const deadline = Date.now() + 90_000;
  while (task.status !== 'ready' && Date.now() < deadline) {
    assert.notEqual(task.status, 'waiting', `unexpected research attention: ${JSON.stringify(task.attention)}`);
    await delay(200);
    task = direct('advance', taskId);
  }
  assert.equal(task.status, 'ready', 'four-stage research did not reach the handoff');
  assert.equal(task.stage, 'handoff');
  assert.equal(task.scientificOutcome.status, 'screening_ready');
  assert.equal(task.scientificOutcome.auditStatus, 'pass');
  assert.deepEqual(task.assignments.map((assignment) => assignment.stage), [
    'assessment', 'retrieval', 'recommendation', 'audit',
  ]);
  assert.equal(new Set(task.assignments.map((assignment) => assignment.jobId)).size, 4);
  assert.equal(task.assignments[0].jobId, firstJob);
  for (const assignment of task.assignments) {
    assert.equal(assignment.status, 'succeeded');
    assert.match(assignment.requestSha256, /^[a-f0-9]{64}$/);
    const manifest = JSON.parse(readFileSync(path.join(scratch, 'jobs', assignment.jobId, 'run-manifest.json'), 'utf8'));
    assert.equal(manifest.jobId, assignment.jobId);
    assert.equal(assignment.requestSha256, manifest.requestSha256, 'assignment request differs from its durable manifest');
    assert.equal(assignment.resultSha256, manifest.result.resultSha256, 'assignment result identity differs from its durable manifest');
    assert.equal(hashFile(assignment.output), manifest.result.output.sha256, 'handoff output bytes differ from their captured SHA-256');
    if (assignment.outputSha256 !== undefined) {
      assert.equal(assignment.outputSha256, manifest.result.output.sha256, 'assignment output hash differs from its durable manifest');
    }
  }
  assert.deepEqual(readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).operation), [
    'assess-case', 'retrieve', 'recommend', 'audit-report',
  ], 'recovery duplicated or widened backend work');
  const again = direct('advance', taskId);
  assert.equal(again.version, task.version, 'advancing a ready task mutated its state');
  assert.equal(again.assignments.length, 4);

  const pending = command('create', { ...request, requestId: 'cli-smoke-cancel' });
  const cancelled = command('cancel', { taskId: pending.id, reason: 'Smoke check completed' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(direct('advance', pending.id).assignments.length, 0, 'cancelled research started backend work');
  process.stdout.write('Research CLI smoke: isolated adapter fixture, four real durable jobs, process recovery, hashes, idempotence, input bounds, and cancellation verified\n');
} finally {
  if (taskId !== undefined) {
    try {
      const task = direct('status', taskId);
      if (!['ready', 'cancelled'].includes(task.status)) {
        command('cancel', { taskId, reason: 'Clean up isolated smoke execution' });
      }
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
}

function invoke(args) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4_000_000,
  });
}

function command(action, args, expectFailure = false) {
  writeFileSync(inputFile, JSON.stringify(args));
  const result = invoke(['research', action, '--input', inputFile]);
  if (expectFailure) {
    assert.notEqual(result.status, 0, `research ${action} unexpectedly accepted invalid input`);
    return undefined;
  }
  assert.equal(result.status, 0, `research ${action} failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout);
}

function direct(action, id) {
  const result = invoke(['research', action, '--id', id]);
  assert.equal(result.status, 0, `research ${action} failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout);
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function adapterFixture() {
  const args = process.argv.slice(2);
  const folder = path.dirname(fileURLToPath(import.meta.url));
  if (args.includes('--version')) {
    process.stdout.write('openaqua adapter fixture\n');
    return;
  }
  const operation = args[0];
  if (operation === 'health') {
    process.stdout.write(JSON.stringify({ ready_for_recommendation: true }));
    return;
  }
  if (operation === 'identity') {
    process.stdout.write(JSON.stringify({
      backend_revision: 'fixture-revision',
      models: { openrouter_configured: false },
      retrieval: { top_k_retrieval: 1 },
      planning: { top_k_recommendations: 3 },
    }));
    return;
  }
  assert.ok(['assess-case', 'retrieve', 'recommend', 'audit-report'].includes(operation), `unauthorized fixture operation: ${operation}`);
  appendFileSync(path.join(folder, 'calls.jsonl'), JSON.stringify({ operation }) + '\n');
  const valueAfter = (flag) => args[args.indexOf(flag) + 1];
  const query = operation === 'audit-report'
    ? JSON.parse(readFileSync(valueAfter('--report-file'), 'utf8')).normalized_query
    : JSON.parse(readFileSync(valueAfter('--query-file'), 'utf8'));
  const citation = {
    claim: 'A retrieved source considers adsorption for arsenic-containing groundwater.',
    support_type: 'evidence_backed',
    source_id: 'fixture-source',
    chunk_id: 'fixture-unit-1',
    text_excerpt: 'Adsorption was studied under the stated conditions.',
  };
  const payloads = {
    'assess-case': {
      normalized_query: query,
      case_state: { schema_version: 1, source_water: query.source_water },
      decision_readiness: { status: 'ready_for_screening', critical_blockers: [], information_actions: [] },
    },
    retrieve: {
      normalized_query: query,
      retrieval: {
        query_id: 'fixture-query',
        kb_unit: [{
          source_id: citation.source_id,
          chunk_id: citation.chunk_id,
          text: citation.text_excerpt,
          relevance_score: 0.8,
        }],
        kb_case: [],
        total_retrieved: 1,
      },
    },
    recommend: {
      query_id: 'fixture-query',
      pipeline_version: 'fixture-pipeline',
      normalized_query: query,
      recommendations: [{
        chain_id: 'fixture-chain',
        chain: ['Adsorption'],
        evidence: [citation],
        constraint_report: { overall_status: 'PASS' },
        uncertainty: 'medium',
      }],
    },
    'audit-report': {
      schema_version: 1,
      kind: 'openaqua.claim-evidence-audit',
      report: { path: valueAfter('--report-file'), query_id: 'fixture-query', pipeline_version: 'fixture-pipeline' },
      status: 'pass',
      summary: {
        recommendations: 1,
        claims: 1,
        support_types: { evidence_backed: 1, system_inference: 0, assumption: 0 },
        malformed_claims: 0,
        critical_issues: 0,
        warnings: 0,
      },
      recommendations: [{
        index: 1,
        chain_id: 'fixture-chain',
        status: 'pass',
        constraint_status: 'PASS',
        evidence_backed_claims: 1,
        issues: [],
      }],
      issues: [],
      claim_ledger: [{
        ...citation,
        claim_id: 'fixture-chain:evidence:1',
        chain_id: 'fixture-chain',
        recommendation_index: 1,
        structurally_complete: true,
      }],
      limitations: ['This fixture tests orchestration and does not establish treatment performance.'],
    },
  };
  const output = valueAfter('--output');
  assert.equal(typeof output, 'string');
  await delay(200);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(payloads[operation]), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(payloads[operation]));
}
