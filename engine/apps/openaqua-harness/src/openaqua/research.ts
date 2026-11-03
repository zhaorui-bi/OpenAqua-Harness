import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import { atomicWriteJson } from '../fs-utils';
import { resolveUserPath } from '../paths';
import { resolveOpenAquaBackend, runBackend, type OpenAquaBackend } from './backend';
import { cancelJob, getJob, readJobRunManifest, startJob, type JobSnapshot } from './jobs';
import { createEngineeringJobRequest, type JsonValue } from './provenance';

export interface ResearchContext {
  readonly homeDir?: string;
  readonly jobsRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

export type ResearchStatus = 'open' | 'running' | 'waiting' | 'ready' | 'cancelled';
export type ResearchStage = 'readiness' | 'assessment' | 'retrieval' | 'recommendation' | 'audit' | 'handoff';
type JobStage = Exclude<ResearchStage, 'readiness' | 'handoff'>;
type ResearchResponse = 'amend_query' | 'continue_screening' | 'retry';

export interface ResearchAttention {
  id: string;
  kind: string;
  stage: ResearchStage;
  status: 'open' | 'resolved';
  message: string;
  allowedActions: ResearchResponse[];
  createdAt: string;
  details?: Record<string, JsonValue>;
  resolvedAt?: string;
  resolution?: { action: ResearchResponse; reason: string; authority: 'caller-declared' };
  reconciliation?: { jobId: string; status: string; authority: 'system-observed' };
}

export interface ResearchAssignment {
  id: string;
  stage: JobStage;
  jobId: string;
  status: 'launching' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  queryRevision: number;
  output: string;
  createdAt: string;
  finishedAt?: string;
  retryOf?: string;
  requestSha256?: string;
  resultSha256?: string;
  outputSha256?: string;
  consumed?: boolean;
  error?: string;
  notStarted?: boolean;
}

export interface ResearchQueryRevision {
  revision: number;
  path: string;
  sha256: string;
  createdAt: string;
  reason: string;
  normalized?: { path: string; sha256: string; scientificSha256: string };
  conditionalScreening?: { reason: string; authority: 'caller-declared'; limitations: string[] };
}

export interface ResearchTask {
  schemaVersion: 1;
  kind: 'openaqua.research-task';
  id: string;
  requestId: string;
  requestSha256: string;
  objective: string;
  version: number;
  status: ResearchStatus;
  stage: ResearchStage;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
  mandate: {
    workDir: string;
    jobsRoot: string;
    outputDir: string;
    allowedOperations: string[];
    topK: number;
    maxJobs: number;
    initialQuerySha256: string;
    backend?: {
      command: string[];
      source: string;
      version: string;
      scientificConfiguration: Record<string, JsonValue>;
      sha256: string;
    };
  };
  queryRevisions: ResearchQueryRevision[];
  assignments: ResearchAssignment[];
  attention: ResearchAttention[];
  events: { sequence: number; at: string; type: string; stage: ResearchStage; detail: string }[];
  eventCount: number;
  eventsTruncated: boolean;
  scientificOutcome: {
    status: 'pending' | 'blocked' | 'conditional_screening' | 'review_required' | 'screening_ready' | 'cancelled';
    auditStatus?: 'pass' | 'warn' | 'fail';
    limitations: string[];
    reportFile?: string;
    auditFile?: string;
  };
}

interface TaskPaths {
  root: string;
  dir: string;
  record: string;
  artifacts: string;
}

const TASK_ID = /^research_[a-f0-9]{24}$/;
const JOB_ID = /^job_\d{14}_[a-z0-9]{6,16}$/;
const MAX_JSON_BYTES = 2_000_000;
const MAX_QUERY_BYTES = 256_000;
const MAX_EVENTS = 128;
const MAX_REVISIONS = 16;
const OPERATIONS = ['health', 'assess-case', 'retrieve', 'recommend', 'audit-report'];
const STAGE_OPERATION: Record<JobStage, string> = {
  assessment: 'assess-case', retrieval: 'retrieve', recommendation: 'recommend', audit: 'audit-report',
};
const STAGE_TOOL: Record<JobStage, string> = {
  assessment: 'openaqua_assess_case', retrieval: 'openaqua_retrieve_evidence',
  recommendation: 'openaqua_recommend', audit: 'openaqua_audit_report',
};
const SCIENCE_FIELDS = ['source_water', 'contaminants', 'water_quality', 'treatment_targets', 'constraints', 'context'];
const LIMITATIONS = [
  'This workflow supports early-stage technology screening, not final design, target attainment, field performance, safety, or regulatory compliance.',
  'The audit checks declared structure and selected signals; expert review and site-specific validation remain necessary.',
  'Request and output fingerprints do not freeze remote model behavior or establish evidence transferability.',
  'The mandate limits backend job submissions, not remote API tokens, monetary cost, or elapsed time.',
];

export function createResearchTask(ctx: ResearchContext, input: {
  requestId: string; objective: string; queryFile: string; topK?: number; maxJobs?: number;
}): ResearchTask {
  const requestId = text(input.requestId, 'requestId', 256);
  const objective = text(input.objective, 'objective', 8_000);
  const topK = integer(input.topK ?? 3, 'topK', 1, 10);
  const maxJobs = integer(input.maxJobs ?? 4, 'maxJobs', 1, 16);
  const workDir = currentWorkDir(ctx);
  const query = readJson(resolveInput(input.queryFile, workDir), MAX_QUERY_BYTES);
  validateQuery(query);
  const queryText = `${JSON.stringify(query, null, 2)}\n`;
  const id = `research_${hash(canonical({ requestId, workDir })).slice(0, 24)}`;
  const initialQuerySha256 = hash(canonical(query));
  const requestSha256 = hash(canonical({ requestId, objective, workDir, topK, maxJobs, initialQuerySha256 }));
  const paths = taskPaths(ctx, id, true);
  const release = acquireLock(paths, id);
  try {
    const previous = readTask(paths, ctx);
    if (previous !== undefined) {
      if (previous.requestSha256 !== requestSha256) {
        throw new Error('requestId already identifies a different research mandate or query; use a new requestId.');
      }
      verifyRevision(previous, paths);
      return previous;
    }
    privateDirectory(paths.dir);
    privateDirectory(paths.artifacts);
    const queryPath = path.join(paths.artifacts, 'query-1.json');
    atomicWriteJson(queryPath, query);
    const now = new Date().toISOString();
    const task: ResearchTask = {
      schemaVersion: 1, kind: 'openaqua.research-task', id, requestId, requestSha256, objective,
      version: 1, status: 'open', stage: 'readiness', nextAction: 'Call advance to check runtime readiness.',
      createdAt: now, updatedAt: now,
      mandate: { workDir, jobsRoot: path.resolve(ctx.jobsRoot), outputDir: paths.artifacts,
        allowedOperations: [...OPERATIONS], topK, maxJobs, initialQuerySha256 },
      queryRevisions: [{ revision: 1, path: queryPath, sha256: hash(queryText), createdAt: now, reason: 'Initial caller-supplied query.' }],
      assignments: [], attention: [], events: [], eventCount: 0, eventsTruncated: false,
      scientificOutcome: { status: 'pending', limitations: [...LIMITATIONS] },
    };
    event(task, 'created', 'Registered a bounded research mandate; no backend operation has run.');
    atomicWriteJson(paths.record, task);
    return task;
  } finally { release(); }
}

export function getResearchTask(ctx: ResearchContext, taskId: string): ResearchTask | undefined {
  return readTask(taskPaths(ctx, taskId, false), ctx);
}

export function listResearchTasks(ctx: ResearchContext, options: {
  limit?: number; status?: ResearchStatus;
} = {}): ResearchTask[] {
  const limit = integer(options.limit ?? 20, 'limit', 1, 100);
  if (options.status !== undefined && !['open', 'running', 'waiting', 'ready', 'cancelled'].includes(options.status)) {
    throw new Error('Invalid research status filter.');
  }
  const root = path.join(path.resolve(ctx.jobsRoot), 'research');
  if (!existsSync(root)) return [];
  regularDirectory(root);
  const tasks: ResearchTask[] = [];
  const entries = readdirSync(root);
  if (entries.length > 10_000) throw new Error('Research task inventory exceeds 10000 entries.');
  for (const id of entries.filter((entry) => TASK_ID.test(entry))) {
    const task = readTask(taskPaths(ctx, id, false), ctx, true);
    if (task !== undefined && (options.status === undefined || task.status === options.status)) tasks.push(task);
  }
  return tasks.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export async function advanceResearchTask(ctx: ResearchContext, input: {
  taskId: string; expectedVersion?: number;
}): Promise<ResearchTask> {
  return mutateTask(ctx, input.taskId, input.expectedVersion, async (task, paths) => {
    if (task.status === 'cancelled') return task;
    if (task.status === 'ready') {
      try { verifyHandoff(ctx, task, paths); }
      catch (error) {
        task.scientificOutcome.status = 'review_required';
        attention(task, 'integrity', `Research handoff artifacts no longer match the verified run: ${errorMessage(error)}`, ['amend_query']);
        saveTask(task, paths);
      }
      return task;
    }
    if (task.attention.some((item) => item.status === 'open' && item.kind !== 'execution_unknown')) return task;
    const active = latestAssignment(task);
    if (active !== undefined && !active.consumed) {
      const outcome = observeAssignment(ctx, task, paths, active);
      if (outcome === 'running' || outcome === 'waiting') return task;
      if (task.stage === 'handoff' || task.attention.some((item) => item.status === 'open')) return task;
    }
    if (task.attention.some((item) => item.status === 'open')) return task;
    try {
      verifyRevision(task, paths);
      for (const previous of task.assignments.filter((entry) => entry.consumed && entry.status === 'succeeded' && entry.queryRevision === currentRevision(task).revision)) {
        const job = getJob(ctx.jobsRoot, previous.jobId);
        if (job === undefined || job.status !== 'succeeded') throw new Error('A previously consumed stage no longer has a verified successful job.');
        verifiedOutput(ctx, paths, job, previous);
      }
    }
    catch (error) {
      attention(task, 'integrity', errorMessage(error), []);
      return saveTask(task, paths);
    }
    if (!(await ensureReady(ctx, task, paths))) return task;
    if (task.stage === 'readiness') task.stage = 'assessment';
    if (task.stage === 'handoff') return task;
    if (task.assignments.length >= task.mandate.maxJobs) {
      attention(task, 'budget_exhausted', 'The frozen job budget is exhausted. Create a separately authorized research task to expand scope.', []);
      return saveTask(task, paths);
    }
    try { await launchAssignment(ctx, task, paths, task.stage); }
    catch (error) {
      attention(task, 'integrity', errorMessage(error), ['amend_query']);
      saveTask(task, paths);
    }
    return task;
  });
}

export async function respondResearchTask(ctx: ResearchContext, input: {
  taskId: string; attentionId: string; expectedVersion: number; action: ResearchResponse;
  queryFile?: string; reason: string;
}): Promise<ResearchTask> {
  const reason = text(input.reason, 'reason', 4_000);
  integer(input.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
  return mutateTask(ctx, input.taskId, input.expectedVersion, async (task, paths) => {
    if (task.status === 'ready' || task.status === 'cancelled') throw new Error('A closed research task cannot accept responses.');
    const item = task.attention.find((entry) => entry.id === input.attentionId && entry.status === 'open');
    if (item === undefined) throw new Error('Unknown or resolved research attention id.');
    if (!item.allowedActions.includes(input.action)) throw new Error(`Action ${input.action} is not allowed for this attention item.`);
    const latest = latestAssignment(task);
    const job = latest === undefined ? undefined : getJob(ctx.jobsRoot, latest.jobId);
    if (job?.status === 'running' || job?.status === 'unknown' || (latest !== undefined && !latest.consumed && !latest.notStarted && job === undefined)) {
      throw new Error('The original job is active or its terminal state is unknown; do not revise or resubmit it.');
    }
    if (input.action !== 'amend_query') verifyRevision(task, paths);
    if (input.action === 'amend_query') {
      if (input.queryFile === undefined) throw new Error('amend_query requires queryFile.');
      if (task.queryRevisions.length >= MAX_REVISIONS) throw new Error('The research query revision limit is exhausted.');
      const query = readJson(resolveInput(input.queryFile, task.mandate.workDir), MAX_QUERY_BYTES);
      validateQuery(query);
      const revision = task.queryRevisions.length + 1;
      const queryPath = path.join(paths.artifacts, `query-${String(revision)}.json`);
      atomicWriteJson(queryPath, query);
      task.queryRevisions.push({ revision, path: queryPath, sha256: fileHash(queryPath, MAX_QUERY_BYTES), createdAt: new Date().toISOString(), reason });
      if (latest !== undefined) latest.consumed = true;
      task.stage = 'assessment';
      task.scientificOutcome = { status: 'pending', limitations: [...LIMITATIONS] };
      for (const open of task.attention.filter((entry) => entry.status === 'open')) resolveAttention(open, input.action, reason);
    } else if (input.action === 'continue_screening') {
      if (item.kind !== 'case_information' || item.details?.['readiness'] !== 'needs_information' || item.details?.['criticalBlockers'] !== 0) {
        throw new Error('Critical case blockers cannot be waived by continue_screening.');
      }
      const revision = currentRevision(task);
      revision.conditionalScreening = { reason, authority: 'caller-declared', limitations: ['High-priority case information remains unresolved; the shortlist is conditional and cannot demonstrate target attainment.'] };
      task.scientificOutcome.status = 'conditional_screening';
      task.scientificOutcome.limitations.push(...revision.conditionalScreening.limitations);
      task.stage = 'retrieval';
      resolveAttention(item, input.action, reason);
    } else {
      if (item.kind !== 'environment_readiness' && (latest === undefined || job === undefined || !['failed', 'cancelled'].includes(job.status))) {
        throw new Error('Retry requires a confirmed failed/cancelled job or a restored runtime-readiness gate.');
      }
      if (item.kind !== 'environment_readiness' && latest !== undefined) latest.consumed = true;
      resolveAttention(item, input.action, reason);
    }
    task.status = 'open';
    event(task, 'response', `${input.action}: ${reason} (caller-declared; no independent human approval is asserted).`);
    return saveTask(task, paths);
  });
}

export async function cancelResearchTask(ctx: ResearchContext, input: {
  taskId: string; expectedVersion?: number; reason: string;
}): Promise<ResearchTask> {
  const reason = text(input.reason, 'reason', 4_000);
  return mutateTask(ctx, input.taskId, input.expectedVersion, async (task, paths) => {
    if (task.status === 'cancelled') return task;
    if (task.status === 'ready') throw new Error('A ready research task has no execution to cancel.');
    for (const assignment of task.assignments.filter((entry) => !entry.consumed)) {
      if (assignment.notStarted) { assignment.consumed = true; continue; }
      let job = getJob(ctx.jobsRoot, assignment.jobId);
      if (job?.status === 'running') {
        try { job = await cancelJob(ctx.jobsRoot, assignment.jobId); }
        catch (error) {
          attention(task, 'execution_unknown', `Cancellation was not confirmed: ${errorMessage(error)}`, []);
          return saveTask(task, paths);
        }
      }
      if (job === undefined || job.status === 'unknown' || job.status === 'running') {
        assignment.status = 'unknown';
        attention(task, 'execution_unknown', 'Cancellation cannot be confirmed for the original job. Its id is preserved; no replacement was launched.', []);
        return saveTask(task, paths);
      }
      assignment.status = job.status;
      assignment.finishedAt = job.finishedAt;
      assignment.consumed = true;
    }
    task.status = 'cancelled';
    task.scientificOutcome.status = 'cancelled';
    event(task, 'cancelled', reason);
    return saveTask(task, paths);
  });
}

async function mutateTask(ctx: ResearchContext, id: string, expectedVersion: number | undefined,
  mutate: (task: ResearchTask, paths: TaskPaths) => Promise<ResearchTask>): Promise<ResearchTask> {
  if (expectedVersion !== undefined) integer(expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
  const paths = taskPaths(ctx, id, false);
  if (!existsSync(paths.record)) throw new Error(`Unknown research task: ${id}`);
  const release = acquireLock(paths, id);
  try {
    const task = readTask(paths, ctx);
    if (task === undefined) throw new Error(`Unknown research task: ${id}`);
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new Error(`Research version conflict: expected ${String(expectedVersion)}, current ${String(task.version)}. Read the task before retrying.`);
    }
    return await mutate(task, paths);
  } finally { release(); }
}

async function ensureReady(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths): Promise<boolean> {
  try {
    const backend = resolveOpenAquaBackend(ctx.env, ctx.homeDir);
    if (backend === undefined) throw new Error('No OpenAqua backend is configured.');
    if (task.mandate.backend !== undefined && canonical(backend.command) !== canonical(task.mandate.backend.command)) {
      attention(task, 'configuration_drift', 'The backend command changed after the research mandate was frozen. Create a new task for a different backend.', []);
      saveTask(task, paths); return false;
    }
    const result = await runBackend(backend, ['health', '--json'], { cwd: task.mandate.workDir, env: ctx.env, timeoutMs: 30_000, maxOutputBytes: MAX_QUERY_BYTES });
    const health = parseObject(result.stdout);
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated || health?.['ready_for_recommendation'] !== true || health['ok'] === false) {
      throw new Error('The backend has not confirmed dependencies, knowledge assets, and non-empty indexes ready for recommendation. Restore the environment and explicitly retry; no indexes will be rebuilt automatically.');
    }
    const [versionResult, identityResult] = await Promise.all([
      runBackend(backend, ['--version'], { cwd: task.mandate.workDir, env: ctx.env, timeoutMs: 30_000, maxOutputBytes: 4_000 }),
      runBackend(backend, ['identity'], { cwd: task.mandate.workDir, env: ctx.env, timeoutMs: 30_000, maxOutputBytes: MAX_QUERY_BYTES }),
    ]);
    if (versionResult.code !== 0 || identityResult.code !== 0 || versionResult.timedOut || identityResult.timedOut || versionResult.stdoutTruncated || identityResult.stdoutTruncated || versionResult.stdout.trim() === '') throw new Error('Backend version and scientific identity could not be confirmed.');
    const identity = parseObject(identityResult.stdout);
    if (identity === undefined) throw new Error('Backend identity is not a JSON object.');
    const configuration = scientificConfiguration(identity, ctx.env);
    const version = versionResult.stdout.trim().slice(0, 1_000);
    const sha256 = hash(canonical({ command: backend.command, version, configuration }));
    if (task.mandate.backend !== undefined && task.mandate.backend.sha256 !== sha256) {
      attention(task, 'configuration_drift', 'The backend revision or non-secret scientific settings changed between stages. Preserve this run and create a new task for the changed configuration.', []);
      saveTask(task, paths); return false;
    }
    if (task.mandate.backend === undefined) {
      task.mandate.backend = { command: [...backend.command], source: backend.source, version, scientificConfiguration: configuration, sha256 };
      event(task, 'readiness', 'Confirmed runtime readiness and froze backend/scientific configuration identity.');
      saveTask(task, paths);
    }
    return true;
  } catch (error) {
    attention(task, 'environment_readiness', errorMessage(error), ['retry']);
    saveTask(task, paths); return false;
  }
}

async function launchAssignment(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths, stage: JobStage): Promise<void> {
  const frozen = task.mandate.backend;
  if (frozen === undefined) throw new Error('Research backend identity is missing.');
  verifyDependencies(ctx, task, paths);
  const revision = currentRevision(task);
  const operation = STAGE_OPERATION[stage];
  if (!task.mandate.allowedOperations.includes(operation)) throw new Error('Operation is outside the frozen research mandate.');
  const jobId = `job_${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(6).toString('hex')}`;
  const output = path.join(paths.artifacts, `${String(task.assignments.length + 1)}-${stage}.json`);
  const queryPath = revision.normalized?.path ?? revision.path;
  const args = stage === 'audit'
    ? ['audit-report', '--report-file', recommendationAssignment(task).output, '--output', output]
    : [operation, '--query-file', queryPath, '--output', output];
  if (stage === 'recommendation') args.push('--top-k', String(task.mandate.topK));
  const previous = task.assignments.findLast((entry) => entry.stage === stage && entry.queryRevision === revision.revision);
  const assignment: ResearchAssignment = { id: `assignment_${String(task.assignments.length + 1)}`, stage, jobId, status: 'launching', queryRevision: revision.revision, output, createdAt: new Date().toISOString(), retryOf: previous?.id };
  task.assignments.push(assignment);
  task.status = 'running';
  event(task, 'launch_intent', `Persisted ${stage} assignment ${assignment.id} with reserved job ${jobId}.`);
  saveTask(task, paths);
  let spawnAttempted = false;
  try {
    const backend: OpenAquaBackend = { command: frozen.command, source: frozen.source };
    const requestArgs: Record<string, unknown> = stage === 'audit'
      ? { reportFile: recommendationAssignment(task).output, output, researchTaskId: task.id, assignmentId: assignment.id, queryRevision: revision.revision }
      : { queryFile: queryPath, output, topK: stage === 'recommendation' ? task.mandate.topK : undefined, researchTaskId: task.id, assignmentId: assignment.id, queryRevision: revision.revision };
    const provenance = createEngineeringJobRequest({ toolName: STAGE_TOOL[stage], operation, backend, backendVersion: frozen.version, args: requestArgs, workDir: task.mandate.workDir, scientificConfiguration: frozen.scientificConfiguration });
    if (provenance.inputs.some((entry) => entry.kind !== 'file')) throw new Error('Research input is no longer a readable regular file.');
    const expectedInputHash = stage === 'audit' ? recommendationAssignment(task).outputSha256 : revision.normalized?.sha256 ?? revision.sha256;
    if (provenance.inputs.length !== 1 || provenance.inputs[0]?.sha256 !== expectedInputHash) throw new Error('The staged job input differs from its verified research dependency.');
    spawnAttempted = true;
    const job = startJob(ctx.jobsRoot, [...backend.command, ...args], { workDir: task.mandate.workDir, env: ctx.env, label: `research:${task.id}:${stage}`, provenance, jobId });
    assignment.status = job.status;
    assignment.requestSha256 = readJobRunManifest(ctx.jobsRoot, jobId)?.manifest?.requestSha256;
    event(task, 'submitted', `Started ${stage} as ${jobId}.`);
  } catch (error) {
    assignment.error = errorMessage(error);
    if (!spawnAttempted) {
      assignment.status = 'failed'; assignment.notStarted = true; assignment.finishedAt = new Date().toISOString();
      attention(task, 'preflight_failure', `The input preflight failed before any process launch: ${errorMessage(error)}. Correct the case using a new query revision.`, ['amend_query']);
    } else {
      assignment.status = 'unknown';
      attention(task, 'execution_unknown', `The launch could not be confirmed: ${errorMessage(error)}. Observe the reserved job; no automatic resubmission is allowed.`, []);
    }
  }
  saveTask(task, paths);
}

function observeAssignment(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths, assignment: ResearchAssignment): 'running' | 'waiting' | 'consumed' {
  if (assignment.notStarted) return 'waiting';
  const job = getJob(ctx.jobsRoot, assignment.jobId);
  if (job === undefined || job.status === 'unknown') {
    if (assignment.status === 'unknown' && task.status === 'waiting' && task.attention.some((item) => item.status === 'open' && item.kind === 'execution_unknown' && item.stage === assignment.stage)) return 'waiting';
    assignment.status = 'unknown';
    attention(task, 'execution_unknown', 'The original job has no verified terminal result. Its reserved id is preserved; this observation does not authorize a replacement job.', []);
    saveTask(task, paths); return 'waiting';
  }
  let reconciled = false;
  for (const item of task.attention.filter((entry) => entry.status === 'open' && entry.kind === 'execution_unknown' && entry.stage === assignment.stage)) {
    item.status = 'resolved'; item.resolvedAt = new Date().toISOString();
    item.reconciliation = { jobId: assignment.jobId, status: job.status, authority: 'system-observed' };
    event(task, 'observation_recovered', `Verified the original reserved job ${assignment.jobId} reached ${job.status}.`);
    reconciled = true;
  }
  if (job.status === 'running') {
    if (assignment.status !== 'running' || task.status !== 'running' || reconciled) {
      assignment.status = 'running'; task.status = 'running'; saveTask(task, paths);
    }
    return 'running';
  }
  assignment.status = job.status;
  assignment.finishedAt = job.finishedAt;
  if (job.status !== 'succeeded') {
    attention(task, 'execution_failure', `${assignment.stage} job ${job.status}; inspect its bounded log before an explicit retry.`, ['retry', 'amend_query']);
    saveTask(task, paths); return 'waiting';
  }
  try {
    verifyRevision(task, paths);
    verifyDependencies(ctx, task, paths);
    const payload = verifiedOutput(ctx, paths, job, assignment);
    if (assignment.stage !== 'audit') verifyNormalized(task, paths, payload, assignment.stage);
    assignment.consumed = true;
    if (assignment.stage === 'assessment') consumeAssessment(task, payload);
    else if (assignment.stage === 'retrieval') {
      const retrieval = payload['retrieval'];
      if (!isRecord(retrieval) || !Array.isArray(retrieval['kb_unit']) || !Array.isArray(retrieval['kb_case']) || ![...retrieval['kb_unit'], ...retrieval['kb_case']].every(isRecord)) throw new Error('Retrieval output must contain valid kb_unit and kb_case evidence arrays.');
      if (retrieval['kb_unit'].length + retrieval['kb_case'].length === 0) {
        attention(task, 'evidence_gap', 'No knowledge evidence was retrieved for this case. Refine the case or create a separately scoped study after curated evidence is available; no recommendation was launched.', ['amend_query']);
      } else task.stage = 'recommendation';
    } else if (assignment.stage === 'recommendation') {
      if (!Array.isArray(payload['recommendations']) || payload['recommendations'].length === 0) throw new Error('Recommendation output has no candidate treatment trains.');
      task.scientificOutcome.reportFile = assignment.output;
      task.stage = 'audit';
    } else consumeAudit(ctx, task, paths, assignment, payload);
    event(task, 'stage_completed', `Consumed verified ${assignment.stage} output from ${assignment.jobId}.`);
    if (task.status !== 'waiting' && task.status !== 'ready') task.status = 'open';
    saveTask(task, paths); return task.status === 'waiting' ? 'waiting' : 'consumed';
  } catch (error) {
    assignment.consumed = false;
    attention(task, 'malformed_result', errorMessage(error), ['amend_query']);
    saveTask(task, paths); return 'waiting';
  }
}

function verifiedOutput(ctx: ResearchContext, paths: TaskPaths, job: JobSnapshot, assignment: ResearchAssignment): Record<string, unknown> {
  contained(paths.artifacts, assignment.output);
  const result = readJobRunManifest(ctx.jobsRoot, job.id);
  const manifest = result?.manifest;
  if (result?.error !== undefined || manifest === undefined || manifest.result === undefined) throw new Error('A valid completion-time engineering manifest is required before consuming stage output.');
  if (manifest.jobId !== assignment.jobId || manifest.toolName !== STAGE_TOOL[assignment.stage] || manifest.parameters.values['assignmentId'] !== assignment.id || manifest.parameters.values['queryRevision'] !== assignment.queryRevision || manifest.configuredOutput !== assignment.output || manifest.result.output.path !== assignment.output || manifest.result.output.kind !== 'file' || manifest.result.output.sha256 === undefined) throw new Error('Stage output identity does not match its durable engineering manifest.');
  if (assignment.requestSha256 !== undefined && assignment.requestSha256 !== manifest.requestSha256) throw new Error('Stage request identity changed after submission.');
  const bytes = readRegular(assignment.output, MAX_JSON_BYTES);
  if (hash(bytes) !== manifest.result.output.sha256) throw new Error('Stage output differs from its completion-time fingerprint.');
  assignment.requestSha256 = manifest.requestSha256;
  assignment.outputSha256 = manifest.result.output.sha256;
  assignment.resultSha256 = manifest.result.resultSha256;
  return jsonObject(bytes);
}

function verifyNormalized(task: ResearchTask, paths: TaskPaths, payload: Record<string, unknown>, stage: JobStage): void {
  const normalized = payload['normalized_query'];
  if (!isRecord(normalized)) throw new Error('Stage output has no normalized_query object.');
  const scientificSha256 = hash(canonical(scientificQuery(normalized)));
  const revision = currentRevision(task);
  if (stage === 'assessment') {
    const declared = readJson(revision.path, MAX_QUERY_BYTES);
    for (const field of ['water_quality', 'treatment_targets', 'constraints']) {
      if (isRecord(declared[field]) && !containsDeclared(normalized[field], declared[field])) throw new Error(`Case normalization changed declared ${field} values or reporting metadata.`);
    }
    const normalizedPath = path.join(paths.artifacts, `normalized-${String(revision.revision)}.json`);
    const frozen = { ...declared, ...normalized };
    atomicWriteJson(normalizedPath, frozen);
    revision.normalized = { path: normalizedPath, sha256: fileHash(normalizedPath, MAX_QUERY_BYTES), scientificSha256 };
  } else if (revision.normalized === undefined || revision.normalized.scientificSha256 !== scientificSha256) {
    throw new Error('Scientific query normalization drifted from the assessed case; no later stage is authorized.');
  }
}

function consumeAssessment(task: ResearchTask, payload: Record<string, unknown>): void {
  const readiness = payload['decision_readiness'];
  if (!isRecord(readiness) || !['blocked', 'needs_information', 'ready_for_screening'].includes(String(readiness['status'])) || !Array.isArray(readiness['critical_blockers']) || !Array.isArray(readiness['information_actions'])) throw new Error('Case assessment has no valid scientific readiness decision.');
  const actions = readiness['information_actions'];
  const blockers = readiness['critical_blockers'];
  if (!actions.every((action: unknown) => isRecord(action) && ['critical', 'high', 'medium'].includes(String(action['priority'])) && typeof action['field'] === 'string' && action['field'].trim() !== '')) throw new Error('Case information actions contain an unknown priority or missing field.');
  const criticalActions = actions.filter((action) => isRecord(action) && action['priority'] === 'critical');
  const high = actions.filter((action) => isRecord(action) && action['priority'] === 'high').length;
  if (blockers.length !== criticalActions.length || !blockers.every((blocker: unknown) => isRecord(blocker) && blocker['priority'] === 'critical' && criticalActions.some((action) => canonical(action) === canonical(blocker)))) throw new Error('Case readiness critical blockers do not match its prioritized information actions.');
  const expectedStatus = criticalActions.length > 0 ? 'blocked' : high > 0 ? 'needs_information' : 'ready_for_screening';
  if (readiness['status'] !== expectedStatus) throw new Error('Case readiness status contradicts its critical or high-priority information actions.');
  const summary = readiness['summary'];
  if (summary !== undefined && (!isRecord(summary) || summary['critical'] !== criticalActions.length || summary['high'] !== high || summary['medium'] !== actions.length - criticalActions.length - high)) throw new Error('Case readiness summary contradicts its prioritized information actions.');
  const critical = readiness['critical_blockers'].length;
  if (critical > 0 || readiness['status'] === 'blocked') {
    task.scientificOutcome.status = 'blocked';
    attention(task, 'case_information', 'Critical case information must be corrected before treatment recommendation.', ['amend_query'], { readiness: 'blocked', criticalBlockers: critical, actions: boundedJson(readiness['information_actions']) });
  } else if (readiness['status'] === 'needs_information') {
    attention(task, 'case_information', 'High-priority case information is missing. Amend the case, or explicitly request conditional screening with the gaps retained.', ['amend_query', 'continue_screening'], { readiness: 'needs_information', criticalBlockers: 0, actions: boundedJson(readiness['information_actions']) });
  } else task.stage = 'retrieval';
}

function consumeAudit(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths, assignment: ResearchAssignment, payload: Record<string, unknown>): void {
  const status = payload['status'];
  if (!['pass', 'warn', 'fail'].includes(String(status)) || payload['kind'] !== 'openaqua.claim-evidence-audit' || payload['schema_version'] !== 1 || !isRecord(payload['summary']) || !Array.isArray(payload['issues']) || !Array.isArray(payload['claim_ledger']) || !Array.isArray(payload['recommendations']) || !isRecord(payload['report'])) throw new Error('Scientific audit output does not match the claim-evidence audit contract.');
  const summary = payload['summary'];
  const recommendation = recommendationAssignment(task);
  if (!Number.isSafeInteger(summary['recommendations']) || (summary['recommendations'] as number) <= 0 || summary['recommendations'] !== payload['recommendations'].length || payload['report']['path'] !== recommendation.output) throw new Error('Scientific audit recommendation count or report identity is inconsistent.');
  assertAuditCoverage(payload, verifiedRecommendation(ctx, task, paths));
  const issues = payload['issues'];
  if (!issues.every((issue: unknown) => isRecord(issue) && ['critical', 'warning'].includes(String(issue['severity'])))) throw new Error('Scientific audit issues have an unknown severity.');
  const critical = issues.filter((issue) => isRecord(issue) && issue['severity'] === 'critical').length;
  const warnings = issues.filter((issue) => isRecord(issue) && issue['severity'] === 'warning').length;
  const expectedStatus = critical > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  if (summary['critical_issues'] !== critical || summary['warnings'] !== warnings || status !== expectedStatus || (status === 'pass' && (payload['claim_ledger'].length === 0 || summary['claims'] !== payload['claim_ledger'].length))) throw new Error('Scientific audit status, issue counts, or claim ledger are inconsistent.');
  task.scientificOutcome.auditStatus = status as 'pass' | 'warn' | 'fail';
  task.scientificOutcome.auditFile = assignment.output;
  if (status !== 'pass' || payload['issues'].length > 0 || payload['summary']['critical_issues'] !== 0 || payload['summary']['warnings'] !== 0) {
    task.scientificOutcome.status = 'review_required';
    attention(task, 'scientific_review', 'The audit requires scientific review. Successful process execution does not establish a scientifically supported recommendation.', ['amend_query'], { auditStatus: String(status), issues: boundedJson(payload['issues']) });
  } else {
    task.stage = 'handoff'; task.status = 'ready';
    task.scientificOutcome.status = currentRevision(task).conditionalScreening === undefined ? 'screening_ready' : 'conditional_screening';
    event(task, 'handoff_ready', 'Verified screening artifacts are ready for research handoff; this is not site-specific compliance or performance validation.');
  }
}

function scientificConfiguration(identity: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, JsonValue> {
  const fields: Record<string, string[]> = {
    models: ['openrouter_configured', 'default_model', 'planner_model', 'explanation_model', 'llm_temperature', 'llm_max_tokens'],
    retrieval: ['top_k_retrieval', 'top_k_rerank', 'bm25_weight', 'embedding_weight', 'embedding_model'],
    planning: ['top_k_recommendations', 'max_planning_candidates', 'max_critic_iterations'],
  };
  const result: Record<string, JsonValue> = {};
  for (const name of ['adapter_version', 'backend_revision', 'python']) {
    const value = identity[name];
    if (typeof value === 'string' || typeof value === 'number') result[name] = value;
  }
  for (const [section, keys] of Object.entries(fields)) {
    const source = identity[section];
    if (!isRecord(source)) continue;
    const selected: Record<string, JsonValue> = {};
    for (const key of keys) {
      const value = source[key];
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) selected[key] = value;
    }
    result[section] = selected;
  }
  const overrides: Record<string, JsonValue> = {};
  for (const key of ['OPENAQUA_OPENROUTER_MODEL', 'OPENAQUA_DEFAULT_MODEL', 'OPENAQUA_PLANNER_MODEL', 'OPENAQUA_EXPLANATION_MODEL', 'DEFAULT_MODEL', 'PLANNER_MODEL', 'EXPLANATION_MODEL', 'LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'TOP_K_RETRIEVAL', 'TOP_K_RERANK', 'BM25_WEIGHT', 'EMBEDDING_WEIGHT', 'EMBEDDING_MODEL', 'TOP_K_RECOMMENDATIONS', 'MAX_PLANNING_CANDIDATES', 'MAX_CRITIC_ITERATIONS']) {
    if (env[key] !== undefined) overrides[key] = env[key].slice(0, 4_000);
  }
  result['environment_overrides'] = overrides;
  return result;
}

function taskPaths(ctx: ResearchContext, id: string, create: boolean): TaskPaths {
  if (!TASK_ID.test(id)) throw new Error('Invalid research task id.');
  const jobs = path.resolve(ctx.jobsRoot);
  const root = path.join(jobs, 'research');
  if (create) { mkdirSync(jobs, { recursive: true, mode: 0o700 }); regularDirectory(jobs); privateDirectory(root); }
  if (existsSync(jobs)) regularDirectory(jobs);
  if (existsSync(root)) regularDirectory(root);
  const dir = path.join(root, id);
  if (existsSync(dir)) regularDirectory(dir);
  return { root, dir, record: path.join(dir, 'task.json'), artifacts: path.join(dir, 'artifacts') };
}

function acquireLock(paths: TaskPaths, id: string): () => void {
  const locks = path.join(paths.root, '.locks');
  privateDirectory(locks);
  const file = path.join(locks, `${id}.sqlite`);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Research lock is not a regular file.');
  }
  const database = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  } catch (error) {
    database.close();
    throw new Error(`Research task is locked by another operation; read its state and retry after that operation finishes. ${errorMessage(error)}`, { cause: error });
  }
  return () => { try { database.exec('ROLLBACK'); } finally { database.close(); } };
}

function readTask(paths: TaskPaths, ctx: ResearchContext, allowForeignWorkspace = false): ResearchTask | undefined {
  if (!existsSync(paths.record)) return undefined;
  const value = readJson(paths.record, MAX_JSON_BYTES);
  if (value['kind'] !== 'openaqua.research-task' || value['schemaVersion'] !== 1 || value['id'] !== path.basename(paths.dir) || !Number.isSafeInteger(value['version']) || (value['version'] as number) < 1 || !isRecord(value['mandate']) || !Array.isArray(value['queryRevisions']) || !Array.isArray(value['assignments']) || !Array.isArray(value['attention']) || !Array.isArray(value['events'])) throw new Error('Research task does not match its versioned storage contract.');
  const task = value as unknown as ResearchTask;
  if (!['open', 'running', 'waiting', 'ready', 'cancelled'].includes(task.status) || !['readiness', 'assessment', 'retrieval', 'recommendation', 'audit', 'handoff'].includes(task.stage) || !Number.isSafeInteger(task.eventCount) || task.eventCount < task.events.length || !isRecord(task.scientificOutcome)) throw new Error('Research lifecycle or event history is malformed.');
  if (task.mandate.jobsRoot !== path.resolve(ctx.jobsRoot)) throw new Error('Research task belongs to a different frozen job store.');
  if (task.mandate.workDir !== currentWorkDir(ctx)) {
    if (allowForeignWorkspace) return undefined;
    throw new Error('Research task belongs to a different frozen workspace.');
  }
  if (task.mandate.outputDir !== paths.artifacts || canonical(task.mandate.allowedOperations) !== canonical(OPERATIONS)) throw new Error('Research mandate paths or allowed operations were modified.');
  integer(task.mandate.maxJobs, 'stored maxJobs', 1, 16);
  integer(task.mandate.topK, 'stored topK', 1, 10);
  if (task.requestSha256 !== hash(canonical({ requestId: task.requestId, objective: task.objective, workDir: task.mandate.workDir, topK: task.mandate.topK, maxJobs: task.mandate.maxJobs, initialQuerySha256: task.mandate.initialQuerySha256 }))) throw new Error('The frozen research mandate fingerprint does not match its contents.');
  if (task.mandate.backend !== undefined) {
    const backend = task.mandate.backend;
    if (!Array.isArray(backend.command) || backend.command.length === 0 || !backend.command.every((part) => typeof part === 'string' && part !== '') || typeof backend.version !== 'string' || !isRecord(backend.scientificConfiguration) || backend.sha256 !== hash(canonical({ command: backend.command, version: backend.version, configuration: backend.scientificConfiguration }))) throw new Error('The frozen backend configuration identity was modified.');
  }
  if (task.queryRevisions.length === 0 || task.queryRevisions.length > MAX_REVISIONS || task.assignments.length > task.mandate.maxJobs || task.events.length > MAX_EVENTS || task.attention.length > 64) throw new Error('Research record exceeds its frozen bounds.');
  for (const assignment of task.assignments) {
    if (!JOB_ID.test(assignment.jobId) || !['assessment', 'retrieval', 'recommendation', 'audit'].includes(assignment.stage)) throw new Error('Invalid stored research assignment.');
    contained(paths.artifacts, assignment.output);
  }
  const first = task.queryRevisions[0]!;
  contained(paths.artifacts, first.path);
  if (fileHash(first.path, MAX_QUERY_BYTES) !== first.sha256 || hash(canonical(readJson(first.path, MAX_QUERY_BYTES))) !== task.mandate.initialQuerySha256) throw new Error('The original research query no longer matches the frozen mandate.');
  return task;
}

function verifyDependencies(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths): void {
  for (const previous of task.assignments.filter((entry) => entry.consumed && entry.status === 'succeeded' && entry.queryRevision === currentRevision(task).revision)) {
    const job = getJob(ctx.jobsRoot, previous.jobId);
    if (job === undefined || job.status !== 'succeeded') throw new Error('A previously consumed stage no longer has a verified successful job.');
    verifiedOutput(ctx, paths, job, previous);
  }
}

function verifyReadyTask(task: ResearchTask): void {
  const revision = currentRevision(task).revision;
  const completed = task.assignments.filter((entry) => entry.queryRevision === revision && entry.status === 'succeeded' && entry.consumed);
  const audit = completed.findLast((entry) => entry.stage === 'audit');
  if (task.stage !== 'handoff' || task.scientificOutcome.auditStatus !== 'pass' || audit === undefined || task.scientificOutcome.auditFile !== audit.output || !['assessment', 'retrieval', 'recommendation', 'audit'].every((stage) => completed.some((entry) => entry.stage === stage)) || task.scientificOutcome.reportFile !== recommendationAssignment(task).output) throw new Error('Research readiness has no complete verified stage and audit lineage for the current query revision.');
}

function verifyHandoff(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths): void {
  verifyReadyTask(task);
  verifyRevision(task, paths);
  verifyDependencies(ctx, task, paths);
  const assignment = task.assignments.findLast((entry) => entry.stage === 'audit' && entry.queryRevision === currentRevision(task).revision)!;
  const job = getJob(ctx.jobsRoot, assignment.jobId);
  if (job === undefined) throw new Error('Research handoff audit job is missing.');
  const audit = verifiedOutput(ctx, paths, job, assignment);
  if (audit['status'] !== 'pass') throw new Error('Research handoff audit did not pass.');
  assertAuditCoverage(audit, verifiedRecommendation(ctx, task, paths));
}

function verifiedRecommendation(ctx: ResearchContext, task: ResearchTask, paths: TaskPaths): Record<string, unknown> {
  const assignment = recommendationAssignment(task);
  const job = getJob(ctx.jobsRoot, assignment.jobId);
  if (job === undefined || job.status !== 'succeeded') throw new Error('The recommendation has no verified successful job.');
  return verifiedOutput(ctx, paths, job, assignment);
}

function assertAuditCoverage(audit: Record<string, unknown>, report: Record<string, unknown>): void {
  const recommendations = report['recommendations'];
  const reviewed = audit['recommendations'];
  const ledger = audit['claim_ledger'];
  if (!Array.isArray(recommendations) || !Array.isArray(reviewed) || !Array.isArray(ledger) || recommendations.length === 0 || reviewed.length !== recommendations.length) throw new Error('The scientific audit does not cover every recommendation in its verified source report.');
  const chains = new Map<string, number>();
  for (const [index, recommendation] of recommendations.entries()) {
    if (!isRecord(recommendation) || typeof recommendation['chain_id'] !== 'string' || recommendation['chain_id'].trim() === '' || chains.has(recommendation['chain_id'])) throw new Error('The source report requires unique nonempty chain identifiers for a complete scientific audit.');
    chains.set(recommendation['chain_id'], index + 1);
  }
  const seen = new Set<string>();
  for (const item of reviewed) {
    if (!isRecord(item) || typeof item['chain_id'] !== 'string' || !chains.has(item['chain_id']) || seen.has(item['chain_id']) || !['pass', 'warn', 'fail'].includes(String(item['status'])) || (item['index'] !== undefined && item['index'] !== chains.get(item['chain_id']))) throw new Error('Scientific audit chain identifiers do not match its source recommendations one-to-one.');
    if (audit['status'] === 'pass' && item['status'] !== 'pass') throw new Error('The scientific audit declares a pass despite a failed or warning recommendation review.');
    seen.add(item['chain_id']);
  }
  for (const claim of ledger) {
    if (!isRecord(claim) || typeof claim['chain_id'] !== 'string' || !chains.has(claim['chain_id']) || (claim['recommendation_index'] !== undefined && claim['recommendation_index'] !== chains.get(claim['chain_id']))) throw new Error('The scientific claim ledger refers to a different recommendation or report.');
  }
}

function saveTask(task: ResearchTask, paths: TaskPaths): ResearchTask {
  task.version++;
  task.updatedAt = new Date().toISOString();
  const open = task.attention.filter((item) => item.status === 'open');
  task.nextAction = task.status === 'ready' ? 'Review the report, scientific audit, provenance, and limitations before research handoff.'
    : task.status === 'cancelled' ? 'Execution is cancelled; retained artifacts remain available.'
    : open.length > 0 ? `${open[0]!.message} Allowed responses: ${open[0]!.allowedActions.join(', ') || 'none; preserve this task for inspection'}.`
    : task.status === 'running' ? 'Call advance to observe the original job; do not submit a replacement while it is active.'
    : `Call advance to continue ${task.stage}.`;
  const rendered = JSON.stringify(task);
  if (Buffer.byteLength(rendered) > MAX_JSON_BYTES) throw new Error('Research state exceeds its bounded storage limit.');
  atomicWriteJson(paths.record, task);
  return task;
}

function attention(task: ResearchTask, kind: string, message: string, allowedActions: ResearchResponse[], details?: Record<string, JsonValue>): void {
  task.status = 'waiting';
  if (task.attention.some((item) => item.status === 'open' && item.kind === kind && item.stage === task.stage)) return;
  if (task.attention.length >= 64) throw new Error('Research attention history limit is exhausted.');
  task.attention.push({ id: `attention_${randomBytes(8).toString('hex')}`, kind, stage: task.stage, status: 'open', message: message.slice(0, 4_000), allowedActions, createdAt: new Date().toISOString(), details });
  event(task, 'attention', `${kind}: ${message}`);
}

function resolveAttention(item: ResearchAttention, action: ResearchResponse, reason: string): void {
  item.status = 'resolved'; item.resolvedAt = new Date().toISOString();
  item.resolution = { action, reason, authority: 'caller-declared' };
}

function event(task: ResearchTask, type: string, detail: string): void {
  task.eventCount++;
  task.events.push({ sequence: task.eventCount, at: new Date().toISOString(), type, stage: task.stage, detail: detail.slice(0, 4_000) });
  if (task.events.length > MAX_EVENTS) { task.events = task.events.slice(-MAX_EVENTS); task.eventsTruncated = true; }
}

function verifyRevision(task: ResearchTask, paths: TaskPaths): void {
  const revision = currentRevision(task);
  contained(paths.artifacts, revision.path);
  if (fileHash(revision.path, MAX_QUERY_BYTES) !== revision.sha256) throw new Error('The frozen research query snapshot was modified.');
  if (revision.normalized !== undefined) {
    contained(paths.artifacts, revision.normalized.path);
    if (fileHash(revision.normalized.path, MAX_QUERY_BYTES) !== revision.normalized.sha256) throw new Error('The frozen normalized research query was modified.');
  }
}

function currentRevision(task: ResearchTask): ResearchQueryRevision {
  const revision = task.queryRevisions.at(-1);
  if (revision === undefined) throw new Error('Research query revision is missing.');
  return revision;
}

function latestAssignment(task: ResearchTask): ResearchAssignment | undefined {
  return task.assignments.at(-1);
}

function recommendationAssignment(task: ResearchTask): ResearchAssignment {
  const revision = currentRevision(task).revision;
  const assignment = task.assignments.findLast((entry) => entry.stage === 'recommendation' && entry.queryRevision === revision && entry.status === 'succeeded' && entry.consumed);
  if (assignment === undefined) throw new Error('No verified recommendation output exists for the current case revision.');
  return assignment;
}

function readJson(file: string, maxBytes: number): Record<string, unknown> {
  return jsonObject(readRegular(file, maxBytes));
}

function jsonObject(buffer: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw new Error('Research input or output is not valid JSON.'); }
  if (!isRecord(value)) throw new Error('Research input or output must be a JSON object.');
  canonical(value);
  return value;
}

