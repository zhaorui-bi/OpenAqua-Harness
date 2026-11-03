import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cancelJob, getJob, listJobs, readJobRunManifest, waitForJob } from '../src/openaqua/jobs';
import * as provenance from '../src/openaqua/provenance';
import {
  advanceResearchTask, cancelResearchTask, createResearchTask, getResearchTask, listResearchTasks,
  respondResearchTask, type ResearchContext, type ResearchTask,
} from '../src/openaqua/research';

const roots: string[] = [];
const contexts: ResearchContext[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ctx of contexts.splice(0)) {
    for (const job of listJobs(ctx.jobsRoot)) {
      if (job.status === 'running') await cancelJob(ctx.jobsRoot, job.id);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persistent research mandates', () => {
  it('registers without a backend, freezes unknown query context, and rejects conflicting request identities', () => {
    const fixture = setup();
    const ctx = { ...fixture.ctx, env: { OPENAQUA_WORKDIR: fixture.root, PATH: '' } };
    const input = { requestId: 'registration', objective: 'Screen a measured arsenic case', queryFile: 'query.json' };
    const task = createResearchTask(ctx, input);
    expect(task.version).toBe(1);
    expect(task.assignments).toEqual([]);
    expect(existsSync(fixture.calls)).toBe(false);
    expect(createResearchTask(ctx, input)).toEqual(task);
    const snapshot = task.queryRevisions[0];
    expect(JSON.parse(readFileSync(snapshot.path, 'utf8'))).toEqual(fixture.query);
    writeFileSync(fixture.queryFile, JSON.stringify({ ...fixture.query, context: 'changed input' }));
    expect(() => createResearchTask(ctx, input)).toThrow(/different research mandate or query/);
    expect(() => createResearchTask(ctx, { ...input, objective: 'Changed objective' })).toThrow(/different research mandate/);
    expect(getResearchTask(ctx, task.id)?.queryRevisions[0]?.sha256).toBe(snapshot.sha256);
    expect(listResearchTasks(ctx, { status: 'open' }).map((item) => item.id)).toEqual([task.id]);
    expect(() => getResearchTask(ctx, '../task.json')).toThrow(/Invalid research task id/);
  });

  it('requires valid bounded JSON, regular input files, and an unchanged mandate budget', () => {
    const fixture = setup();
    const input = { requestId: 'bounds', objective: 'Validate inputs', queryFile: fixture.queryFile };
    expect(() => createResearchTask(fixture.ctx, { ...input, maxJobs: 17 })).toThrow(/maxJobs/);
    writeFileSync(fixture.queryFile, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    expect(() => createResearchTask(fixture.ctx, input)).toThrow(/valid JSON/);
    writeFileSync(fixture.queryFile, JSON.stringify({ context: 'x'.repeat(256_001) }));
    expect(() => createResearchTask(fixture.ctx, input)).toThrow(/at most/);
    writeFileSync(fixture.queryFile, JSON.stringify(fixture.query));
    if (process.platform !== 'win32') {
      const linked = path.join(fixture.root, 'linked-query.json');
      symlinkSync(fixture.queryFile, linked);
      expect(() => createResearchTask(fixture.ctx, { ...input, queryFile: linked })).toThrow(/symbolic link/);
    }
    const task = createResearchTask(fixture.ctx, input);
    const stored = taskFile(fixture.ctx, task.id);
    const altered = JSON.parse(readFileSync(stored, 'utf8')) as ResearchTask;
    altered.mandate.maxJobs = 16;
    writeFileSync(stored, JSON.stringify(altered));
    expect(() => getResearchTask(fixture.ctx, task.id)).toThrow(/mandate fingerprint/);
  });

  it('lists only its physical workspace when another workspace shares the job store', () => {
    const fixture = setup();
    const first = create(fixture);
    const other = mkdtempSync(path.join(fixture.root, 'other-workspace-'));
    const ctx = { ...fixture.ctx, env: { ...fixture.ctx.env, OPENAQUA_WORKDIR: other } };
    const second = createResearchTask(ctx, { requestId: 'other-case', objective: 'Another workspace case', queryFile: fixture.queryFile });
    expect(listResearchTasks(fixture.ctx).map((task) => task.id)).toEqual([first.id]);
    expect(listResearchTasks(ctx).map((task) => task.id)).toEqual([second.id]);
    expect(() => getResearchTask(ctx, first.id)).toThrow(/different frozen workspace/);
  });

  it('holds a cross-process database lock and recovers after the lock holder exits', async () => {
    const fixture = setup();
    const task = create(fixture);
    const lockFile = path.join(fixture.ctx.jobsRoot, 'research', '.locks', `${task.id}.sqlite`);
    const holder = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(lockFile)});db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', () => { resolve(); });
        holder.once('error', reject);
        holder.once('exit', () => { reject(new Error('Lock holder exited too early.')); });
      });
      await expect(advanceResearchTask(fixture.ctx, { taskId: task.id })).rejects.toThrow(/locked by another operation/);
      expect(getResearchTask(fixture.ctx, task.id)?.version).toBe(1);
    } finally {
      const exited = new Promise<void>((resolve) => holder.once('exit', () => { resolve(); }));
      holder.kill('SIGKILL');
      await exited;
    }
    const restarted = await advanceResearchTask(fixture.ctx, { taskId: task.id, expectedVersion: 1 });
    expect(restarted.assignments).toHaveLength(1);
    await expect(advanceResearchTask(fixture.ctx, { taskId: task.id, expectedVersion: 1 })).rejects.toThrow(/version conflict/);
  });
});

