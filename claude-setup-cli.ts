#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseArgs } from 'util';
import {
  createReport,
  estimateReleasedAt,
  findInstallation,
  findOfferedVersion,
  findUpdates,
  formatHookOutput,
  formatLines,
  getAppliesAt,
  getEnabledPlugins,
  getMarketplaceArgument,
  type InstalledPlugin,
  isRefreshDue,
  parseJsonOutput,
  parsePluginId,
  parseReleaseAgeDays,
  type ProjectSettings,
  type Report,
} from './claude-setup.ts';

const USAGE = `Usage: claude-setup [--hook] [--max-age <hours>]

From the root of a project, registers the Claude Code marketplaces and installs the plugins that its
.claude/settings.json declares, at project scope. Then refreshes those marketplaces: updates the plugins
of the ones declared with autoUpdate at once, and those of the others once their new version is older
than the min-release-age npm reads for the project (.npmrc).

The claude CLI rewrites .claude/settings.json in its own format: this tool puts the file back as it was.
It does nothing in CI (CI set), with CLAUDE_SETUP_SKIP set, or without the claude CLI, and never fails.
The claude CLI is the binary of the process CLAUDE_PID names, set by Claude Code in a hook, or else the
one on the PATH, whichever first answers --version as Claude Code.

Options:
  --hook             prints its report as the JSON output of a SessionStart hook, and nothing when there
                     is nothing to report
  --max-age <hours>  refreshes the marketplaces only when the last refresh is older (default: every run)
  -h, --help         prints this help`;

/**
 * The binary of the Claude Code session that started this tool, as a hook or from its Bash tool: Claude
 * Code names its process in CLAUDE_PID. Or why it cannot be found.
 */
function findSessionBinary() {
  const pid = process.env.CLAUDE_PID;
  if (!pid) {
    return { label: 'CLAUDE_PID', reason: 'not set' };
  }
  if (!/^\d+$/.test(pid)) {
    return { label: `CLAUDE_PID (${pid})`, reason: 'not a process ID' };
  }
  let path = '';
  if (process.platform === 'linux') {
    try {
      path = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // No such process, or one this user cannot read
    }
  } else {
    // On macOS, the full path of the binary: on Linux, ps would print only the first 15 characters of its name
    const ps = spawnSync('ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8' });
    path = ps.status === 0 ? ps.stdout.trim() : '';
  }
  return path ? { label: `CLAUDE_PID (${pid}: ${path})`, path } : { label: `CLAUDE_PID (${pid})`, reason: 'no such process' };
}

/**
 * Finds the claude CLI to run: the one of the Claude Code session that started this tool, as a hook,
 * even when Claude Code is only installed as an IDE extension and puts no claude on the PATH; or else the
 * claude on the PATH. CLAUDE_PID is not documented, and its process can run a binary that is not the
 * claude CLI (Node, for a Claude Code installed with npm), so each candidate must answer `--version` as
 * Claude Code does. Without one, tells why each candidate was turned down.
 */
