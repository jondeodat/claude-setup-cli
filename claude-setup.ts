/**
 * The source of a marketplace, as `extraKnownMarketplaces` declares it
 */
export interface MarketplaceSource {
  source: string;
  repo?: string;
  url?: string;
  path?: string;
}

/**
 * The part of a project's `.claude/settings.json` that this tool reads
 */
export interface ProjectSettings {
  extraKnownMarketplaces?: Record<string, { source: MarketplaceSource; autoUpdate?: boolean }>;
  enabledPlugins?: Record<string, boolean>;
}

/**
 * One installation, as `claude plugin list --json` reports it
 */
export interface InstalledPlugin {
  id: string;
  version?: string;
  scope: string;
  projectPath?: string;
}

/**
 * What a run did or found, reported to the developer
 */
export interface Report {
  addedMarketplaces: string[];
  installed: { id: string; version?: string }[];
  updated: { id: string; from?: string; to?: string }[];
  /**
   * The updates held back by the release age, reported at each refresh until they apply
   */
  pending: { id: string; from?: string; to: string; appliesOn: string }[];
  failures: string[];
}

export function createReport(): Report {
  return { addedMarketplaces: [], installed: [], updated: [], pending: [], failures: [] };
}

const DAY_MS = 86_400_000;

/**
 * The minimum release age, in days, from the output of `npm config get min-release-age`: 0 when npm
 * sets none (`null`)
 */
