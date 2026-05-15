# Plugin install architecture

Status: reference doc for the runtime shape after #1426 / #1339.

`maw-js` has three plugin sources at runtime:

1. **Bundled core plugins** from `src/commands/plugins/`.
2. **Vendored maw-plugin-registry plugins** from `src/vendor/mpr-plugins/`.
3. **User-installed plugins** under `~/.maw/plugins/` or `MAW_PLUGINS_DIR`.

All three are normalized through the same scan directory before dispatch. The
normal install root is `~/.maw/plugins/`; `MAW_PLUGINS_DIR` replaces it with a
single alternate scan directory for tests or isolated runs.

## Fresh install boot path

`runBootstrap()` in `src/cli/plugin-bootstrap.ts` prepares the install root on
CLI startup:

1. **Prune broken symlinks** — dangling symlinks in the plugin dir are removed
   before discovery so stale commands do not silently disappear.
2. **Link bundled core plugins** — source dirs in `src/commands/plugins/` are
   symlinked into the plugin dir if the destination name is free.
3. **Link vendored registry plugins** — source dirs in `src/vendor/mpr-plugins/`
   are also symlinked into the plugin dir. This makes fresh installs include
   registry commands such as `wake`, `attach`, `done`, `send`, and
   `send-enter` without a first-run network fetch.
4. **Run first-install network bootstrap** — only when the plugin dir was empty
   before linking. Each URL in `config.pluginSources` is cloned with `ghq get
   -u`; package dirs with `plugin.json` are copied into the plugin dir.

The symlink steps are idempotent and run on every boot. Existing destinations
are not overwritten, so a user-installed plugin with the same name keeps
precedence over the bundled or vendored copy.

## Source tiers

| Tier | Source path | Runtime behavior |
| --- | --- | --- |
| Bundled core | `src/commands/plugins/` | Symlinked every boot when missing. Ships with maw-js. |
| Vendored registry | `src/vendor/mpr-plugins/` | Symlinked every boot when missing. Source-only copy of maw-plugin-registry runtime plugins. |
| User installs | `~/.maw/plugins/<name>/` | Symlinked dev installs or extracted tarballs. Existing names win over bundled/vendored sources. |
| Env override | `MAW_PLUGINS_DIR` | Replaces `~/.maw/plugins/` with one scan dir. |

Discovery itself is intentionally simple: `scanDirs()` in
`src/plugin/registry-helpers.ts` returns the single install root, and the
registry loads plugins from there.

## `maw plugin install` flow

`cmdPluginInstall()` in `src/commands/plugins/plugin/install-impl.ts` accepts:

- local directories (`./hello/`), installed as symlinks;
- tarballs (`./hello.tgz`), extracted after validation;
- HTTP(S) URLs, downloaded then handled as tarballs;
- `monorepo:plugins/<name>@<tag>` refs for maw-plugin-registry style repos;
- Vercel-style GitHub refs, `owner/repo[/name][@ref]`;
- peer refs, `<name>@<peer>`, resolved through federation.

Before a plugin is linked or extracted, the install path validates the
manifest SDK range against the runtime SDK. Tarball and URL installs also run
hash verification and update `~/.maw/plugins.lock`. Dev symlink installs record
a stable hash of `plugin.json` and are labeled `linked (dev)`.

`--force` permits replacing an existing install. `--pin` explicitly re-trusts a
tarball hash when the lock entry differs. `--category core|standard|extra`
preserves or overrides display weight through `.overrides.json` so replacing a
plugin does not accidentally move it between help tiers.

## Precedence and update behavior

- Bootstrap links only when the destination path is absent.
- User installs are therefore the override layer.
- Broken symlinks are pruned before linking, which lets updates remove stale
  bundled/vendored commands cleanly.
- Vendored registry plugins avoid first-run network dependency; `pluginSources`
  remains a one-time bootstrap path for optional external sources.

## Known follow-ups

These are intentionally documented as design seams, not current blockers:

- `pluginSources` clones can resolve either a single plugin repo or a packages
  monorepo; keep this behavior covered when changing bootstrap.
- `~/.maw/plugins.lock` is written by install flows and used for tarball trust,
  but it is not a discovery index.
- Vendored registry metadata currently lives next to the copied plugin source;
  keep membership/tier decisions explicit when refreshing `src/vendor/mpr-plugins/`.
- Consent gating for peer installs is opt-in via `MAW_CONSENT=1`; future tier ×
  consent policy should stay in the install path before network artifact fetch.

## Source map

- Boot/linking: `src/cli/plugin-bootstrap.ts`
- Scan dir: `src/plugin/registry-helpers.ts`
- Plugin install dispatcher: `src/commands/plugins/plugin/install-impl.ts`
- Per-source install handlers: `src/commands/plugins/plugin/install-handlers.ts`
- Vendored runtime copy: `src/vendor/mpr-plugins/README.md`
- Original fresh-install regression: #1339
- Vendored registry fix: #1426
