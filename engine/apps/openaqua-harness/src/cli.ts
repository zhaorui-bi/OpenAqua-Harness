import path from 'node:path';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline';

import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { ASCII_LOGO } from './banner';
import { CliArgumentError, parseCliInvocation } from './cli-args';
import { runDoctor, formatDoctorReport } from './doctor';
import {
  attachOpenAquaTools,
  createDefaultSession,
  createOpenAquaHarness,
  ensureOpenAquaSkillDirs,
  promptTurnToEnd,
  resolveOpenAquaHome,
} from './harness';
import { runOnboard } from './onboard';
import {
  defaultWebAssetsDir,
  findPackageRoot,
  packageVersion,
  resolveUserPath,
  skillsDir,
} from './paths';
import { runWeb } from './server';
import { runToolsList } from './toolsCmd';
import { launchTui } from './tui';

const USAGE = `OpenAqua Harness — agentic early-stage water-treatment train design powered by OpenAqua and the Kimi Code engine

Usage:
  openaqua                     launch the interactive workbench (full TUI)
  openaqua run "<prompt>"      one-shot mode: create a session, send one prompt,
                                  stream the reply to stdout, exit
  openaqua chat                  interactive REPL with one persistent session;
                                  type "quit" (or press Ctrl+C / stdin EOF) to exit
  openaqua web [options]         start the OpenAqua Harness web server + UI
                                  [--port N] [--host H] [--no-open] [--home DIR]
  openaqua doctor [options]      check the installation
                                  [--json] [--probe] [--home DIR]
  openaqua onboard [options]     guided setup: home dir, credentials import,
                                  [--yes] [--home DIR]     backend detection, MCP + skills
                                  [--openaqua-command COMMAND | --openaqua-repo DIR]
                                  [--import-from DIR]
                                  model provider (API key, no login required):
                                  [--provider kimi-coding|zai|deepseek|custom]
                                  [--api-key KEY | --api-key-env ENV] [--model NAME]
                                  [--base-url URL] [--provider-type TYPE]
  openaqua tools [--json]        list OpenAqua query, retrieval, design, evaluation,
                                  and durable-job tools exposed to the agent
                  [--home DIR]
  openaqua info [--home DIR]     version + paths
  openaqua --version             print version
  openaqua <command> --help      print this help

Environment:
  OPENAQUA_HOME     OpenAqua data directory (config.toml, credentials, mcp.json).
                     Defaults to ~/.openaqua.
  OPENAQUA_COMMAND  JSON array overriding the adapter-compatible backend command.
  OPENAQUA_REPO     OpenAqua repository checkout containing water_treatment_agent/.
  OPENAQUA_PYTHON   Optional Python interpreter for that checkout.
  OPENROUTER_API_KEY Optional key used by OpenAqua parsing/planning/explanation agents.
  OPENAQUA_WORKDIR  Default working directory for research jobs.
  OPENAQUA_JOBS_DIR Where job records + logs live (default: <cwd>/openaqua-jobs
                     of the MCP server process).
`;

let activeHarness: KimiHarness | undefined;