describe('research execution and recovery', () => {
  it('runs four real durable jobs, reconciles an unknown observation, and preserves scientific lineage', async () => {
    const fixture = setup({ delayStage: 'assess-case', delayMs: 800 });
    const task = create(fixture);
    const simultaneous = await Promise.allSettled([
      advanceResearchTask(fixture.ctx, { taskId: task.id }),
      advanceResearchTask(fixture.ctx, { taskId: task.id }),
    ]);
    expect(simultaneous.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(simultaneous.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const assigned = getResearchTask(fixture.ctx, task.id)!;
    const originalJob = assigned.assignments[0].jobId;
    const job = getJob(fixture.ctx.jobsRoot, originalJob)!;
    const record = path.join(job.dir, 'job.json');
    renameSync(record, `${record}.temporarily-unavailable`);
    const unknown = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    expect(unknown.status).toBe('waiting');
    expect(unknown.attention.at(-1)?.kind).toBe('execution_unknown');
    await expect(respondResearchTask(fixture.ctx, { taskId: task.id, attentionId: unknown.attention.at(-1)!.id, expectedVersion: unknown.version, action: 'retry', reason: 'Observation timed out' })).rejects.toThrow(/not allowed/);
    renameSync(`${record}.temporarily-unavailable`, record);
    const recovered = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    expect(recovered.assignments[0]?.jobId).toBe(originalJob);
    expect(recovered.attention.find((item) => item.kind === 'execution_unknown')?.status).toBe('resolved');
    const ready = await complete(fixture.ctx, recovered);
    expect(ready.status).toBe('ready');
    expect(ready.stage).toBe('handoff');
    expect(ready.scientificOutcome.status).toBe('screening_ready');
    expect(ready.assignments.map((entry) => entry.stage)).toEqual(['assessment', 'retrieval', 'recommendation', 'audit']);
    expect(operations(fixture)).toEqual(['assess-case', 'retrieve', 'recommend', 'audit-report']);
    for (const assignment of ready.assignments) {
      const manifest = readJobRunManifest(fixture.ctx.jobsRoot, assignment.jobId)!.manifest!;
      expect(assignment.outputSha256).toBe(hashFile(assignment.output));
      expect(assignment.resultSha256).toBe(manifest.result!.resultSha256);
      expect(manifest.parameters.values['researchTaskId']).toBe(ready.id);
      expect(manifest.parameters.values['assignmentId']).toBe(assignment.id);
      expect(manifest.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const normalized = JSON.parse(readFileSync(ready.queryRevisions[0].normalized!.path, 'utf8')) as Record<string, unknown>;
    expect(normalized['unknown_extension']).toEqual({ sampling_round: 'pilot-1' });
    expect((await advanceResearchTask(fixture.ctx, { taskId: ready.id })).version).toBe(ready.version);
  }, 30_000);

  it('does not replace a failed job until explicitly retried and keeps the retry lineage', async () => {
    const fixture = setup({ failOnceStage: 'retrieve' });
    const task = create(fixture, { maxJobs: 5 });
    const failed = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: task.id }));
    expect(failed.status).toBe('waiting');
    expect(failed.attention.at(-1)?.kind).toBe('execution_failure');
    const count = failed.assignments.length;
    expect((await advanceResearchTask(fixture.ctx, { taskId: task.id })).assignments).toHaveLength(count);
    const answered = await respondResearchTask(fixture.ctx, { taskId: task.id, attentionId: failed.attention.at(-1)!.id, expectedVersion: failed.version, action: 'retry', reason: 'Confirmed transient fixture failure resolved.' });
    const ready = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: task.id, expectedVersion: answered.version }));
    expect(ready.status).toBe('ready');
    expect(ready.assignments).toHaveLength(5);
    expect(ready.assignments[2]?.retryOf).toBe(ready.assignments[1]?.id);
    expect(new Set(ready.assignments.map((assignment) => assignment.output)).size).toBe(5);
  }, 30_000);

  it('records a known preflight failure as not started and allows a new query revision', async () => {
    const fixture = setup();
    const task = create(fixture, { maxJobs: 6 });
    const prepare = vi.spyOn(provenance, 'createEngineeringJobRequest').mockImplementationOnce(() => { throw new Error('Input disappeared during request preflight.'); });
    const stopped = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    prepare.mockRestore();
    expect(stopped.assignments[0]?.notStarted).toBe(true);
    expect(stopped.assignments[0]?.status).toBe('failed');
    expect(listJobs(fixture.ctx.jobsRoot)).toEqual([]);
    expect(stopped.attention.at(-1)?.kind).toBe('preflight_failure');
    const revised = await respondResearchTask(fixture.ctx, { taskId: task.id, attentionId: stopped.attention.at(-1)!.id, expectedVersion: stopped.version, action: 'amend_query', queryFile: fixture.queryFile, reason: 'Resubmitted the verified case file.' });
    const ready = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: task.id, expectedVersion: revised.version }));
    expect(ready.status).toBe('ready');
    expect(ready.assignments).toHaveLength(5);
    expect(ready.queryRevisions).toHaveLength(2);
  }, 30_000);

  it('cancels the original active process and never starts another stage', async () => {
    const fixture = setup({ delayStage: 'assess-case', delayMs: 10_000 });
    const task = await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id });
    const jobId = task.assignments[0].jobId;
    await until(() => existsSync(fixture.calls));
    const cancelled = await cancelResearchTask(fixture.ctx, { taskId: task.id, expectedVersion: task.version, reason: 'Stop this bounded research run.' });
    expect(cancelled.status).toBe('cancelled');
    expect(getJob(fixture.ctx.jobsRoot, jobId)?.status).toBe('cancelled');
    expect((await advanceResearchTask(fixture.ctx, { taskId: task.id })).assignments).toHaveLength(1);
  }, 20_000);
});

