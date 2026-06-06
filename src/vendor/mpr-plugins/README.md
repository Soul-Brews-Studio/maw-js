# Vendored maw-plugin-registry plugins

89 runtime copies of maw-plugin-registry plugins bundled with maw-js.
Bootstraps fresh installs without a first-run network fetch.

Tests are intentionally excluded; source of truth remains
Soul-Brews-Studio/maw-plugin-registry.

## Extraction status

Per RFC #2113, 73 of these 89 plugins are mapped for extraction:

| Tier | Count | Status |
|------|-------|--------|
| Easy | 23 | Minimal core deps, ready to extract |
| Medium | 27 | Need SDK 1.0 exports |
| Hard | 13 | Need fleet/lifecycle refactoring |
| True core | ~10 | Stay bundled |

See [#2113](https://github.com/Soul-Brews-Studio/maw-js/issues/2113)
for the full extraction map.

## Updating

Copy plugin runtime files from `maw-plugin-registry/plugins/*`
while excluding `*.test.ts`.
