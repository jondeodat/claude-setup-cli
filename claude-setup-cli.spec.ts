import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A stand-in for the claude CLI: it answers the `claude plugin … --json` commands from a state file,
 * records each call there, and rewrites .claude/settings.json on an add or an install, as the real
 * one does
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const statePath = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
state.calls.push(args.join(' '));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const rewriteSettings = () => {
  const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
  fs.writeFileSync('.claude/settings.json', JSON.stringify(settings));
};
const ok = (extra = {}) => console.log('progress…\\n' + JSON.stringify({ outcome: 'ok', ...extra }));
const command = args.slice(0, 3).join(' ');
if (args[0] === '--version') {
  console.log('2.1.0 (Claude Code)');
} else if (command === 'plugin marketplace list') {
  console.log(JSON.stringify(state.marketplaces, null, 2));
} else if (command === 'plugin marketplace add') {
  state.marketplaces.push({ name: state.marketplaceNames[args[3]], installLocation: '/nowhere' });
  rewriteSettings();
  ok();
} else if (command === 'plugin marketplace update') {
  // Like Claude Code when the pull brings new commits, if the test asks for it
  if (state.isUpdatedByMarketplace) {
    for (const plugin of state.installed.filter(({ id }) => id.endsWith('@' + args[3]))) {
      plugin.version = state.versions[plugin.id] ?? plugin.version;
    }
  }
  ok();
} else if (args.slice(0, 2).join(' ') === 'plugin list') {
  console.log(JSON.stringify(state.installed, null, 2));
} else if (args[1] === 'install') {
  state.installed.push({ id: args[2], version: state.versions[args[2]], scope: 'project', projectPath: process.cwd() });
  rewriteSettings();
  ok();
} else if (args[1] === 'update') {
  const plugin = state.installed.find(({ id }) => id === args[2]);
  const oldVersion = plugin.version;
  plugin.version = state.versions[args[2]] ?? oldVersion;
  ok({ oldVersion, newVersion: plugin.version });
} else {
  console.error('unexpected: ' + args.join(' '));
  process.exit(1);
}
save();
`;

const SETTINGS = `{
  "extraKnownMarketplaces": {
    "ours": { "source": { "source": "git", "url": "git@example.com:ours.git" }, "autoUpdate": true },
    "theirs": { "source": { "source": "github", "repo": "them/theirs" } }
  },
  "enabledPlugins": { "rules@ours": true, "guide@theirs": true, "off@ours": false }
}
`;

const cli = resolve(import.meta.dirname, 'claude-setup-cli.ts');

let work: string;
let project: string;
let statePath: string;

interface State {
  marketplaces: { name: string; installLocation: string }[];
  marketplaceNames: Record<string, string>;
  installed: { id: string; version?: string; scope: string; projectPath?: string }[];
  versions: Record<string, string>;
  /**
   * Whether `marketplace update` already updates the plugins of the marketplace
   */
  isUpdatedByMarketplace?: boolean;
  calls: string[];
}

function writeState(state: Partial<State>) {
  const complete: State = {
    marketplaces: [],
    marketplaceNames: { 'git@example.com:ours.git': 'ours', 'them/theirs': 'theirs' },
    installed: [],
    versions: {},
    calls: [],
    ...state,
  };
  writeFileSync(statePath, JSON.stringify(complete));
}

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8')) as State;
}

function run(args: string[] = [], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(work, 'bin')}:${process.env.PATH}`,
    FAKE_CLAUDE_STATE: statePath,
  };
  delete env.CI;
  delete env.CLAUDE_SETUP_SKIP;
  // Set when the tests run from a Claude Code session: the tool would run the real claude CLI
  delete env.CLAUDE_CODE_EXECPATH;
  // The project's .npmrc alone sets the release age of each test
  for (const name of Object.keys(env).filter((key) => key.toLowerCase() === 'npm_config_min_release_age')) {
    delete env[name];
  }
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8' });
}

const DAY_MS = 86_400_000;

