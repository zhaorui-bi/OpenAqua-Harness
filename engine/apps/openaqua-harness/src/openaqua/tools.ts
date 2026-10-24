import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { resolveUserPath } from '../paths';
import {
  describeBackend,
  resolveOpenAquaBackend,
  runBackend,
  type OpenAquaBackend,
  type RunResult,
} from './backend';
import {
  cancelJob,
  configuredJobOutput,
  getJob,
  jobLog,
  listJobArtifacts,
  listJobs,
  readJobLog,
  readJobRunManifest,
  startJob,
  waitForJob,
  type JobSnapshot,
  type JobStatus,
} from './jobs';
import { createEngineeringJobRequest } from './provenance';

export interface ToolContext {
  readonly homeDir?: string;
  readonly jobsRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface OpenAquaTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface OpenAquaToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

const READ_ONLY_IDEMPOTENT = new Set([
  'openaqua_status',
  'openaqua_catalog',
  'openaqua_job_list',
  'openaqua_job_status',
  'openaqua_job_manifest',
  'openaqua_job_log',
  'openaqua_job_artifacts',
]);
const READ_ONLY_OPEN_WORLD = new Set([
  'openaqua_normalize_query',
  'openaqua_assess_case',
  'openaqua_check_constraints',
]);
const IDEMPOTENT_WRITES = new Set([
  'openaqua_build_indexes',
  'openaqua_evaluate_trains',
  'openaqua_evaluate_retrieval',
  'openaqua_audit_report',
]);

export function openAquaToolAnnotations(name: string): OpenAquaToolAnnotations {
  if (READ_ONLY_IDEMPOTENT.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (READ_ONLY_OPEN_WORLD.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  if (name === 'openaqua_job_cancel') {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (IDEMPOTENT_WRITES.has(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

const PATH_NOTE =
  'File paths may be absolute or relative to OPENAQUA_WORKDIR (the agent workspace).';
const MAX_INLINE_JSON_BYTES = 24_000;

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

function backendOrError(ctx: ToolContext): OpenAquaBackend | ToolResult {
  let backend: OpenAquaBackend | undefined;
  try {
    backend = resolveOpenAquaBackend(ctx.env, ctx.homeDir);
  } catch (error) {
    return fail('OpenAqua backend configuration is invalid.', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (backend === undefined) {
    return fail('OpenAqua source checkout or adapter-compatible backend was not found.', {
      how_to_fix: [
        'Clone https://github.com/zhaorui-bi/OpenAqua and install water_treatment_agent/requirements.txt in a Python environment.',
        'Set OPENAQUA_REPO to that checkout, or run `openaqua onboard` and accept the detected repository.',
        'Alternatively set OPENAQUA_COMMAND to an adapter-compatible command as a JSON string array.',
      ],
    });
  }
  return backend;
}

function isToolResult(value: OpenAquaBackend | ToolResult): value is ToolResult {
  return Array.isArray((value as ToolResult).content);
}

const scalarExtra = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const extraRecord = z.record(z.string().min(1).max(128), scalarExtra).optional();
const finiteMeasurement = z.number().finite();
const nonEmptyPath = z.string().trim().min(1).max(8_192);
const shortText = z.string().trim().min(1).max(256);
const queryFileSchema = nonEmptyPath.describe(`JSON file containing an OpenAqua UserQuery. ${PATH_NOTE}`);

const waterQualitySchema = z
  .object({
    pH: finiteMeasurement.optional(),
    turbidity_NTU: finiteMeasurement.nonnegative().optional(),
    arsenic_ug_L: finiteMeasurement.nonnegative().optional(),
    nitrate_mg_L: finiteMeasurement.nonnegative().optional(),
    fluoride_mg_L: finiteMeasurement.nonnegative().optional(),
    toc_mg_L: finiteMeasurement.nonnegative().optional(),
    iron_mg_L: finiteMeasurement.nonnegative().optional(),
    hardness_mg_L: finiteMeasurement.nonnegative().optional(),
    e_coli_CFU_100mL: finiteMeasurement.nonnegative().optional(),
    lead_ug_L: finiteMeasurement.nonnegative().optional(),
    extra: extraRecord,
  })
  .strict();

const treatmentTargetsSchema = z
  .object({
    arsenic_ug_L: finiteMeasurement.nonnegative().optional(),
    nitrate_mg_L: finiteMeasurement.nonnegative().optional(),
    fluoride_mg_L: finiteMeasurement.nonnegative().optional(),
    turbidity_NTU: finiteMeasurement.nonnegative().optional(),
    toc_mg_L: finiteMeasurement.nonnegative().optional(),
    e_coli: z.string().trim().max(256).optional(),
    compliance_standard: z.string().trim().max(256).optional(),
    extra: extraRecord,
  })
  .strict();

const constraintsSchema = z
  .object({
    budget: z.string().trim().max(128).optional(),
    energy: z.string().trim().max(128).optional(),
    brine_disposal: z.boolean().optional(),
    operator_skill: z.string().trim().max(128).optional(),
    use_for_drinking: z.boolean().optional(),
    footprint_constraint: z.string().trim().max(512).optional(),
    chemical_dosing_allowed: z.boolean().optional(),
    extra: extraRecord,
  })
  .strict();

const QUERY_SHAPE = {
  queryFile: queryFileSchema.optional(),
  rawQuery: z.string().trim().min(1).max(8_000).optional(),
  sourceWater: z.string().trim().min(1).max(256).optional(),
  waterQuality: waterQualitySchema.optional(),
  contaminants: z.array(shortText).max(64).optional(),
  treatmentTargets: treatmentTargetsSchema.optional(),
  constraints: constraintsSchema.optional(),
  context: z.string().trim().min(1).max(8_000).optional(),
};

const waitShape = {
  wait: z
    .boolean()
    .optional()
    .describe('Wait for bounded completion. Default false returns a durable job id immediately.'),
  waitTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .optional()
    .describe('Maximum wait when wait=true (default 600000 ms; max 3600000 ms).'),
};

const jobIdSchema = z.string().regex(/^job_\d{14}_[a-z0-9]{6,16}$/);

interface QueryBuildResult {
  readonly argv: readonly string[];
  readonly error?: ToolResult;
}

function queryArguments(args: Record<string, unknown>, workDir: string): QueryBuildResult {
  const queryKeys = [
    'rawQuery',
    'sourceWater',
    'waterQuality',
    'contaminants',
    'treatmentTargets',
    'constraints',
    'context',
  ];
  const hasInline = queryKeys.some((key) => args[key] !== undefined);
  if (typeof args['queryFile'] === 'string') {
    if (hasInline) {
      return { argv: [], error: fail('Use queryFile or inline query fields, not both.') };
    }
    return { argv: ['--query-file', resolveJobPath(args['queryFile'], workDir)] };
  }
  if (!hasInline) {
    return {
      argv: [],
      error: fail('Provide queryFile or at least one inline query field.'),
    };
  }
  const query: Record<string, unknown> = {};
  if (typeof args['rawQuery'] === 'string') query['raw_query'] = args['rawQuery'];
  if (typeof args['sourceWater'] === 'string') query['source_water'] = args['sourceWater'];
  if (args['waterQuality'] !== undefined) query['water_quality'] = args['waterQuality'];
  if (args['contaminants'] !== undefined) query['contaminants'] = args['contaminants'];
  if (args['treatmentTargets'] !== undefined) query['treatment_targets'] = args['treatmentTargets'];
  if (args['constraints'] !== undefined) query['constraints'] = args['constraints'];
  if (typeof args['context'] === 'string') query['context'] = args['context'];
  const rendered = JSON.stringify(query);
  if (Buffer.byteLength(rendered) > MAX_INLINE_JSON_BYTES) {
    return {
      argv: [],
      error: fail('Inline query is too large for a portable process invocation.', {
        how_to_fix: 'Write the UserQuery JSON to a workspace file and use queryFile.',
      }),
    };
  }
  return { argv: ['--query-json', rendered] };
}

async function immediateBackendCall(
  ctx: ToolContext,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<ToolResult> {
  const backend = backendOrError(ctx);
  if (isToolResult(backend)) return backend;
  const result = await runBackend(backend, args, {
    timeoutMs,
    cwd: jobWorkDir(ctx),
    env: ctx.env,
  });
  const report = commandReport(result);
  return result.code === 0 ? ok(report) : fail('OpenAqua backend command failed.', report);
}

async function launchJob(
  ctx: ToolContext,
  argv: readonly string[],
  toolName: string,
  label: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const backend = backendOrError(ctx);
  if (isToolResult(backend)) return backend;
  const workDir = jobWorkDir(ctx);
  const command = [...backend.command, ...argv];
  const [versionProbe, identityProbe] = await Promise.all([
    runBackend(backend, ['--version'], {
      timeoutMs: 30_000,
      cwd: workDir,
      env: ctx.env,
    }),
    runBackend(backend, ['identity'], {
      timeoutMs: 30_000,
      cwd: workDir,
      env: ctx.env,
    }),
  ]);
  const backendVersion =
    versionProbe.code === 0 ? firstOutputLine(versionProbe.stdout, 1_000) : undefined;
  const scientificConfiguration = scientificConfigurationForRun(
    identityProbe.code === 0 ? parseJson(identityProbe.stdout) : undefined,
    ctx.env,
  );
  let provenance: ReturnType<typeof createEngineeringJobRequest>;
  try {
    provenance = createEngineeringJobRequest({
      toolName,
      operation: label,
      backend,
      backendVersion,
      args,
      workDir,
      scientificConfiguration,
    });
  } catch (error) {
    return fail('Could not record the engineering request.', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const unusableInputs = provenance.inputs.filter((input) => {
    if (input.kind === 'directory') return input.role !== 'benchmark';
    return ['missing', 'unreadable', 'other', 'symlink'].includes(input.kind);
  });
  if (unusableInputs.length > 0) {
    return fail('Input preflight failed; no job was launched.', {
      inputs: unusableInputs,
      how_to_fix:
        'Use readable regular JSON files for queries, predictions, and staged knowledge. Benchmark inputs must be readable directories. Symbolic links are rejected.',
    });
  }

  let job: JobSnapshot;
  try {
    job = startJob(ctx.jobsRoot, command, {
      workDir,
      env: ctx.env,
      label,
      provenance,
    });
  } catch (error) {
    return fail('Could not start the OpenAqua background job.', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (args['wait'] !== true) {
    return ok({
      status: 'started',
      job: publicJob(job),
      next: `Use openaqua_job_status(jobId="${job.id}"), openaqua_job_manifest(jobId="${job.id}"), and bounded openaqua_job_log reads. Recover it later with openaqua_job_list.`,
    });
  }

  const timeoutMs = typeof args['waitTimeoutMs'] === 'number' ? args['waitTimeoutMs'] : 600_000;
  const finished = await waitForJob(ctx.jobsRoot, job.id, timeoutMs);
  const finalJob = finished ?? job;
  const payload = { job: publicJob(finalJob), log_tail: jobLog(ctx.jobsRoot, job.id) ?? '' };
  if (finalJob.status === 'failed' || finalJob.status === 'cancelled') {
    return fail(`OpenAqua job ${finalJob.status}.`, payload);
  }
  return ok(payload);
}

function publicJob(job: JobSnapshot): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    command: job.command.join(' '),
    commandArgv: job.command,
    workDir: job.workDir,
    label: job.label,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    exitCode: job.exitCode,
    signal: job.signal,
    logPath: job.logPath,
    jobDir: job.dir,
    configuredOutput: configuredJobOutput(job),
  };
}

function jobWorkDir(ctx: ToolContext): string {
  return resolveUserPath(ctx.env['OPENAQUA_WORKDIR'] ?? process.cwd());
}

function resolveJobPath(value: string, workDir: string): string {
  const trimmed = value.trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolveUserPath(trimmed);
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(workDir, trimmed);
}

function outputPath(args: Record<string, unknown>, workDir: string, label: string): string {
  if (typeof args['output'] === 'string') return resolveJobPath(args['output'], workDir);
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  return path.join(workDir, 'openaqua-output', `${label}_${stamp}.json`);
}

function inlineJsonArgument(value: unknown, label: string): string | ToolResult {
  const rendered = JSON.stringify(value);
  if (Buffer.byteLength(rendered) > MAX_INLINE_JSON_BYTES) {
    return fail(`${label} is too large for a portable process invocation.`, {
      how_to_fix: 'Use a workspace JSON file for larger inputs.',
    });
  }
  return rendered;
}

export const OPENAQUA_TOOLS: readonly OpenAquaTool[] = [
  {
    name: 'openaqua_status',
    title: 'OpenAqua status',
    description:
      'Inspect the configured OpenAqua checkout, Python runtime, core dependencies, downloaded knowledge assets, indexes, and optional OpenRouter configuration. Run this before using the pipeline on a new machine.',
    inputSchema: {},
    async run(_args, ctx) {
      const backend = backendOrError(ctx);
      if (isToolResult(backend)) return backend;
      const [version, health] = await Promise.all([
        runBackend(backend, ['--version'], { timeoutMs: 30_000, cwd: jobWorkDir(ctx), env: ctx.env }),
        runBackend(backend, ['health', '--json'], {
          timeoutMs: 60_000,
          cwd: jobWorkDir(ctx),
          env: ctx.env,
        }),
      ]);
      const healthPayload = parseJson(health.stdout);
      return ok({
        available: version.code === 0 && health.code === 0,
        readyForRecommendation:
          isRecord(healthPayload) && healthPayload['ready_for_recommendation'] === true,
        backend: describeBackend(backend),
        version: commandReport(version),
        health: commandReport(health),
      });
    },
  },
  {
    name: 'openaqua_catalog',
    title: 'Browse OpenAqua taxonomy',
    description:
      'List or search canonical contaminant names and treatment-unit names from the configured OpenAqua knowledge assets. Use this before constructing structured queries or candidate chains.',
    inputSchema: {
      kind: z.enum(['all', 'contaminants', 'units']).optional(),
      search: z.string().trim().max(256).optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
    },
    async run(args, ctx) {
      const argv = ['catalog'];
      if (typeof args['kind'] === 'string') argv.push('--kind', args['kind']);
      if (typeof args['search'] === 'string') argv.push('--search', args['search']);
      if (typeof args['limit'] === 'number') argv.push('--limit', String(args['limit']));
      return immediateBackendCall(ctx, argv, 60_000);
    },
  },
  {
    name: 'openaqua_normalize_query',
    title: 'Normalize a water-treatment query',
    description:
      'Run OpenAqua’s parser/taxonomy stage and return the normalized source water, contaminants, targets, constraints, missing fields, assumptions, and normalization notes. Natural-language extraction uses the backend OpenRouter key when configured.',
    inputSchema: { ...QUERY_SHAPE },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const query = queryArguments(args, workDir);
      if (query.error !== undefined) return query.error;
      return immediateBackendCall(ctx, ['normalize', ...query.argv], 180_000);
    },
  },
  {
    name: 'openaqua_assess_case',
    title: 'Assess water-treatment case readiness',
    description:
      'Normalize a case into a machine-readable scientific state, identify critical blockers and decision-sensitive missing information, and return a prioritized next-information checklist. The readiness classification is deterministic screening, not a calibrated probability of treatment success or compliance.',
    inputSchema: { ...QUERY_SHAPE },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const query = queryArguments(args, workDir);
      if (query.error !== undefined) return query.error;
      return immediateBackendCall(ctx, ['assess-case', ...query.argv], 180_000);
    },
  },
  {
    name: 'openaqua_recommend',
    title: 'Recommend water-treatment trains',
    description:
      `Run OpenAqua’s complete parser → retriever → planner → critic → explainer pipeline. Returns ranked, taxonomy-constrained early-stage treatment trains with evidence, assumptions, risks, constraint reports, and uncertainty. This is decision support, not final process design. ${PATH_NOTE}`,
    inputSchema: {
      ...QUERY_SHAPE,
      topK: z.number().int().min(1).max(10).optional(),
      output: nonEmptyPath.optional().describe('Result JSON path. A timestamped workspace path is used by default.'),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const query = queryArguments(args, workDir);
      if (query.error !== undefined) return query.error;
      const output = outputPath(args, workDir, 'recommendations');
      const topK = typeof args['topK'] === 'number' ? args['topK'] : 3;
      const argv = ['recommend', ...query.argv, '--top-k', String(topK), '--output', output];
      return launchJob(ctx, argv, 'openaqua_recommend', 'recommend', { ...args, output });
    },
  },
  {
    name: 'openaqua_retrieve_evidence',
    title: 'Retrieve OpenAqua evidence',
    description:
      `Normalize a query and run OpenAqua’s hybrid BM25/token-overlap retrieval over unit-level and case-level knowledge. The backend may build missing indexes before retrieval. ${PATH_NOTE}`,
    inputSchema: {
      ...QUERY_SHAPE,
      output: nonEmptyPath.optional(),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const query = queryArguments(args, workDir);
      if (query.error !== undefined) return query.error;
      const output = outputPath(args, workDir, 'retrieval');
      return launchJob(
        ctx,
        ['retrieve', ...query.argv, '--output', output],
        'openaqua_retrieve_evidence',
        'retrieve',
        { ...args, output },
      );
    },
  },
  {
    name: 'openaqua_check_constraints',
    title: 'Check candidate treatment trains',
    description:
      'Apply OpenAqua’s taxonomy, drinking-water disinfection, brine-disposal, and energy rules to user-supplied candidate trains. The critic may return an explicit auto-revision for missing disinfection or an incompatible membrane step.',
    inputSchema: {
      ...QUERY_SHAPE,
      candidateChains: z
        .array(
          z.union([
            z.array(shortText).min(1).max(64),
            z
              .object({
                chain_id: z.string().trim().min(1).max(256).optional(),
                chain: z.array(shortText).min(1).max(64),
                key_units: z.array(shortText).max(64).optional(),
                rationale: z.string().trim().max(4_000).optional(),
                energy_intensity: z
                  .enum(['low', 'low-medium', 'medium', 'medium-high', 'high'])
                  .optional(),
                generates_brine: z.boolean().optional(),
                requires_disinfection: z.boolean().optional(),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(50),
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const query = queryArguments(args, workDir);
      if (query.error !== undefined) return query.error;
      const candidates = inlineJsonArgument(args['candidateChains'], 'candidateChains');
      if (typeof candidates !== 'string') return candidates;
      return immediateBackendCall(
        ctx,
        ['check-constraints', ...query.argv, '--candidates-json', candidates],
        180_000,
      );
    },
  },
  {
    name: 'openaqua_build_indexes',
    title: 'Build OpenAqua indexes',
    description:
      `Rebuild corpus.jsonl and the BM25 index from the downloaded OpenAqua unit-level and case-level knowledge assets. Existing generated indexes are replaced. ${PATH_NOTE}`,
    inputSchema: {
      output: nonEmptyPath.optional().describe('JSON build report path.'),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const output = outputPath(args, workDir, 'index-build');
      return launchJob(
        ctx,
        ['build-indexes', '--output', output],
        'openaqua_build_indexes',
        'build-indexes',
        { ...args, output },
      );
    },
  },
  {
    name: 'openaqua_ingest_knowledge',
    title: 'Stage OpenAqua knowledge',
    description:
      `Stage a kb_unit or kb_case JSON record under OpenAqua’s data/ingest directory and optionally rebuild the canonical indexes. OpenAqua v1 does not automatically merge staged records into its canonical TDB/case files; the result explicitly reports that curation boundary. ${PATH_NOTE}`,
    inputSchema: {
      kbType: z.enum(['kb_unit', 'kb_case']),
      dataFile: nonEmptyPath.describe('Regular JSON object file to stage.'),
      rebuild: z.boolean().optional(),
      output: nonEmptyPath.optional().describe('JSON ingestion report path.'),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const dataFile = resolveJobPath(String(args['dataFile']), workDir);
      const output = outputPath(args, workDir, 'ingest');
      const argv = [
        'ingest',
        '--kb-type',
        String(args['kbType']),
        '--data-file',
        dataFile,
        args['rebuild'] === false ? '--no-rebuild' : '--rebuild',
        '--output',
        output,
      ];
      return launchJob(ctx, argv, 'openaqua_ingest_knowledge', 'ingest', {
        ...args,
        dataFile,
        output,
      });
    },
  },
  {
    name: 'openaqua_evaluate_trains',
    title: 'Evaluate treatment-train predictions',
    description:
      `Run OpenAqua’s WContBench treatment-train metrics: macro precision, recall, F1, coverage, hit rate, and case-level acceptability. Benchmark directories come from the OpenAqua Hugging Face dataset. ${PATH_NOTE}`,
    inputSchema: {
      benchmarkDir: nonEmptyPath,
      predictions: nonEmptyPath.describe('Prediction JSON or JSONL accepted by test_openaqua.py.'),
      output: nonEmptyPath.optional(),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const benchmarkDir = resolveJobPath(String(args['benchmarkDir']), workDir);
      const predictions = resolveJobPath(String(args['predictions']), workDir);
      const output = outputPath(args, workDir, 'train-evaluation');
      return launchJob(
        ctx,
        ['evaluate-trains', '--benchmark-dir', benchmarkDir, '--predictions', predictions, '--output', output],
        'openaqua_evaluate_trains',
        'evaluate-trains',
        { ...args, benchmarkDir, predictions, output },
      );
    },
  },
  {
    name: 'openaqua_evaluate_retrieval',
    title: 'Evaluate retrieval predictions',
    description:
      `Run OpenAqua’s WContBench retrieval Precision@k, Recall@k, and Hit@k metrics against gold evidence lists. ${PATH_NOTE}`,
    inputSchema: {
      benchmarkDir: nonEmptyPath,
      predictions: nonEmptyPath.describe('Retrieval prediction JSON accepted by test_retrieval.py.'),
      kValues: z.array(z.number().int().min(1).max(1_000)).min(1).max(20).optional(),
      output: nonEmptyPath.optional(),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const benchmarkDir = resolveJobPath(String(args['benchmarkDir']), workDir);
      const predictions = resolveJobPath(String(args['predictions']), workDir);
      const output = outputPath(args, workDir, 'retrieval-evaluation');
      const values = ((args['kValues'] as number[] | undefined) ?? [1, 3, 5]);
      const k = [...new Set(values)].join(',');
      return launchJob(
        ctx,
        [
          'evaluate-retrieval',
          '--benchmark-dir',
          benchmarkDir,
          '--predictions',
          predictions,
          '--k',
          k,
          '--output',
          output,
        ],
        'openaqua_evaluate_retrieval',
        'evaluate-retrieval',
        { ...args, benchmarkDir, predictions, output, kValues: values },
      );
    },
  },
  {
    name: 'openaqua_audit_report',
    title: 'Audit an OpenAqua recommendation report',
    description:
      `Build a machine-readable claim-evidence ledger and structurally audit evidence citations, declared support types, constraint status, uncertainty, and selected quantitative-claim signals. This does not establish semantic entailment, source quality, treatment performance, safety, or compliance. ${PATH_NOTE}`,
    inputSchema: {
      reportFile: nonEmptyPath.describe('OpenAqua FinalReport JSON file to audit.'),
      output: nonEmptyPath.optional().describe('Audit JSON path. A timestamped workspace path is used by default.'),
      ...waitShape,
    },
    async run(args, ctx) {
      const workDir = jobWorkDir(ctx);
      const reportFile = resolveJobPath(String(args['reportFile']), workDir);
      const output = outputPath(args, workDir, 'claim-evidence-audit');
      return launchJob(
        ctx,
        ['audit-report', '--report-file', reportFile, '--output', output],
        'openaqua_audit_report',
        'audit-report',
        { ...args, reportFile, output },
      );
    },
  },
  {
    name: 'openaqua_job_list',
    title: 'List OpenAqua jobs',
    description: 'Recover recent durable OpenAqua jobs after a CLI, Web, or desktop session closes.',
    inputSchema: {
      status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async run(args, ctx) {
      const status = args['status'] as JobStatus | undefined;
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
      const matching = listJobs(ctx.jobsRoot).filter(
        (job) => status === undefined || job.status === status,
      );
      return ok({
        jobsRoot: ctx.jobsRoot,
        total: matching.length,
        returned: Math.min(limit, matching.length),
        jobs: matching.slice(0, limit).map(publicJob),
      });
    },
  },
  {
    name: 'openaqua_job_status',
    title: 'OpenAqua job status',
    description: 'Read lifecycle state, timestamps, duration, exit state, and output location for a job.',
    inputSchema: { jobId: jobIdSchema },
    async run(args, ctx) {
      const job = getJob(ctx.jobsRoot, String(args['jobId']));
      return job === undefined ? fail(`unknown job id: ${String(args['jobId'])}`) : ok(publicJob(job));
    },
  },
  {
    name: 'openaqua_job_manifest',
    title: 'Inspect OpenAqua run manifest',
    description:
      'Read validated parameters, backend/runtime identity, non-secret scientific model settings, input and payload fingerprints, lifecycle state, a completion-time configured-output fingerprint, and a bounded artifact inventory. Request and result identities are verified separately; neither freezes remote model behavior.',
    inputSchema: {
      jobId: jobIdSchema,
      maxEntries: z.number().int().min(1).max(1_000).optional(),
      maxDepth: z.number().int().min(0).max(8).optional(),
    },
    async run(args, ctx) {
      const jobId = String(args['jobId']);
      const job = getJob(ctx.jobsRoot, jobId);
      if (job === undefined) return fail(`unknown job id: ${jobId}`);
      const provenance = readJobRunManifest(ctx.jobsRoot, jobId);
      if (provenance?.error !== undefined) {
        return fail('OpenAqua run manifest is malformed.', {
          job: publicJob(job),
          detail: provenance.error,
        });
      }
      const artifacts = listJobArtifacts(ctx.jobsRoot, jobId, {
        maxEntries: typeof args['maxEntries'] === 'number' ? args['maxEntries'] : undefined,
        maxDepth: typeof args['maxDepth'] === 'number' ? args['maxDepth'] : undefined,
      });
      return ok({
        job: publicJob(job),
        engineeringRun: provenance?.manifest ?? null,
        artifacts,
        note:
          provenance?.manifest === undefined
            ? 'No run manifest is available for this legacy or non-engineering job.'
            : 'requestSha256 identifies the requested operation; result.resultSha256 identifies the captured configured output when present. Preserve the OpenAqua revision, dataset/index snapshot, model settings, and result files for a reproducible comparison.',
      });
    },
  },
  {
    name: 'openaqua_job_log',
    title: 'Read OpenAqua job log',
    description:
      'Read a bounded log excerpt. Omit cursor for the latest tail, use errors/events views to reduce noise, or start at cursor=0 and follow nextCursor.',
    inputSchema: {
      jobId: jobIdSchema,
      view: z.enum(['raw', 'errors', 'events']).optional(),
      cursor: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(1_000_000).optional(),
      maxLines: z.number().int().min(1).max(2_000).optional(),
      tailBytes: z.number().int().min(1).max(1_000_000).optional(),
    },
    async run(args, ctx) {
      const job = getJob(ctx.jobsRoot, String(args['jobId']));
      if (job === undefined) return fail(`unknown job id: ${String(args['jobId'])}`);
      if (args['maxBytes'] !== undefined && args['tailBytes'] !== undefined) {
        return fail('Use maxBytes or tailBytes, not both.');
      }
      const excerpt = readJobLog(ctx.jobsRoot, job.id, {
        view: args['view'] === 'errors' || args['view'] === 'events' ? args['view'] : 'raw',
        cursor: typeof args['cursor'] === 'number' ? args['cursor'] : undefined,
        maxBytes:
          typeof args['maxBytes'] === 'number'
            ? args['maxBytes']
            : typeof args['tailBytes'] === 'number'
              ? args['tailBytes']
              : undefined,
        maxLines: typeof args['maxLines'] === 'number' ? args['maxLines'] : undefined,
      });
      if (excerpt === undefined) return ok({ job: publicJob(job), log: '(no log yet)' });
      const { text, ...metadata } = excerpt;
      return ok({
        job: publicJob(job),
        log: text || '(no matching log lines in this excerpt)',
        excerpt: metadata,
        next:
          excerpt.nextCursor === undefined
            ? undefined
            : `Continue with openaqua_job_log(jobId="${job.id}", cursor=${String(excerpt.nextCursor)}).`,
      });
    },
  },
  {
    name: 'openaqua_job_artifacts',
    title: 'List OpenAqua job artifacts',
    description:
      'List bounded metadata below a job’s explicit output path. Symbolic links are reported but not followed; contents are not read.',
    inputSchema: {
      jobId: jobIdSchema,
      maxEntries: z.number().int().min(1).max(1_000).optional(),
      maxDepth: z.number().int().min(0).max(8).optional(),
    },
    async run(args, ctx) {
      const listing = listJobArtifacts(ctx.jobsRoot, String(args['jobId']), {
        maxEntries: typeof args['maxEntries'] === 'number' ? args['maxEntries'] : undefined,
        maxDepth: typeof args['maxDepth'] === 'number' ? args['maxDepth'] : undefined,
      });
      if (listing === undefined) return fail(`unknown job id: ${String(args['jobId'])}`);
      return ok({
        ...listing,
        note:
          listing.root === undefined
            ? 'This job did not declare --output; inspect its bounded log for backend-reported paths.'
            : undefined,
      });
    },
  },
  {
    name: 'openaqua_job_cancel',
    title: 'Cancel OpenAqua job',
    description:
      'Cancel a running job gracefully, then terminate its process tree forcefully after a bounded grace period if needed.',
    inputSchema: { jobId: jobIdSchema },
    async run(args, ctx) {
      try {
        const job = await cancelJob(ctx.jobsRoot, String(args['jobId']));
        return job === undefined ? fail(`unknown job id: ${String(args['jobId'])}`) : ok(publicJob(job));
      } catch (error) {
        return fail('Could not cancel the OpenAqua job.', {
          jobId: String(args['jobId']),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
];

const SCIENTIFIC_ENVIRONMENT_KEYS = [
  'OPENAQUA_OPENROUTER_MODEL',
  'OPENAQUA_DEFAULT_MODEL',
  'OPENAQUA_PLANNER_MODEL',
  'OPENAQUA_EXPLANATION_MODEL',
  'DEFAULT_MODEL',
  'PLANNER_MODEL',
  'EXPLANATION_MODEL',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'TOP_K_RETRIEVAL',
  'TOP_K_RERANK',
  'BM25_WEIGHT',
  'EMBEDDING_WEIGHT',
  'EMBEDDING_MODEL',
  'TOP_K_RECOMMENDATIONS',
  'MAX_PLANNING_CANDIDATES',
  'MAX_CRITIC_ITERATIONS',
] as const;

function scientificConfigurationForRun(
  adapterIdentity: unknown,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> | undefined {
  const configuration: Record<string, unknown> = {};
  if (isRecord(adapterIdentity)) {
    const adapterReported: Record<string, unknown> = {};
    copyConfigurationValues(adapterIdentity, adapterReported, [
      'adapter_version',
      'backend_revision',
      'python',
    ]);
    for (const [section, keys] of [
      [
        'models',
        [
          'openrouter_configured',
          'default_model',
          'planner_model',
          'explanation_model',
          'llm_temperature',
          'llm_max_tokens',
        ],
      ],
      [
        'retrieval',
        [
          'top_k_retrieval',
          'top_k_rerank',
          'bm25_weight',
          'embedding_weight',
          'embedding_model',
        ],
      ],
      [
        'planning',
        [
          'top_k_recommendations',
          'max_planning_candidates',
          'max_critic_iterations',
        ],
      ],
    ] as const) {
      const source = adapterIdentity[section];
      if (!isRecord(source)) continue;
      const selected: Record<string, unknown> = {};
      copyConfigurationValues(source, selected, keys);
      if (Object.keys(selected).length > 0) adapterReported[section] = selected;
    }
    if (Object.keys(adapterReported).length > 0) {
      configuration['adapterReported'] = adapterReported;
    }
  }

  const environmentOverrides: Record<string, string> = {};
  for (const key of SCIENTIFIC_ENVIRONMENT_KEYS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') environmentOverrides[key] = value;
  }
  if (Object.keys(environmentOverrides).length > 0) {
    configuration['environmentOverrides'] = environmentOverrides;
  }
  return Object.keys(configuration).length > 0 ? configuration : undefined;
}

function copyConfigurationValues(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      target[key] = value;
    }
  }
}

function commandReport(result: RunResult): Record<string, unknown> {
  const parsed = parseJson(result.stdout);
  return {
    ok: result.code === 0,
    exitCode: result.code,
    timedOut: result.timedOut,
    truncated: result.stdoutTruncated || result.stderrTruncated,
    error: result.spawnError,
    result: parsed ?? (result.stdout.trim() || result.stderr.trim()),
    stderr: result.code === 0 ? undefined : result.stderr.trim() || undefined,
  };
}

function firstOutputLine(text: string, maxLength: number): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value !== '');
  return line === undefined ? undefined : line.slice(0, maxLength);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