describe('scientific workflow gates', () => {
  it('blocks critical gaps, preserves old revisions, and reassesses an amended case', async () => {
    const fixture = setup({ readiness: 'blocked' });
    const initial = create(fixture, { maxJobs: 6 });
    const blocked = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: initial.id }));
    expect(blocked.scientificOutcome.status).toBe('blocked');
    expect(blocked.assignments).toHaveLength(1);
    const item = blocked.attention.at(-1)!;
    await expect(respondResearchTask(fixture.ctx, { taskId: blocked.id, attentionId: item.id, expectedVersion: blocked.version, action: 'continue_screening', reason: 'Proceed anyway' })).rejects.toThrow(/not allowed/);
    fixture.mode({ readiness: 'ready_for_screening' });
    writeFileSync(fixture.queryFile, JSON.stringify({ ...fixture.query, context: 'Additional measured site information.' }));
    const revised = await respondResearchTask(fixture.ctx, { taskId: blocked.id, attentionId: item.id, expectedVersion: blocked.version, action: 'amend_query', queryFile: fixture.queryFile, reason: 'Added verified site information.' });
    expect(revised.queryRevisions).toHaveLength(2);
    expect(hashFile(revised.queryRevisions[0].path)).toBe(revised.queryRevisions[0].sha256);
    const ready = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: revised.id }));
    expect(ready.status).toBe('ready');
    expect(ready.assignments.map((entry) => entry.queryRevision)).toEqual([1, 2, 2, 2, 2]);
  }, 30_000);

  it('records high-gap continuation as caller-declared conditional screening', async () => {
    const fixture = setup({ readiness: 'needs_information' });
    const blocked = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    const answered = await respondResearchTask(fixture.ctx, { taskId: blocked.id, attentionId: blocked.attention.at(-1)!.id, expectedVersion: blocked.version, action: 'continue_screening', reason: 'Only a conditional technology shortlist is requested.' });
    const ready = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: answered.id }));
    expect(ready.status).toBe('ready');
    expect(ready.scientificOutcome.status).toBe('conditional_screening');
    expect(ready.queryRevisions[0]?.conditionalScreening?.authority).toBe('caller-declared');
    expect(ready.scientificOutcome.limitations.join(' ')).toContain('cannot demonstrate target attainment');
  }, 30_000);

  it.each(['warn', 'fail', 'malformed'])('does not confuse a successful %s audit process with a passed scientific review', async (auditStatus) => {
    const fixture = setup({ auditStatus });
    const stopped = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    expect(stopped.status).toBe('waiting');
    expect(stopped.assignments.at(-1)?.status).toBe('succeeded');
    expect(stopped.attention.at(-1)?.kind).toBe(auditStatus === 'malformed' ? 'malformed_result' : 'scientific_review');
    expect((await advanceResearchTask(fixture.ctx, { taskId: stopped.id })).assignments).toHaveLength(4);
  }, 30_000);

  it.each(['partialAudit', 'foreignLedger'])('rejects an internally consistent audit with %s', async (mode) => {
    const fixture = setup({ [mode]: true });
    const stopped = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    expect(stopped.status).toBe('waiting');
    expect(stopped.attention.at(-1)?.kind).toBe('malformed_result');
    expect(stopped.assignments.at(-1)?.stage).toBe('audit');
    expect(stopped.assignments.at(-1)?.status).toBe('succeeded');
    expect(stopped.scientificOutcome.status).not.toBe('screening_ready');
  }, 20_000);

  it.each(['emptyEvidence', 'drift'])('stops before recommendation when %s is detected', async (mode) => {
    const fixture = setup({ [mode]: true });
    const stopped = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    expect(stopped.status).toBe('waiting');
    expect(stopped.assignments).toHaveLength(2);
    expect(stopped.attention.at(-1)?.kind).toBe(mode === 'emptyEvidence' ? 'evidence_gap' : 'malformed_result');
    expect(operations(fixture)).toEqual(['assess-case', 'retrieve']);
  }, 20_000);

  it.each(['critical_actions', 'high_status', 'summary'])('rejects contradictory case readiness: %s', async (readinessConflict) => {
    const fixture = setup({ readinessConflict });
    const stopped = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    expect(stopped.status).toBe('waiting');
    expect(stopped.attention.at(-1)?.kind).toBe('malformed_result');
    expect(stopped.attention.at(-1)?.allowedActions).not.toContain('continue_screening');
    expect(stopped.assignments).toHaveLength(1);
    expect(operations(fixture)).toEqual(['assess-case']);
  }, 15_000);

  it('stops at the frozen job budget without silently expanding authorization', async () => {
    const fixture = setup();
    const stopped = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture, { maxJobs: 1 }).id }));
    expect(stopped.attention.at(-1)?.kind).toBe('budget_exhausted');
    expect(stopped.assignments).toHaveLength(1);
    expect(operations(fixture)).toEqual(['assess-case']);
  }, 15_000);

  it('requires explicit restored-environment retry and blocks scientific configuration drift', async () => {
    const fixture = setup({ healthy: false });
    const waiting = await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id });
    expect(waiting.attention.at(-1)?.kind).toBe('environment_readiness');
    expect(waiting.assignments).toHaveLength(0);
    fixture.mode({ healthy: true });
    const response = await respondResearchTask(fixture.ctx, { taskId: waiting.id, attentionId: waiting.attention.at(-1)!.id, expectedVersion: waiting.version, action: 'retry', reason: 'Dependencies and indexes restored.' });
    const started = await advanceResearchTask(fixture.ctx, { taskId: response.id });
    await waitForJob(fixture.ctx.jobsRoot, started.assignments[0].jobId, 10_000, 20);
    fixture.mode({ identity: 'changed-revision' });
    const drifted = await advanceResearchTask(fixture.ctx, { taskId: started.id });
    expect(drifted.attention.at(-1)?.kind).toBe('configuration_drift');
    expect(drifted.assignments).toHaveLength(1);
  }, 20_000);
});