function findClaude(): { path: string } | { rejections: string[] } {
  const candidates = [findSessionBinary(), { label: 'claude on the PATH', path: 'claude' }];
  const rejections: string[] = [];
  for (const { label, path, reason } of candidates) {
    if (!path) {
      // Said rather than skipped: a report that only mentions the PATH hides that the session's was not found
      rejections.push(`${label}: ${reason}`);
      continue;
    }
    const probe = spawnSync(path, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && probe.stdout.includes('Claude Code')) {
      return { path };
    }
    const failure = probe.error
      ? (probe.error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'not found'
        : probe.error.message
      : probe.status !== 0
        ? `--version exits with code ${probe.status}`
        : `--version answers "${probe.stdout.trim().split('\n')[0]}", not Claude Code`;
    rejections.push(`${label}: ${failure}`);
  }
  return { rejections };
}

/**
 * The claude CLI to run, that main() finds before anything runs it
 */
let claude = 'claude';

/**
 * A `claude plugin` command can clone a marketplace
 */
const CLAUDE_TIMEOUT_MS = 180_000;

interface ClaudeResult {
  output?: unknown;
  error?: string;
}

/**
 * Runs `claude <args> --json` from the project root
 */
function runClaude(root: string, args: string[]): ClaudeResult {
  const child = spawnSync(claude, [...args, '--json'], { cwd: root, encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS });
  if (child.error) {
    return { error: `claude ${args.join(' ')}: ${child.error.message}` };
  }
  const output = parseJsonOutput(child.stdout);
  const outcome = (output as { outcome?: unknown } | undefined)?.outcome;
  if (child.status !== 0 || (outcome !== undefined && outcome !== 'ok')) {
    const message = (output as { message?: unknown } | undefined)?.message;
    const reason = typeof message === 'string' ? message : child.stderr.trim() || `exit code ${child.status}`;
    return { output, error: `claude ${args.join(' ')}: ${reason}` };
  }
  return { output };
}

function asArray<T>(output: unknown) {
  return Array.isArray(output) ? (output as T[]) : [];
}

function readJson<T>(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Registers the marketplaces the project declares and that the machine does not know yet, and returns
 * the names of the marketplaces known after that
 */
function registerMarketplaces(root: string, settings: ProjectSettings, report: Report) {
  const listing = runClaude(root, ['plugin', 'marketplace', 'list']);
  if (listing.error) {
    report.failures.push(listing.error);
    return undefined;
  }
  const known = new Set(asArray<{ name: string }>(listing.output).map(({ name }) => name));
  for (const [name, { source }] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
    if (known.has(name)) {
      continue;
    }
    const argument = getMarketplaceArgument(source);
    if (!argument) {
      report.failures.push(`marketplace ${name}: source "${source.source}" not supported`);
      continue;
    }
    const added = runClaude(root, ['plugin', 'marketplace', 'add', argument, '--scope', 'project']);
    if (added.error) {
      report.failures.push(added.error);
      continue;
    }
    known.add(name);
    report.addedMarketplaces.push(name);
  }
  return known;
}

function listInstalledPlugins(root: string, report: Report) {
  const listing = runClaude(root, ['plugin', 'list']);
  if (listing.error) {
    report.failures.push(listing.error);
  }
  return asArray<InstalledPlugin>(listing.output);
}

/**
 * Installs, at project scope, the enabled plugins that no installation covers for this project
 */
function installPlugins(root: string, settings: ProjectSettings, known: Set<string>, report: Report) {
  const installedBefore = listInstalledPlugins(root, report);
  const newIds: string[] = [];
  for (const id of getEnabledPlugins(settings)) {
    if (findInstallation(installedBefore, id, root)) {
      continue;
    }
    const { marketplace } = parsePluginId(id);
    if (!known.has(marketplace)) {
      report.failures.push(`plugin ${id}: marketplace ${marketplace} is not registered`);
      continue;
    }
    const installation = runClaude(root, ['plugin', 'install', id, '--scope', 'project']);
    if (installation.error) {
      report.failures.push(installation.error);
      continue;
    }
    newIds.push(id);
  }
  if (newIds.length === 0) {
    return installedBefore;
  }
  const installedAfter = listInstalledPlugins(root, report);
  for (const id of newIds) {
    report.installed.push({ id, version: findInstallation(installedAfter, id, root)?.version });
  }
  return installedAfter;
}

/**
 * What this tool remembers between runs, in the project's node_modules/.cache
 */
interface State {
  refreshedAt?: number;
  /**
   * When each held-back version (`plugin@marketplace version`) was first seen
   */
  firstSeen?: Record<string, number>;
}

/**
 * The project's minimum release age, in days, as npm resolves it from its .npmrc files and environment,
 * or the reason npm could not tell
 */
function readReleaseAgeDays(root: string): { days: number } | { error: string } {
  const child = spawnSync('npm', ['config', 'get', 'min-release-age'], { cwd: root, encoding: 'utf8' });
  if (child.error) {
    return { error: (child.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'npm not found' : child.error.message };
  }
  if (child.status !== 0) {
    return { error: child.stderr.trim() || `exit code ${child.status}` };
  }
  return { days: parseReleaseAgeDays(child.stdout) };
}

/**
 * When the last commit of a marketplace clone was made, or undefined if git cannot tell
 */
function readLastCommittedAt(location: string) {
  const child = spawnSync('git', ['-C', location, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
  const seconds = Number(child.stdout?.trim());
  return child.status === 0 && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Updates a plugin. The change is reported from the listings around the refresh, not from this
 * command's output: see findUpdates.
 */
function update(root: string, id: string, scope: string, report: Report) {
  const result = runClaude(root, ['plugin', 'update', id, '--scope', scope]);
  if (result.error) {
    report.failures.push(result.error);
  }
}

/**
 * Refreshes the marketplaces the project declares, updates the plugins of the ones declared with
 * autoUpdate, and the plugins of the others once their new version is older than the project's
 * min-release-age. `installedBefore` lists the installations before the refresh. Returns when each
 * version still held back was first seen.
 */
function refresh(root: string, settings: ProjectSettings, known: Set<string>, installedBefore: InstalledPlugin[], state: State, now: number, report: Report) {
  const declared = settings.extraKnownMarketplaces ?? {};
  for (const name of Object.keys(declared)) {
    if (!known.has(name)) {
      continue;
    }
    const update = runClaude(root, ['plugin', 'marketplace', 'update', name]);
    if (update.error) {
      report.failures.push(update.error);
    }
  }

  const listing = runClaude(root, ['plugin', 'marketplace', 'list']);
  if (listing.error) {
    report.failures.push(listing.error);
  }
  const locations = new Map(asArray<{ name: string; installLocation?: string }>(listing.output).map(({ name, installLocation }) => [name, installLocation]));
  const installed = listInstalledPlugins(root, report);
  const justInstalled = new Set(report.installed.map(({ id }) => id));
  const releaseAge = readReleaseAgeDays(root);
  // Without the delay, the updates it covers wait rather than apply at once
  const minAgeDays = 'days' in releaseAge ? releaseAge.days : undefined;
  if ('error' in releaseAge) {
    report.failures.push(`npm config get min-release-age: ${releaseAge.error}; the updates of the marketplaces without autoUpdate are held back`);
  }
  const firstSeen: Record<string, number> = {};
  const enabledIds = getEnabledPlugins(settings);
  let hasRunUpdate = false;

  for (const id of enabledIds) {
    const installation = findInstallation(installed, id, root);
    const { name, marketplace } = parsePluginId(id);
    const declaration = declared[marketplace];
    if (!installation || !declaration || justInstalled.has(id)) {
      continue;
    }

    if (declaration.autoUpdate) {
      update(root, id, installation.scope, report);
      hasRunUpdate = true;
      continue;
    }

    const location = locations.get(marketplace);
    if (!location) {
      continue;
    }
    const catalog = readJson<Parameters<typeof findOfferedVersion>[0]>(join(location, '.claude-plugin', 'marketplace.json'));
    const offered = catalog && findOfferedVersion(catalog, name, (path) => readJson<{ version?: string }>(join(location, path, '.claude-plugin', 'plugin.json'))?.version);
    if (!offered || !installation.version || offered === installation.version) {
      continue;
    }

    const key = `${id} ${offered}`;
    const firstSeenAt = state.firstSeen?.[key] ?? now;
    if (minAgeDays !== undefined) {
      const appliesAt = getAppliesAt(estimateReleasedAt(firstSeenAt, readLastCommittedAt(location)), minAgeDays);
      if (now >= appliesAt) {
        update(root, id, installation.scope, report);
        hasRunUpdate = true;
        continue;
      }
      report.pending.push({ id, from: installation.version, to: offered, appliesOn: new Date(appliesAt).toISOString().slice(0, 10) });
    }
    firstSeen[key] = firstSeenAt;
  }

  const installedAfter = hasRunUpdate ? listInstalledPlugins(root, report) : installed;
  report.updated.push(...findUpdates(installedBefore, installedAfter, enabledIds, root));
  return firstSeen;
}

function readState(path: string) {
  return readJson<State>(path) ?? {};
}

function writeState(path: string, state: State) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // Without a state, the next run refreshes again and restarts the delays: nothing worse
  }
}

function setUp(root: string, settings: ProjectSettings, maxAgeHours: number | undefined, report: Report) {
  const known = registerMarketplaces(root, settings, report);
  if (!known) {
    return;
  }
  const installed = installPlugins(root, settings, known, report);

  const statePath = join(root, 'node_modules', '.cache', 'claude-setup', 'state.json');
  const state = readState(statePath);
  const now = Date.now();
  if (isRefreshDue(state.refreshedAt, now, maxAgeHours)) {
    const firstSeen = refresh(root, settings, known, installed, state, now, report);
    writeState(statePath, { refreshedAt: now, firstSeen });
  }
}

function print(report: Report, isHook: boolean) {
  if (isHook) {
    const output = formatHookOutput(report);
    if (output) {
      console.log(output);
    }
    return;
  }
  for (const line of formatLines(report)) {
    (line.startsWith('failed:') ? console.error : console.log)(`claude-setup: ${line}`);
  }
}

/**
 * Reports a failure that stops the run. As a hook, it goes to the session and the exit code stays 0:
 * Claude Code reads the output of a hook that succeeds only.
 */
function printFailure(message: string, isHook: boolean) {
  const report = createReport();
  report.failures.push(message);
  print(report, isHook);
}

function printUsageError(message: string, isHook: boolean) {
  if (isHook) {
    printFailure(message, true);
    return;
  }
  console.error(`claude-setup: ${message}\n\n${USAGE}`);
  process.exitCode = 1;
}

function getMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseOptions(isHook: boolean) {
  try {
    return parseArgs({
      options: {
        hook: { type: 'boolean' },
        'max-age': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    printUsageError(getMessage(error), isHook);
    return undefined;
  }
}

function main(isHook: boolean) {
  const values = parseOptions(isHook);
  if (!values) {
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const maxAgeHours = values['max-age'] === undefined ? undefined : Number(values['max-age']);
  if (maxAgeHours !== undefined && !(maxAgeHours >= 0)) {
    printUsageError('--max-age expects a number of hours', isHook);
    return;
  }
  if (process.env.CI || process.env.CLAUDE_SETUP_SKIP) {
    return;
  }

  const root = process.cwd();
  const settingsPath = join(root, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return;
  }
  const report = createReport();
  const original = readFileSync(settingsPath, 'utf8');
  try {
    const found = findClaude();
    if ('path' in found) {
      claude = found.path;
      setUp(root, JSON.parse(original) as ProjectSettings, maxAgeHours, report);
    } else if (isHook) {
      // Run by npm, on a machine without Claude Code, there is nothing to set up. A hook runs in a
      // Claude Code session: its claude CLI must be there.
      report.failures.push(`no claude CLI found (${found.rejections.join('; ')})`);
    }
  } catch (error) {
    report.failures.push(getMessage(error));
  } finally {
    if (readFileSync(settingsPath, 'utf8') !== original) {
      writeFileSync(settingsPath, original);
    }
  }
  print(report, isHook);
}

// Known before the options are parsed, so that even an error parsing them reaches the session
const isHook = process.argv.slice(2).includes('--hook');
try {
  main(isHook);
} catch (error) {
  // Never fail the npm install or the session start that runs this tool
  printFailure(getMessage(error), isHook);
}