export function parseReleaseAgeDays(npmOutput: string) {
  const days = Number(npmOutput.trim());
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * When the version a marketplace offers was released, at the latest. Its clone is shallow, so the
 * commit that introduced the version is out of reach; both the day this tool first saw the version and
 * the date of the last commit of the clone come after that release, so the earlier of the two never
 * shortens the delay.
 */
export function estimateReleasedAt(firstSeenAt: number, lastCommittedAt: number | undefined) {
  return lastCommittedAt === undefined ? firstSeenAt : Math.min(firstSeenAt, lastCommittedAt);
}

/**
 * When a version released at `releasedAt` may be applied, given the minimum release age in days
 */
export function getAppliesAt(releasedAt: number, minAgeDays: number) {
  return releasedAt + minAgeDays * DAY_MS;
}

/**
 * The argument `claude plugin marketplace add` takes for a source, or undefined for a source it cannot add
 */
export function getMarketplaceArgument(source: MarketplaceSource) {
  switch (source.source) {
    case 'github':
      return source.repo;
    case 'git':
    case 'url':
      return source.url;
    case 'directory':
    case 'file':
      return source.path;
    default:
      return undefined;
  }
}

/**
 * The ids (`plugin@marketplace`) of the plugins the project enables
 */
export function getEnabledPlugins(settings: ProjectSettings) {
  return Object.entries(settings.enabledPlugins ?? {})
    .filter(([, isEnabled]) => isEnabled === true)
    .map(([id]) => id);
}

/**
 * Splits a plugin id `plugin@marketplace` into its two names
 */
export function parsePluginId(id: string) {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' };
}

/**
 * The installation of a plugin that applies to the project at `root`: a user or managed one applies
 * everywhere, a project or local one only to the clone it was made in
 */
export function findInstallation(plugins: InstalledPlugin[], id: string, root: string) {
  return plugins.find((plugin) => plugin.id === id && (plugin.scope === 'user' || plugin.scope === 'managed' || plugin.projectPath === root));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The plugins among `ids` whose installation for the project at `root` changed version between two
 * listings. Comparing listings catches an update whichever command applied it: `claude plugin
 * marketplace update` already updates the plugins of an autoUpdate marketplace when it pulls new
 * commits, and the `plugin update` that follows then reports no change.
 */
export function findUpdates(before: InstalledPlugin[], after: InstalledPlugin[], ids: string[], root: string) {
  return ids.flatMap((id) => {
    const from = findInstallation(before, id, root)?.version;
    const to = findInstallation(after, id, root)?.version;
    return from && to && from !== to ? [{ id, from, to }] : [];
  });
}

/**
 * The JSON output of a `claude plugin … --json` command: the whole standard output for a listing, which
 * spans several lines, or else its last non-empty line, which an action prints after its progress
 */
export function parseJsonOutput(stdout: string) {
  const whole = parseJson(stdout.trim());
  if (whole !== undefined) {
    return whole;
  }
  const lastLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return lastLine ? parseJson(lastLine) : undefined;
}

/**
 * Whether the marketplaces should be refreshed: always without a maximum age, otherwise once the last
 * refresh is older than it
 */
export function isRefreshDue(lastRefreshedAt: number | undefined, now: number, maxAgeHours: number | undefined) {
  if (maxAgeHours === undefined || lastRefreshedAt === undefined) {
    return true;
  }
  return now - lastRefreshedAt >= maxAgeHours * 3_600_000;
}

/**
 * The version a marketplace offers for a plugin: the `version` of its entry in `marketplace.json`, or
 * else the one of the `plugin.json` its relative source points to. Undefined when neither gives one.
 */
export function findOfferedVersion(
  marketplace: { plugins?: { name: string; version?: string; source?: unknown }[] },
  pluginName: string,
  readPluginVersion: (relativePath: string) => string | undefined,
) {
  const entry = marketplace.plugins?.find((plugin) => plugin.name === pluginName);
  if (!entry) {
    return undefined;
  }
  if (entry.version) {
    return entry.version;
  }
  return typeof entry.source === 'string' ? readPluginVersion(entry.source) : undefined;
}

/**
 * Whether the run changed the plugins the current session loaded, which then need a reload
 */
export function needsReload(report: Report) {
  return report.installed.length > 0 || report.updated.length > 0;
}

function describeChange({ id, from, to }: { id: string; from?: string; to?: string }) {
  return `${id} ${from ?? '?'} → ${to ?? '?'}`;
}

/**
 * The lines that report a run on the console, empty when there is nothing to report
 */
export function formatLines(report: Report) {
  const lines: string[] = [];
  for (const name of report.addedMarketplaces) {
    lines.push(`marketplace registered: ${name}`);
  }
  for (const { id, version } of report.installed) {
    lines.push(`plugin installed: ${id} ${version ?? ''}`.trimEnd());
  }
  for (const change of report.updated) {
    lines.push(`plugin updated: ${describeChange(change)}`);
  }
  for (const change of report.pending) {
    lines.push(`plugin update held back by min-release-age: ${describeChange(change)}, applied from ${change.appliesOn}`);
  }
  if (needsReload(report)) {
    lines.push('run /reload-plugins in a running Claude Code session, or start a new one');
  }
  for (const failure of report.failures) {
    lines.push(`failed: ${failure}`);
  }
  return lines;
}

const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

/**
 * The JSON a SessionStart hook prints to report a run, or undefined when there is nothing to report.
 * The terminal shows `systemMessage`, the IDE extensions do not: there, `additionalContext` asks
 * Claude to pass the news on in its first reply, failures included, so that a hook that stopped working
 * does not go unnoticed.
 */
export function formatHookOutput(report: Report) {
  const lines = formatLines(report);
  if (lines.length === 0) {
    return undefined;
  }
  const output: { systemMessage: string; hookSpecificOutput?: object } = {
    systemMessage: `${YELLOW}claude-setup: ${lines.join('\n')}${RESET}`,
  };

  const news: string[] = [];
  if (needsReload(report)) {
    const changes = [...report.installed.map(({ id, version }) => `${id} ${version ?? ''}`.trimEnd()), ...report.updated.map(describeChange)];
    news.push(
      `The claude-setup hook installed or updated these Claude Code plugins for this project: ${changes.join(', ')}. ` +
        'This session still runs the plugins it loaded before: the developer must run /reload-plugins or start a new session.',
    );
  }
  if (report.pending.length > 0) {
    news.push(
      "New versions of these Claude Code plugins are held back by the project's min-release-age, and will be applied automatically: " +
        report.pending.map((change) => `${describeChange(change)} from ${change.appliesOn}`).join(', ') +
        '.',
    );
  }
  if (report.failures.length > 0) {
    news.push(`The claude-setup hook, which sets up the Claude Code plugins of this project, failed: ${report.failures.join('; ')}.`);
  }
  if (news.length > 0) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: `${news.join(' ')} At the start of your first reply, tell the developer this in one or two short sentences, in their language, whatever they asked.`,
    };
  }
  return JSON.stringify(output);
}