describe('research artifact integrity', () => {
  it('rejects a fabricated ready state with no completed stage or audit lineage', async () => {
    const fixture = setup();
    const task = create(fixture);
    task.status = 'ready'; task.stage = 'handoff'; task.scientificOutcome.auditStatus = 'pass';
    writeFileSync(taskFile(fixture.ctx, task.id), JSON.stringify(task));
    const checked = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    expect(checked.status).toBe('waiting');
    expect(checked.scientificOutcome.status).toBe('review_required');
    expect(checked.attention.at(-1)?.kind).toBe('integrity');
    expect(checked.assignments).toEqual([]);
    expect(existsSync(fixture.calls)).toBe(false);
  });

  it('revalidates a ready handoff and revokes readiness when its report changes', async () => {
    const fixture = setup();
    const ready = await complete(fixture.ctx, await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id }));
    expect(ready.status).toBe('ready');
    const reportFile = ready.scientificOutcome.reportFile!;
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(reportFile, JSON.stringify({ ...report, recommendations: [] }));
    const checked = await advanceResearchTask(fixture.ctx, { taskId: ready.id });
    expect(checked.status).toBe('waiting');
    expect(checked.scientificOutcome.status).toBe('review_required');
    expect(checked.attention.at(-1)?.kind).toBe('integrity');
    expect(checked.assignments).toHaveLength(4);
    expect(operations(fixture)).toHaveLength(4);
  }, 20_000);

  it('does not consume a successful job output changed after its completion fingerprint', async () => {
    const fixture = setup();
    const task = await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id });
    const assignment = task.assignments[0];
    await waitForJob(fixture.ctx.jobsRoot, assignment.jobId, 10_000, 20);
    writeFileSync(assignment.output, JSON.stringify({ normalized_query: fixture.query, decision_readiness: { status: 'ready_for_screening', critical_blockers: [], information_actions: [] } }));
    const stopped = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    expect(stopped.status).toBe('waiting');
    expect(stopped.attention.at(-1)?.message).toContain('completion-time fingerprint');
    expect(stopped.assignments).toHaveLength(1);
  }, 15_000);

  it('rechecks a consumed report after a readiness wait before dispatching its audit', async () => {
    const fixture = setup();
    let task = await advanceResearchTask(fixture.ctx, { taskId: create(fixture).id });
    while (task.assignments.at(-1)?.stage !== 'recommendation') {
      if (task.status === 'waiting') throw new Error(`Research unexpectedly stopped: ${JSON.stringify(task.attention)}`);
      await waitForJob(fixture.ctx.jobsRoot, task.assignments.at(-1)!.jobId, 10_000, 20);
      task = await advanceResearchTask(fixture.ctx, { taskId: task.id });
    }
    const recommendation = task.assignments.at(-1)!;
    await waitForJob(fixture.ctx.jobsRoot, recommendation.jobId, 10_000, 20);
    fixture.mode({ healthPause: true });
    const paused = path.join(fixture.root, 'health-paused');
    const advancing = advanceResearchTask(fixture.ctx, { taskId: task.id });
    await until(() => existsSync(paused));
    const report = JSON.parse(readFileSync(recommendation.output, 'utf8')) as Record<string, unknown>;
    writeFileSync(recommendation.output, JSON.stringify({ ...report, injected_claim: 'Unverified alteration' }));
    const stopped = await advancing;
    expect(stopped.status).toBe('waiting');
    expect(stopped.attention.at(-1)?.kind).toBe('integrity');
    expect(stopped.assignments).toHaveLength(3);
    expect(operations(fixture)).not.toContain('audit-report');
  }, 25_000);
});

