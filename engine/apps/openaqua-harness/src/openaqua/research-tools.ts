import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import type { ResearchAction } from '../cli-args';
import { resolveUserPath } from '../paths';
import {
  advanceResearchTask,
  cancelResearchTask,
  createResearchTask,
  getResearchTask,
  listResearchTasks,
  respondResearchTask,
} from './research';
import type { OpenAquaTool, ToolContext, ToolResult } from './tools';

const taskId = z.string().regex(/^research_[a-f0-9]{24}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputPath = z.string().trim().min(1).max(8_192);
const reason = z.string().trim().min(1).max(4_000);
const MAX_INPUT_BYTES = 64 * 1024;

function defineResearchTool<Schema extends z.ZodObject>(definition: {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  execute(args: z.infer<Schema>, ctx: ToolContext): unknown;
}): OpenAquaTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.schema.shape,
    strictInput: true,
    async run(args, ctx) {
      try {
        const parsed = definition.schema.parse(args);
        const payload = await definition.execute(parsed, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (error) {
        return researchError(error);
      }
    },
  };
}

export const RESEARCH_TOOLS: readonly OpenAquaTool[] = [
  defineResearchTool({
    name: 'openaqua_research_create',
    title: 'Create a water-treatment research task',
    description:
      'Freeze a workspace query JSON and a declared objective into a durable research task without starting a backend job. Reuse requestId only for the same request. Tasks preserve input revisions, bounded job budgets, structured information needs, and scientific audit outcomes. The caller declaration is not verified human approval.',
    schema: z.object({
      requestId: z.string().trim().min(1).max(256),
      objective: z.string().trim().min(1).max(8_000),
      queryFile: inputPath.describe('Upstream snake_case UserQuery JSON; relative paths resolve from OPENAQUA_WORKDIR.'),
      topK: z.number().int().min(1).max(10).optional(),
      maxJobs: z.number().int().min(1).max(16).optional().describe('Total backend-job budget including retries and reassessments; default 4, maximum 16.'),
    }).strict(),
    execute: (args, ctx) => createResearchTask(ctx, args),
  }),
  defineResearchTool({
    name: 'openaqua_research_status',
    title: 'Read a water-treatment research task',
    description:
      'Read persisted task state, next action, attention items, assignments, events, input revisions, and scientific outcome. This does not advance work, refresh jobs, or call a model.',
    schema: z.object({ taskId }).strict(),
    execute(args, ctx) {
      const task = getResearchTask(ctx, args.taskId);
      if (task === undefined) throw new Error(`Unknown research task: ${args.taskId}`);
      return task;
    },
  }),
  defineResearchTool({
    name: 'openaqua_research_list',
    title: 'List water-treatment research tasks',
    description:
      'Read compact summaries of recent persisted research tasks without advancing work or starting jobs. Use status for the full task and event history. Returned is the number in this bounded response, not a total task count.',
    schema: z.object({
      status: z.enum(['open', 'running', 'waiting', 'ready', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    execute(args, ctx) {
      const tasks = listResearchTasks(ctx, args).map((task) => ({
        id: task.id,
        version: task.version,
        status: task.status,
        stage: task.stage,
        updatedAt: task.updatedAt,
        objective: task.objective.slice(0, 512),
        objectiveTruncated: task.objective.length > 512,
        nextAction: task.nextAction.slice(0, 1_024),
        nextActionTruncated: task.nextAction.length > 1_024,
        jobsUsed: task.assignments.length,
        maxJobs: task.mandate.maxJobs,
        currentJobId: task.assignments.at(-1)?.jobId,
        openAttention: task.attention.filter((item) => item.status === 'open').map((item) => ({
          id: item.id,
          kind: item.kind,
          stage: item.stage,
        })),
        scientificOutcome: {
          status: task.scientificOutcome.status,
          auditStatus: task.scientificOutcome.auditStatus,
        },
      }));
      return { tasks, returned: tasks.length };
    },
  }),
  defineResearchTool({
    name: 'openaqua_research_advance',
    title: 'Advance a water-treatment research task',
    description:
      'Reconcile the current durable assignment and advance one research stage when its gate allows. Reuses a running job instead of relaunching it. Case blockers or unresolved scientific audits produce attention items. No automatic index rebuild, knowledge ingestion, or external delivery is included.',
    schema: z.object({ taskId, expectedVersion: version.optional() }).strict(),
    execute: (args, ctx) => advanceResearchTask(ctx, args),
  }),
  defineResearchTool({
    name: 'openaqua_research_respond',
    title: 'Respond to a research attention item',
    description:
      'Record a caller-declared response to a named attention item against the task version. Amend the query, accept conditional screening where permitted, or request an eligible retry within budget. This is not trusted human sign-off and cannot turn an audit warning or failure into a ready result.',
    schema: z.object({
      taskId,
      attentionId: z.string().trim().min(1).max(256),
      expectedVersion: version,
      action: z.enum(['amend_query', 'continue_screening', 'retry']),
      queryFile: inputPath.optional(),
      reason,
    }).strict(),
    execute: (args, ctx) => respondResearchTask(ctx, args),
  }),
  defineResearchTool({
    name: 'openaqua_research_cancel',
    title: 'Cancel a water-treatment research task',
    description:
      'Request cancellation of a research task and stop its active job. Confirmed cancellation retains inputs, assignments, artifacts, and history, and cannot resume through advance. If the original job state cannot be confirmed, preserve it as waiting for inspection instead of claiming cancellation succeeded.',
    schema: z.object({ taskId, expectedVersion: version.optional(), reason }).strict(),
    execute: (args, ctx) => cancelResearchTask(ctx, args),
  }),
];

export interface ResearchCommandInput {
  readonly inputFile?: string;
  readonly taskId?: string;
  readonly expectedVersion?: number;
}

export async function runResearchCommand(
  action: ResearchAction,
  options: ResearchCommandInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (options.inputFile !== undefined && (options.taskId !== undefined || options.expectedVersion !== undefined)) {
      throw new Error('Use --input or --id/--expected-version, not both.');
    }
    const args = options.inputFile === undefined ? {} : readResearchInput(options.inputFile, ctx);
    if (options.taskId !== undefined) args['taskId'] = options.taskId;
    if (options.expectedVersion !== undefined) args['expectedVersion'] = options.expectedVersion;
    const tool = RESEARCH_TOOLS.find((entry) => entry.name === `openaqua_research_${action}`);
    if (tool === undefined) throw new Error(`Unknown research action: ${action}`);
    return await tool.run(args, ctx);
  } catch (error) {
    return researchError(error);
  }
}

function readResearchInput(file: string, ctx: ToolContext): Record<string, unknown> {
  const workDir = resolveUserPath(ctx.env['OPENAQUA_WORKDIR'] ?? process.cwd());
  const input = file === '~' || file.startsWith('~/') || file.startsWith('~\\')
    ? resolveUserPath(file)
    : path.resolve(workDir, file);
  const before = lstatSync(input);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Research --input must be a regular JSON file, not a symbolic link.');
  }
  const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || stat.size > MAX_INPUT_BYTES) {
      throw new Error(`Research --input must be a regular JSON file of at most ${String(MAX_INPUT_BYTES)} bytes.`);
    }
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_INPUT_BYTES) throw new Error('Research --input exceeds the JSON byte limit.');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Research --input must contain a JSON object.');
    }
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

function researchError(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
    }],
  };
}
