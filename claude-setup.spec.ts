import { describe, expect, it } from 'vitest';
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
  isRefreshDue,
  parseJsonOutput,
  parsePluginId,
  parseReleaseAgeDays,
} from './claude-setup.ts';

describe('getMarketplaceArgument', () => {
  it.each([
    [{ source: 'github', repo: 'GoogleChrome/modern-web-guidance' }, 'GoogleChrome/modern-web-guidance'],
    [{ source: 'git', url: 'git@git.example.com:a/b.git' }, 'git@git.example.com:a/b.git'],
    [{ source: 'url', url: 'https://example.com/marketplace.json' }, 'https://example.com/marketplace.json'],
    [{ source: 'directory', path: '../marketplace' }, '../marketplace'],
    [{ source: 'npm' }, undefined],
  ])('%j → %s', (source, argument) => {
    expect(getMarketplaceArgument(source)).toBe(argument);
  });
});

describe('getEnabledPlugins', () => {
  it('keeps the plugins set to true only', () => {
    expect(getEnabledPlugins({ enabledPlugins: { 'a@m': true, 'b@m': false } })).toEqual(['a@m']);
    expect(getEnabledPlugins({})).toEqual([]);
  });
});

describe('parsePluginId', () => {
  it('splits on the last @', () => {
    expect(parsePluginId('front-working-rules@jd-front-marketplace')).toEqual({
      name: 'front-working-rules',
      marketplace: 'jd-front-marketplace',
    });
    expect(parsePluginId('@scope/plugin@market')).toEqual({ name: '@scope/plugin', marketplace: 'market' });
  });
});

describe('findInstallation', () => {
  const plugins = [
    { id: 'a@m', scope: 'project', projectPath: '/other' },
    { id: 'b@m', scope: 'user' },
    { id: 'c@m', scope: 'local', projectPath: '/repo' },
  ];

  it('accepts a user installation anywhere, a project or local one in its own clone only', () => {
    expect(findInstallation(plugins, 'a@m', '/repo')).toBeUndefined();
    expect(findInstallation(plugins, 'b@m', '/repo')).toEqual(plugins[1]);
    expect(findInstallation(plugins, 'c@m', '/repo')).toEqual(plugins[2]);
  });
});

describe('findUpdates', () => {
  const before = [
    { id: 'a@m', version: '1.0.0', scope: 'project', projectPath: '/repo' },
    { id: 'b@m', version: '2.0.0', scope: 'user' },
    { id: 'c@m', version: '3.0.0', scope: 'project', projectPath: '/other' },
  ];

  it('reports the installations of the project whose version changed', () => {
    const after = [
      { id: 'a@m', version: '1.1.0', scope: 'project', projectPath: '/repo' },
      { id: 'b@m', version: '2.0.0', scope: 'user' },
      { id: 'c@m', version: '3.1.0', scope: 'project', projectPath: '/other' },
    ];

    expect(findUpdates(before, after, ['a@m', 'b@m', 'c@m'], '/repo')).toEqual([{ id: 'a@m', from: '1.0.0', to: '1.1.0' }]);
  });

  it('leaves out a plugin missing from either listing', () => {
    expect(findUpdates(before, [], ['a@m'], '/repo')).toEqual([]);
    expect(findUpdates([], before, ['a@m'], '/repo')).toEqual([]);
  });
});

describe('parseJsonOutput', () => {
  it('reads a listing that spans several lines', () => {
    expect(parseJsonOutput('[\n  {\n    "name": "m"\n  }\n]\n')).toEqual([{ name: 'm' }]);
  });

  it('reads the result line an action prints after its progress', () => {
    expect(parseJsonOutput('Cloning…\nDone\n{"outcome":"ok"}\n')).toEqual({ outcome: 'ok' });
  });

  it('returns undefined without JSON', () => {
    expect(parseJsonOutput('')).toBeUndefined();
    expect(parseJsonOutput('error: boom\n')).toBeUndefined();
  });
});

describe('isRefreshDue', () => {
  const hour = 3_600_000;

  it.each([
    [undefined, 24, true],
    [0, undefined, true],
    [0, 24, true],
    [23 * hour, 24, false],
  ])('last refresh at %s, max age %s → %s', (lastRefreshedAt, maxAgeHours, isDue) => {
    expect(isRefreshDue(lastRefreshedAt, 24 * hour, maxAgeHours)).toBe(isDue);
  });
});