function create(fixture: ReturnType<typeof setup>, options: { maxJobs?: number } = {}): ResearchTask {
  return createResearchTask(fixture.ctx, { requestId: 'research-test', objective: 'Screen arsenic treatment options without claiming target attainment.', queryFile: fixture.queryFile, maxJobs: options.maxJobs });
}

async function complete(ctx: ResearchContext, initial: ResearchTask): Promise<ResearchTask> {
  let task = initial;
  const deadline = Date.now() + 20_000;
  while (!['ready', 'waiting', 'cancelled'].includes(task.status) && Date.now() < deadline) {
    const assignment = task.assignments.at(-1);
    if (assignment !== undefined && !assignment.consumed) await waitForJob(ctx.jobsRoot, assignment.jobId, 10_000, 20);
    task = await advanceResearchTask(ctx, { taskId: task.id });
  }
  if (Date.now() >= deadline) throw new Error(`Research did not settle: ${JSON.stringify(task)}`);
  return task;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  if (!predicate()) throw new Error('Fixture did not reach the expected live state.');
}

function taskFile(ctx: ResearchContext, id: string): string { return path.join(ctx.jobsRoot, 'research', id, 'task.json'); }
function hashFile(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function operations(fixture: ReturnType<typeof setup>): string[] { return existsSync(fixture.calls) ? readFileSync(fixture.calls, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { operation: string }).operation) : []; }