// Registered lazily by the run/chat paths — the TUI path must not get its
// wrapper killed by Ctrl+C (the child handles signals itself).
function registerSigintHandler(): void {
  process.once('SIGINT', () => {
    void (async () => {
      await activeHarness?.close().catch(() => undefined);
      process.exit(130);
    })();
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const invocation = parseCliInvocation(argv);

  switch (invocation.kind) {
    case 'run':
      await runOnce(invocation.prompt);
      return;
    case 'chat':
      await chatRepl();
      return;
    case 'web':
      await runWeb({
        host: invocation.host,
        port: invocation.port,
        noOpen: invocation.noOpen,
        homeDir: invocation.homeDir,
      });
      return;
    case 'doctor': {
      const report = await runDoctor({
        probe: invocation.probe,
        homeDir: invocation.homeDir,
      });
      if (invocation.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }
      if (!report.healthy) process.exitCode = 1;
      return;
    }
    case 'onboard':
      await runOnboard({
        yes: invocation.yes,
        homeDir: invocation.homeDir,
        openaquaCommand: invocation.openaquaCommand,
        openaquaRepo: invocation.openaquaRepo,
        importFrom: invocation.importFrom,
        provider: invocation.provider,
        apiKey: invocation.apiKey,
        apiKeyEnv: invocation.apiKeyEnv,
        model: invocation.model,
        baseUrl: invocation.baseUrl,
        providerType: invocation.providerType,
      });
      return;
    case 'tools':
      runToolsList(invocation.json, invocation.homeDir);
      return;
    case 'info': {
      const env =
        invocation.homeDir === undefined
          ? process.env
          : { ...process.env, OPENAQUA_HOME: invocation.homeDir };
      const homeDir = resolveOpenAquaHome(env);
      const workDir = resolveUserPath(env['OPENAQUA_WORKDIR'] ?? process.cwd());
      const jobsDir = resolveUserPath(
        env['OPENAQUA_JOBS_DIR'] ?? path.join(workDir, 'openaqua-jobs'),
      );
      process.stdout.write(
        [
          `openaqua-harness ${packageVersion()}`,
          `package: ${findPackageRoot()}`,
          `home: ${homeDir}`,
          `workdir: ${workDir}`,
          `jobs: ${jobsDir}`,
          `skills: ${skillsDir()}`,
          `web-ui: ${defaultWebAssetsDir()}`,
          '',
        ].join('\n'),
      );
      return;
    }
    case 'version':
      process.stdout.write(`${packageVersion()}\n`);
      return;
    case 'help':
      process.stdout.write(USAGE);
      return;
    case 'tui': {
      const code = await launchTui();
      if (code < 0) {
        process.stderr.write(
          'TUI bundle not built yet — run `npm run build:tui` in the OpenAqua-Harness repo once. Falling back to plain REPL chat.\n\n',
        );
        await chatRepl();
      } else {
        process.exitCode = code;
      }
    }
  }
}

async function openHarness(): Promise<{ harness: KimiHarness; session: Session }> {
  registerSigintHandler();
  const homeDir = resolveOpenAquaHome();
  const harness = createOpenAquaHarness(homeDir);
  activeHarness = harness;
  process.stderr.write(ASCII_LOGO);
  await ensureOpenAquaSkillDirs(harness);
  const session = await createDefaultSession(harness);
  try {
    await attachOpenAquaTools(session, homeDir);
  } catch (error: unknown) {
    process.stderr.write(`warning: could not attach OpenAqua MCP tools: ${String(error)}\n`);
  }
  return { harness, session };
}

async function runOnce(promptText: string): Promise<void> {
  const { harness, session } = await openHarness();
  try {
    process.stderr.write(`session: ${session.id}\n`);
    await promptTurnToEnd(session, promptText);
  } finally {
    await closeHarness(harness);
  }
}

async function chatRepl(): Promise<void> {
  const { harness, session } = await openHarness();
  let rl: Interface | undefined;
  try {
    process.stderr.write(`chat session: ${session.id} (workDir: ${session.workDir})\n`);

    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
      terminal: process.stdin.isTTY,
    });
    const promptAgain = (): void => {
      if (rl !== undefined) {
        rl.prompt();
      }
    };
    promptAgain();

    for await (const line of rl) {
      const input = line.trim();
      if (input.length === 0) {
        promptAgain();
        continue;
      }
      if (input === 'quit' || input === 'exit') {
        break;
      }
      try {
        await promptTurnToEnd(session, input);
      } catch (error: unknown) {
        process.stderr.write(`turn failed: ${String(error)}\n`);
      }
      promptAgain();
    }
  } finally {
    rl?.close();
    await closeHarness(harness);
  }
}

async function closeHarness(harness: KimiHarness): Promise<void> {
  await harness.close();
  if (activeHarness === harness) {
    activeHarness = undefined;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof CliArgumentError) {
    process.stderr.write(`\n${USAGE}`);
  } else if (
    process.env['OPENAQUA_DEBUG'] === '1' &&
    error instanceof Error &&
    error.stack !== undefined
  ) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
}