/**
 * Lays out a marketplace clone, a git repository whose single commit dates from `committedDaysAgo`,
 * that offers `guide` at the given version
 */
function writeMarketplaceClone(version: string, committedDaysAgo = 0) {
  const location = join(work, 'theirs');
  mkdirSync(join(location, '.claude-plugin'), { recursive: true });
  mkdirSync(join(location, 'plugins', 'guide', '.claude-plugin'), { recursive: true });
  writeFileSync(join(location, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'guide', source: './plugins/guide' }] }));
  writeFileSync(join(location, 'plugins', 'guide', '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  const date = new Date(Date.now() - committedDaysAgo * DAY_MS).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: location, env, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'release');
  return location;
}

function setReleaseAge(days: number) {
  writeFileSync(join(project, '.npmrc'), `min-release-age=${days}\n`);
}

/**
 * The state of a marketplace without autoUpdate that offers `guide` 1.1.0 while 1.0.0 is installed
 */
function offerGuideUpdate(committedDaysAgo: number) {
  writeState({
    marketplaces: [
      { name: 'ours', installLocation: '/nowhere' },
      { name: 'theirs', installLocation: writeMarketplaceClone('1.1.0', committedDaysAgo) },
    ],
    installed: [
      { id: 'rules@ours', version: '0.1.4', scope: 'project', projectPath: project },
      { id: 'guide@theirs', version: '1.0.0', scope: 'project', projectPath: project },
    ],
    versions: { 'rules@ours': '0.1.4', 'guide@theirs': '1.1.0' },
  });
}

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'claude-setup-')));
  project = join(work, 'project');
  statePath = join(work, 'state.json');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.json'), SETTINGS);
  // Makes the project the root npm reads its .npmrc from
  writeFileSync(join(project, 'package.json'), '{}');
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin', 'claude'), FAKE_CLAUDE);
  chmodSync(join(work, 'bin', 'claude'), 0o755);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('claude-setup', () => {
  it('registers the marketplaces and installs the enabled plugins at project scope, then restores the settings', () => {
    writeState({ versions: { 'rules@ours': '0.1.4', 'guide@theirs': '1.0.0' } });

    const result = run();

    expect(result.status).toBe(0);
    const { calls } = readState();
    expect(calls).toContain('plugin marketplace add git@example.com:ours.git --scope project');
    expect(calls).toContain('plugin marketplace add them/theirs --scope project');
    expect(calls).toContain('plugin install rules@ours --scope project');
    expect(calls).toContain('plugin install guide@theirs --scope project');
    expect(calls.some((call) => call.includes('off@ours'))).toBe(false);
    expect(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).toBe(SETTINGS);
    expect(result.stdout).toContain('claude-setup: plugin installed: rules@ours 0.1.4');
    expect(result.stdout).toContain('/reload-plugins');
  });

  it('updates the plugins of a marketplace declared with autoUpdate, in the scope they were installed in', () => {
    writeState({
      marketplaces: [
        { name: 'ours', installLocation: '/nowhere' },
        { name: 'theirs', installLocation: writeMarketplaceClone('1.0.0') },
      ],
      installed: [
        { id: 'rules@ours', version: '0.1.3', scope: 'local', projectPath: project },
        { id: 'guide@theirs', version: '1.0.0', scope: 'project', projectPath: project },
      ],
      versions: { 'rules@ours': '0.1.4' },
    });

    const result = run(['--hook']);

    const { calls } = readState();
    expect(calls).toContain('plugin marketplace update ours');
    expect(calls).toContain('plugin update rules@ours --scope local');
    expect(calls.some((call) => call.startsWith('plugin update guide@theirs'))).toBe(false);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toContain('plugin updated: rules@ours 0.1.3 → 0.1.4');
    expect(output.hookSpecificOutput.additionalContext).toContain('/reload-plugins');
  });

  it('reports an update that the marketplace refresh already applied', () => {
    writeState({
      marketplaces: [{ name: 'ours', installLocation: '/nowhere' }],
      installed: [{ id: 'rules@ours', version: '0.1.4', scope: 'project', projectPath: project }],
      versions: { 'rules@ours': '0.1.5' },
      isUpdatedByMarketplace: true,
    });

    const result = run();

    expect(result.stdout).toContain('plugin updated: rules@ours 0.1.4 → 0.1.5');
    expect(result.stdout).toContain('/reload-plugins');
  });

  it('updates a plugin of a marketplace without autoUpdate once its version is older than min-release-age', () => {
    setReleaseAge(7);
    offerGuideUpdate(10);

    const result = run();

    expect(readState().calls).toContain('plugin update guide@theirs --scope project');
    expect(result.stdout).toContain('plugin updated: guide@theirs 1.0.0 → 1.1.0');
  });

  it('holds back a newer version, reports it at each refresh, and remembers when it was first seen', () => {
    setReleaseAge(7);
    offerGuideUpdate(0);
    const appliesOn = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);
    const heldBack = `plugin update held back by min-release-age: guide@theirs 1.0.0 → 1.1.0, applied from ${appliesOn}`;

    const first = run();
    const second = run(['--hook']);

    expect(readState().calls.some((call) => call.startsWith('plugin update guide@theirs'))).toBe(false);
    expect(first.stdout).toContain(heldBack);
    expect(first.stdout).not.toContain('/reload-plugins');
    const output = JSON.parse(second.stdout);
    expect(output.systemMessage).toContain(heldBack);
    expect(output.hookSpecificOutput.additionalContext).toContain(`guide@theirs 1.0.0 → 1.1.0 from ${appliesOn}`);
    const state = JSON.parse(readFileSync(join(project, 'node_modules', '.cache', 'claude-setup', 'state.json'), 'utf8'));
    expect(Object.keys(state.firstSeen)).toEqual(['guide@theirs 1.1.0']);
  });

  it('applies a version first seen long enough ago, even when the clone has a recent commit', () => {
    setReleaseAge(7);
    offerGuideUpdate(0);
    mkdirSync(join(project, 'node_modules', '.cache', 'claude-setup'), { recursive: true });
    writeFileSync(join(project, 'node_modules', '.cache', 'claude-setup', 'state.json'), JSON.stringify({ firstSeen: { 'guide@theirs 1.1.0': Date.now() - 8 * DAY_MS } }));

    run();

    expect(readState().calls).toContain('plugin update guide@theirs --scope project');
  });

  it('holds back the update and reports it when npm cannot tell the min-release-age', () => {
    offerGuideUpdate(30);
    writeFileSync(join(work, 'bin', 'npm'), '#!/bin/sh\necho "npm broke" >&2\nexit 1\n');
    chmodSync(join(work, 'bin', 'npm'), 0o755);

    const result = run(['--hook']);

    expect(readState().calls.some((call) => call.startsWith('plugin update guide@theirs'))).toBe(false);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toContain('failed: npm config get min-release-age: npm broke');
    expect(output.hookSpecificOutput.additionalContext).toContain('npm broke');
  });

  it('updates at once when npm sets no min-release-age', () => {
    offerGuideUpdate(0);

    run();

    expect(readState().calls).toContain('plugin update guide@theirs --scope project');
  });

  it('skips the refresh within --max-age, and prints nothing as a hook when all is installed', () => {
    writeState({
      marketplaces: [
        { name: 'ours', installLocation: '/nowhere' },
        { name: 'theirs', installLocation: '/nowhere' },
      ],
      installed: [
        { id: 'rules@ours', version: '0.1.4', scope: 'project', projectPath: project },
        { id: 'guide@theirs', version: '1.0.0', scope: 'user' },
      ],
    });
    mkdirSync(join(project, 'node_modules', '.cache', 'claude-setup'), { recursive: true });
    writeFileSync(join(project, 'node_modules', '.cache', 'claude-setup', 'state.json'), JSON.stringify({ refreshedAt: Date.now() }));

    const result = run(['--hook', '--max-age', '24']);

    expect(result.stdout).toBe('');
    expect(readState().calls).toEqual(['--version', 'plugin marketplace list', 'plugin list']);
  });

  it('runs the claude CLI that CLAUDE_CODE_EXECPATH names rather than the one on the PATH', () => {
    writeState({ versions: { 'rules@ours': '0.1.4', 'guide@theirs': '1.0.0' } });
    const sessionClaude = join(work, 'session', 'claude');
    mkdirSync(join(work, 'session'));
    writeFileSync(sessionClaude, FAKE_CLAUDE);
    chmodSync(sessionClaude, 0o755);
    // A claude CLI too, so that only the order of the candidates keeps it out
    writeFileSync(join(work, 'bin', 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "2.0.0 (Claude Code)" && exit 0\necho "not this one" >&2\nexit 1\n');

    const result = run([], { CLAUDE_CODE_EXECPATH: sessionClaude });

    expect(result.stderr).toBe('');
    // Only the fake claude records its calls: the probe too ran the one CLAUDE_CODE_EXECPATH names
    expect(readState().calls[0]).toBe('--version');
    expect(readState().calls).toContain('plugin install rules@ours --scope project');
    expect(result.stdout).toContain('claude-setup: plugin installed: rules@ours 0.1.4');
  });

  it('falls back to the claude CLI on the PATH when CLAUDE_CODE_EXECPATH names a missing binary', () => {
    writeState({ versions: { 'rules@ours': '0.1.4', 'guide@theirs': '1.0.0' } });

    const result = run([], { CLAUDE_CODE_EXECPATH: join(work, 'removed', 'claude') });

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('claude-setup: plugin installed: rules@ours 0.1.4');
  });

  it('falls back to the claude CLI on the PATH when CLAUDE_CODE_EXECPATH names another binary', () => {
    writeState({ versions: { 'rules@ours': '0.1.4', 'guide@theirs': '1.0.0' } });

    // Like the Node runtime: it answers --version, but not as Claude Code
    const result = run([], { CLAUDE_CODE_EXECPATH: process.execPath });

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('claude-setup: plugin installed: rules@ours 0.1.4');
  });

  it('does nothing when no candidate answers as the claude CLI', () => {
    writeState({});
    writeFileSync(join(work, 'bin', 'claude'), '#!/bin/sh\necho "v1.0.0"\n');

    const result = run([], { CLAUDE_CODE_EXECPATH: join(work, 'removed', 'claude') });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).toBe(SETTINGS);
  });

  it('reports to the session, as a hook, that no candidate answers as the claude CLI', () => {
    writeState({});
    writeFileSync(join(work, 'bin', 'claude'), '#!/bin/sh\necho "v1.0.0"\n');
    const removed = join(work, 'removed', 'claude');

    const result = run(['--hook'], { CLAUDE_CODE_EXECPATH: removed });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    const failure = `no claude CLI found (CLAUDE_CODE_EXECPATH (${removed}): not found; claude on the PATH: --version answers "v1.0.0", not Claude Code)`;
    expect(output.systemMessage).toContain(`failed: ${failure}`);
    expect(output.hookSpecificOutput.additionalContext).toContain(failure);
  });

  it('reports a wrong option to the session as a hook, without failing it', () => {
    writeState({});

    const result = run(['--hook', '--max-age', 'soon']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('--max-age expects a number of hours');
  });

  it('does nothing in CI', () => {
    writeState({});

    const result = run([], { CI: 'true' });

    expect(result.status).toBe(0);
    expect(readState().calls).toEqual([]);
  });

  it('reports a failure without failing', () => {
    writeState({ marketplaceNames: {} });
    writeFileSync(join(work, 'bin', 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "2.1.0 (Claude Code)" && exit 0\necho "no VPN" >&2\nexit 1\n');

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('claude-setup: failed: claude plugin marketplace list: no VPN');
    expect(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).toBe(SETTINGS);
  });
});
