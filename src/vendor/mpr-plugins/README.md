# Vendored maw-plugin-registry plugins

Runtime copies of maw-plugin-registry plugins used to bootstrap fresh maw-js
installs without a first-run network fetch. Tests are intentionally excluded;
source of truth remains Soul-Brews-Studio/maw-plugin-registry.

Update by copying plugin runtime files from `maw-plugin-registry/plugins/*`
while excluding `*.test.ts`.