function setup(initialMode: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'openaqua-research-test-'));
  roots.push(root);
  const backend = path.join(root, 'adapter-fixture.mjs');
  const queryFile = path.join(root, 'query.json');
  const control = path.join(root, 'control.json');
  const calls = path.join(root, 'calls.jsonl');
  const query = { source_water: 'groundwater', contaminants: ['arsenic'], water_quality: { arsenic_ug_L: 150, pH: 7, extra: { arsenic_speciation: 'As(V)' } }, treatment_targets: { arsenic_ug_L: 10 }, constraints: { use_for_drinking: false, budget: 'low' }, unknown_extension: { sampling_round: 'pilot-1' } };
  writeFileSync(queryFile, JSON.stringify(query));
  writeFileSync(control, JSON.stringify(initialMode));
  writeFileSync(backend, fixtureScript);
  const ctx: ResearchContext = { jobsRoot: path.join(root, 'jobs'), env: { ...process.env, OPENAQUA_WORKDIR: root, OPENAQUA_COMMAND: JSON.stringify([process.execPath, backend]) } };
  contexts.push(ctx);
  return { root, queryFile, query, ctx, calls, mode: (settings: Record<string, unknown>) => { writeFileSync(control, JSON.stringify(settings)); } };
}

const fixtureScript = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.dirname(fileURLToPath(import.meta.url));
const mode = JSON.parse(readFileSync(path.join(root, 'control.json'), 'utf8'));
const args = process.argv.slice(2);
const operation = args[0];
const value = flag => args[args.indexOf(flag) + 1];
if (operation === '--version') { console.log('fixture-adapter 1'); process.exit(0); }
if (operation === 'health') {
  if (mode.healthPause) { writeFileSync(path.join(root, 'health-paused'), 'ready'); await delay(350); }
  console.log(JSON.stringify({ ok: mode.healthy !== false, ready_for_recommendation: mode.healthy !== false })); process.exit(0);
}
if (operation === 'identity') { console.log(JSON.stringify({ backend_revision: mode.identity || 'fixture-revision', models: { openrouter_configured: false }, retrieval: {}, planning: {} })); process.exit(0); }
appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ operation }) + '\n');
if (mode.delayStage === operation) await delay(mode.delayMs || 100);
const failure = path.join(root, 'already-failed');
if (mode.failOnceStage === operation && !existsSync(failure)) { writeFileSync(failure, 'yes'); process.stderr.write('ERROR fixture transient failure\n'); process.exit(2); }
const query = operation === 'audit-report' ? JSON.parse(readFileSync(value('--report-file'), 'utf8')).normalized_query : JSON.parse(readFileSync(value('--query-file'), 'utf8'));
const normalized = { ...query, query_id: randomUUID(), missing_fields: [], assumptions: [], normalization_notes: [] };
if (operation === 'retrieve' && mode.drift) normalized.water_quality = { ...normalized.water_quality, arsenic_ug_L: 999 };
const readiness = mode.readiness || 'ready_for_screening';
const critical = readiness === 'blocked' ? [{ priority: 'critical', field: 'source_water' }] : [];
const citation = { source_id: 'fixture-source', chunk_id: 'fixture-chunk', claim: 'Adsorption was investigated in a comparable matrix.', support_type: 'evidence_backed', text_excerpt: 'Adsorption was investigated under stated conditions.' };
const auditStatus = mode.auditStatus || 'pass';
const issues = auditStatus === 'fail' ? [{ severity: 'critical', code: 'AUDIT-008', message: 'Failed fixture constraint.' }] : auditStatus === 'warn' ? [{ severity: 'warning', code: 'AUDIT-011', message: 'Insufficient fixture evidence.' }] : [];
const payload = operation === 'assess-case' ? {
  normalized_query: normalized,
  decision_readiness: { status: readiness, critical_blockers: critical, information_actions: critical.length ? critical : readiness === 'needs_information' ? [{ priority: 'high', field: 'water_quality.extra.arsenic_speciation' }] : [] }
} : operation === 'retrieve' ? {
  normalized_query: normalized,
  retrieval: { kb_unit: mode.emptyEvidence ? [] : [{ source_id: citation.source_id, chunk_id: citation.chunk_id, text: citation.text_excerpt, relevance_score: 0.8 }], kb_case: [] }
} : operation === 'recommend' ? {
  normalized_query: normalized,
  recommendations: [{ chain_id: 'fixture-chain', chain: ['Adsorption'], evidence: [citation], constraint_report: { overall_status: 'PASS' }, uncertainty: 'medium' }]
} : operation === 'audit-report' ? auditStatus === 'malformed' ? { status: 'pass' } : {
  schema_version: 1, kind: 'openaqua.claim-evidence-audit', status: auditStatus,
  report: { path: value('--report-file') },
  summary: { recommendations: 1, claims: 1, critical_issues: auditStatus === 'fail' ? 1 : 0, warnings: auditStatus === 'warn' ? 1 : 0 },
  issues, recommendations: [{ chain_id: 'fixture-chain', status: auditStatus }], claim_ledger: [{ ...citation, claim_id: 'fixture-claim', chain_id: mode.foreignLedger ? 'another-report-chain' : 'fixture-chain' }]
} : (() => { throw new Error('Unexpected operation ' + operation); })();
if (operation === 'recommend' && mode.partialAudit) payload.recommendations.push({ ...payload.recommendations[0], chain_id: 'unreviewed-chain' });
if (operation === 'assess-case' && mode.readinessConflict === 'critical_actions') payload.decision_readiness.information_actions = [{ priority: 'critical', field: 'water_quality.extra.nitrate_basis' }];
if (operation === 'assess-case' && mode.readinessConflict === 'high_status') payload.decision_readiness.information_actions = [{ priority: 'high', field: 'water_quality.extra.arsenic_speciation' }];
if (operation === 'assess-case' && mode.readinessConflict === 'summary') payload.decision_readiness.summary = { critical: 1, high: 0, medium: 0 };
const output = value('--output');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(payload) + '\n');
console.log(JSON.stringify(payload));
`;
