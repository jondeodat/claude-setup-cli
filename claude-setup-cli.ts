#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

Options:
  --hook             prints its report as the JSON output of a SessionStart hook, and nothing when there
                     is nothing to report
  --max-age <hours>  refreshes the marketplaces only when the last refresh is older (default: every run)
  -h, --help         prints this help`;

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
  const child = spawnSync('claude', [...args, '--json'], { cwd: root, encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS });
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
 * The project's minimum release age, in days, as npm resolves it from its .npmrc files and environment
 */
function readReleaseAgeDays(root: string) {
  const child = spawnSync('npm', ['config', 'get', 'min-release-age'], { cwd: root, encoding: 'utf8' });
  return child.error || child.status !== 0 ? 0 : parseReleaseAgeDays(child.stdout);
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

  const locations = new Map(asArray<{ name: string; installLocation?: string }>(runClaude(root, ['plugin', 'marketplace', 'list']).output).map(({ name, installLocation }) => [name, installLocation]));
  const installed = listInstalledPlugins(root, report);
  const justInstalled = new Set(report.installed.map(({ id }) => id));
  const minAgeDays = readReleaseAgeDays(root);
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
    const appliesAt = getAppliesAt(estimateReleasedAt(firstSeenAt, readLastCommittedAt(location)), minAgeDays);
    if (now >= appliesAt) {
      update(root, id, installation.scope, report);
      hasRunUpdate = true;
      continue;
    }
    firstSeen[key] = firstSeenAt;
    if (state.firstSeen?.[key] === undefined) {
      report.pending.push({ id, from: installation.version, to: offered, appliesOn: new Date(appliesAt).toISOString().slice(0, 10) });
    }
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

function parseOptions() {
  try {
    return parseArgs({
      options: {
        hook: { type: 'boolean' },
        'max-age': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    console.error(`claude-setup: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 1;
    return undefined;
  }
}

function main() {
  const values = parseOptions();
  if (!values) {
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const maxAgeHours = values['max-age'] === undefined ? undefined : Number(values['max-age']);
  if (maxAgeHours !== undefined && !(maxAgeHours >= 0)) {
    console.error(`claude-setup: --max-age expects a number of hours\n\n${USAGE}`);
    process.exitCode = 1;
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
  const isHook = values.hook === true;
  const report = createReport();
  const original = readFileSync(settingsPath, 'utf8');
  try {
    const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      return;
    }
    setUp(root, JSON.parse(original) as ProjectSettings, maxAgeHours, report);
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (readFileSync(settingsPath, 'utf8') !== original) {
      writeFileSync(settingsPath, original);
    }
  }
  print(report, isHook);
}

try {
  main();
} catch (error) {
  // Never fail the npm install or the session start that runs this tool
  console.error(`claude-setup: ${error instanceof Error ? error.message : String(error)}`);
}