function readRegular(file: string, maxBytes: number): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Research file must be a regular file, not a symbolic link.');
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino || stat.size > maxBytes) throw new Error(`Research file must be an unchanged regular file of at most ${String(maxBytes)} bytes.`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > maxBytes) throw new Error('Research file grew beyond the supported byte limit.');
    return bytes.subarray(0, count);
  } finally { closeSync(descriptor); }
}

function fileHash(file: string, maxBytes: number): string { return hash(readRegular(file, maxBytes)); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Research JSON exceeds the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).filter(([, item]) => item !== undefined).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
  throw new Error('Research JSON contains an unsupported value.');
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseObject(value: string): Record<string, unknown> | undefined { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; } }
function boundedJson(value: unknown): JsonValue { const rendered = canonical(value); return Buffer.byteLength(rendered) <= 32_000 ? JSON.parse(rendered) as JsonValue : { truncated: true, note: 'Inspect the verified stage output for the complete issue list.' }; }
function scientificQuery(query: Record<string, unknown>): Record<string, unknown> { const result: Record<string, unknown> = {}; for (const key of SCIENCE_FIELDS) if (query[key] !== undefined && query[key] !== null) result[key] = query[key]; return result; }
function containsDeclared(actual: unknown, expected: unknown): boolean {
  if (isRecord(expected)) return isRecord(actual) && Object.entries(expected).filter(([, value]) => value !== null).every(([key, value]) => containsDeclared(actual[key], value));
  return canonical(actual) === canonical(expected);
}
function validateQuery(query: Record<string, unknown>): void {
  if (!['raw_query', 'source_water', 'water_quality', 'contaminants', 'treatment_targets', 'constraints', 'context'].some((field) => query[field] !== undefined)) throw new Error('Research query must use snake_case OpenAqua UserQuery fields.');
  for (const key of ['waterQuality', 'treatmentTargets', 'sourceWater', 'rawQuery']) if (query[key] !== undefined) throw new Error('Research query files use snake_case OpenAqua UserQuery fields.');
  for (const key of ['water_quality', 'treatment_targets', 'constraints']) if (query[key] !== undefined && query[key] !== null && !isRecord(query[key])) throw new Error(`Query ${key} must be a JSON object.`);
  if (query['contaminants'] !== undefined && (!Array.isArray(query['contaminants']) || !query['contaminants'].every((value: unknown) => typeof value === 'string'))) throw new Error('Query contaminants must be a string array.');
}
function text(value: unknown, name: string, maxLength: number): string { if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) throw new Error(`${name} must be nonempty text of at most ${String(maxLength)} characters.`); return value.trim(); }
function integer(value: number, name: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}.`); return value; }
function currentWorkDir(ctx: ResearchContext): string { const dir = resolveUserPath(ctx.env['OPENAQUA_WORKDIR'] ?? process.cwd()); if (!lstatSync(dir).isDirectory()) throw new Error('Research workspace must be a regular directory.'); return realpathSync(dir); }
function resolveInput(value: string, workDir: string): string { const input = text(value, 'queryFile', 8_192); return input === '~' || input.startsWith('~/') || input.startsWith('~\\') ? resolveUserPath(input) : path.resolve(workDir, input); }
function privateDirectory(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); regularDirectory(dir); chmodSync(dir, 0o700); }
function regularDirectory(dir: string): void { const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Research storage directory must not be a symbolic link or non-directory.'); }
function contained(root: string, file: string): void { const relative = path.relative(root, file); if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Research artifact path escapes its frozen output directory.'); regularDirectory(root); const parent = path.dirname(file); if (realpathSync(parent) !== realpathSync(root)) throw new Error('Research artifact parent must be the frozen regular output directory.'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
