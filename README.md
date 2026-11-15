# claude-setup

Sets up, at project scope, the Claude Code marketplaces and plugins that a project declares in its
`.claude/settings.json`, so that a project does not depend on what each developer configured.

Claude Code does not do it on its own: a marketplace declared in `extraKnownMarketplaces` is unknown to
the `claude` CLI until a session has run in the trusted folder, and a plugin enabled in `enabledPlugins`
only loads once installed on the developer's machine, once per clone.

## What it does

Run from the root of a project, it:

1. registers each marketplace of `extraKnownMarketplaces` that the machine does not know yet:
   `claude plugin marketplace add <source> --scope project`;
2. installs each plugin set to `true` in `enabledPlugins` that no installation covers for this clone:
   `claude plugin install <plugin> --scope project`. A user installation counts, a project or local
   one only in the clone it was made in;
3. refreshes the marketplaces the project declares, then:
   - updates at once the plugins of those declared with `"autoUpdate": true`, in the scope they were
     installed in;
   - updates the plugins of the others once their new version is older than the project's
     `min-release-age`, the delay the project already imposes on npm packages (see below);
4. puts `.claude/settings.json` back as it found it: the `claude` CLI rewrites the whole file in its own
   format on an add or an install, and `marketplace add` even drops the `autoUpdate` of an existing entry.

It reports what it did, and that a running session needs `/reload-plugins` to use an installed or
updated plugin.

### The release-age delay

A marketplace without `autoUpdate` is one the project does not control, a third-party one: its new
versions wait like npm packages do. The delay is the `min-release-age` that npm reads from the project
(`npm config get min-release-age` at its root, so the project's `.npmrc` unless an environment variable
overrides it); without one, updates apply at once.

A marketplace clone is shallow, so the commit that introduced a version is out of reach. The release date
is estimated as the earlier of the day `claude-setup` first saw the version and the date of the last
commit of the clone: both come after the release, so the delay is never shortened, at worst lengthened.
A held-back version is reported once, with the day it will apply; the first sightings are recorded in
`node_modules/.cache/claude-setup/state.json`.

It never fails, so that it cannot break an `npm install` or a session start: a failure (network down,
unknown plugin…) is reported, and the run goes on. It does nothing without the `claude` CLI, in CI (`CI`
set), or with `CLAUDE_SETUP_SKIP` set.

## Installation

```sh
npm install --save-dev --save-exact @jondeodat/claude-setup-cli
```

The script is TypeScript run by [`tsx`](https://github.com/privatenumber/tsx), its only dependency.

## Usage

```sh
claude-setup [--hook] [--max-age <hours>]
```

- `--hook` prints its report as the JSON output of a `SessionStart` hook, and nothing when there is nothing
  to report. The terminal shows its `systemMessage`, in yellow; the IDE extensions do not show it, so an
  `additionalContext` asks Claude to pass the news on at the start of its first reply.
- `--max-age <hours>` refreshes the marketplaces only when the last refresh, recorded in
  `node_modules/.cache/claude-setup/state.json`, is older. Without it, every run refreshes.

In a project, from the `prepare` script of its `package.json`, which runs on an `npm install` or `npm ci`
in the project itself but not where the project is installed as a dependency (unlike `postinstall`):

```json
"prepare": "claude-setup"
```

And from a `SessionStart` hook of `.claude/settings.json`, once a day. The guard skips it in a clone where
the dependencies are not installed yet:

```json
"hooks": {
  "SessionStart": [
    {
      "matcher": "startup",
      "hooks": [
        {
          "type": "command",
          "command": "cd \"$CLAUDE_PROJECT_DIR\" && [ -x node_modules/.bin/claude-setup ] && node_modules/.bin/claude-setup --hook --max-age 24 || true"
        }
      ]
    }
  ]
}
```

## Development

```sh
npm ci
npm test              # Vitest
npm run typecheck     # tsc: tsx runs the script without checking its types
npm run format:check  # Prettier
```

### Dependency install scripts

The install scripts of a dependency (`preinstall`, `install`, `postinstall`) run any code on the machine
at install time, the usual entry point of supply chain attacks. `.npmrc` sets `strict-allow-scripts=true`:
npm only runs the scripts approved in the `allowScripts` field of `package.json`, skips the denied ones,
and fails the install on a dependency it has not been told about. Both need npm 11.20 or later, older ones
ignore them and run every script: the `devEngines` of `package.json` makes them refuse to install instead.
Read the script first, then record the decision:

```sh
npm install-scripts approve <pkg>  # pinned to the reviewed version: approve again after a bump
npm install-scripts deny <pkg>
```

- `esbuild` (through `tsx` and `vitest`) is denied. Its `postinstall` checks the native binary and copies
  it over the JavaScript launcher `bin/esbuild`; the binary comes from the optional dependency of the
  platform (`@esbuild/darwin-arm64`, `@esbuild/linux-x64`…), where the JavaScript API used by tsx and
  vitest runs it.

`.npmrc` also sets `min-release-age=7`: npm installs no version published less than 7 days ago.

## Publish process

Bump the version, then publish on npm:

```sh
npm version <patch|minor|major> --no-git-tag-version
npm run push
```

- `npm version` only updates `package.json` and `package-lock.json`: commit them with the change they ship.
- `npm run push` first runs `npm run typecheck`, `npm test` and `npm run format:check`, and stops if one
  fails; then it publishes the package, publicly, on registry.npmjs.org.

## License

[MIT](LICENSE)
