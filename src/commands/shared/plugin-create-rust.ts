import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  copyTree,
  buildManifestJson,
  defaultRustSdkPath,
  TEMPLATE_RUST,
} from "./plugin-create-scaffold";
import { existsSync } from "fs";

export function scaffoldRust(name: string, dest: string, templateDir = TEMPLATE_RUST, sdkPath = defaultRustSdkPath()): void {
  if (!existsSync(templateDir)) {
    throw new Error(`Rust template not found at ${templateDir}`);
  }

  copyTree(templateDir, dest);

  // Rewrite Cargo.toml: fix crate name and replace relative SDK path with absolute
  const cargoPath = join(dest, "Cargo.toml");
  let cargo = readFileSync(cargoPath, "utf8");
  // Replace any existing package name
  cargo = cargo.replace(/^name = ".*?"$/m, `name = "${name}"`);
  // Replace relative SDK path with absolute
  cargo = cargo.replace(
    /maw-plugin-sdk = \{ path = "[^"]*" \}/,
    `maw-plugin-sdk = { path = "${sdkPath}" }`,
  );
  writeFileSync(cargoPath, cargo);

  // Write README
  const crateName = name.replace(/-/g, "_");
  writeFileSync(
    join(dest, "README.md"),
    `# ${name}

A maw WASM command plugin (Rust).

## Build

\`\`\`bash
cd "${dest}"
cargo build --release --target wasm32-unknown-unknown
\`\`\`

Output: \`target/wasm32-unknown-unknown/release/${crateName}.wasm\`

## Install

\`\`\`bash
maw plugin install "${dest}"
\`\`\`

## SDK docs

See the SDK at \`${sdkPath}\` for available host functions:
\`maw::print\`, \`maw::identity\`, \`maw::federation\`, \`maw::send\`, \`maw::fetch\`.
`,
  );

  // Emit plugin.json manifest
  writeFileSync(join(dest, "plugin.json"), buildManifestJson(name, "rust"));
}