describe('findOfferedVersion', () => {
  const readPluginVersion = (path: string) => (path === './plugins/a' ? '1.2.0' : undefined);

  it('takes the version of the marketplace entry first', () => {
    const marketplace = { plugins: [{ name: 'a', version: '2.0.0', source: './plugins/a' }] };

    expect(findOfferedVersion(marketplace, 'a', readPluginVersion)).toBe('2.0.0');
  });

  it('else reads the plugin.json of a relative source', () => {
    const marketplace = { plugins: [{ name: 'a', source: './plugins/a' }] };

    expect(findOfferedVersion(marketplace, 'a', readPluginVersion)).toBe('1.2.0');
  });

  it('gives up on an external source or an unknown plugin', () => {
    const marketplace = { plugins: [{ name: 'a', source: { source: 'github', repo: 'x/y' } }] };

    expect(findOfferedVersion(marketplace, 'a', readPluginVersion)).toBeUndefined();
    expect(findOfferedVersion(marketplace, 'b', readPluginVersion)).toBeUndefined();
  });
});

describe('formatLines', () => {
  it('is empty when nothing happened', () => {
    expect(formatLines(createReport())).toEqual([]);
  });

  it('asks for a reload after an install or an update', () => {
    const report = createReport();
    report.updated.push({ id: 'a@m', from: '0.1.3', to: '0.1.4' });

    expect(formatLines(report)).toEqual(['plugin updated: a@m 0.1.3 → 0.1.4', 'run /reload-plugins in a running Claude Code session, or start a new one']);
  });

  it('gives the day a held-back update applies, without asking for a reload', () => {
    const report = createReport();
    report.pending.push({ id: 'a@m', from: '1.0.0', to: '1.1.0', appliesOn: '2026-11-20' });

    expect(formatLines(report)).toEqual(['plugin update held back by min-release-age: a@m 1.0.0 → 1.1.0, applied from 2026-11-20']);
  });
});

describe('parseReleaseAgeDays', () => {
  it.each([
    ['7\n', 7],
    ['null\n', 0],
    ['', 0],
    ['-1', 0],
  ])('%j → %s', (npmOutput, days) => {
    expect(parseReleaseAgeDays(npmOutput)).toBe(days);
  });
});

describe('estimateReleasedAt', () => {
  it('takes the earlier of the first sighting and the last commit', () => {
    expect(estimateReleasedAt(100, 40)).toBe(40);
    expect(estimateReleasedAt(100, 300)).toBe(100);
    expect(estimateReleasedAt(100, undefined)).toBe(100);
  });
});

describe('getAppliesAt', () => {
  it('adds the minimum release age in days', () => {
    expect(getAppliesAt(1_000, 7)).toBe(1_000 + 7 * 86_400_000);
    expect(getAppliesAt(1_000, 0)).toBe(1_000);
  });
});

describe('formatHookOutput', () => {
  it('prints nothing when there is nothing to report', () => {
    expect(formatHookOutput(createReport())).toBeUndefined();
  });

  it('shows the news in yellow and asks Claude to pass it on', () => {
    const report = createReport();
    report.installed.push({ id: 'a@m', version: '0.1.4' });
    const output = JSON.parse(formatHookOutput(report)!);

    expect(output.systemMessage).toBe('\u001b[33mclaude-setup: plugin installed: a@m 0.1.4\n' + 'run /reload-plugins in a running Claude Code session, or start a new one\u001b[0m');
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('a@m 0.1.4');
    expect(output.hookSpecificOutput.additionalContext).toContain('/reload-plugins');
  });

  it('asks Claude to pass the failures on too', () => {
    const report = createReport();
    report.failures.push('claude plugin marketplace update m: no VPN');
    const output = JSON.parse(formatHookOutput(report)!);

    expect(output.systemMessage).toContain('failed: claude plugin marketplace update m: no VPN');
    expect(output.hookSpecificOutput.additionalContext).toContain('failed: claude plugin marketplace update m: no VPN.');
  });
});
