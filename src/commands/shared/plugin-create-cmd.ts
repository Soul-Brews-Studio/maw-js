import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { validatePluginName } from "./plugin-create-scaffold";
import { scaffoldRust } from "./plugin-create-rust";
import { scaffoldAs } from "./plugin-create-as";

export async function cmdPluginCreate(
  name: string | undefined,
  flags: {
    "--rust"?: boolean;
    "--as"?: boolean;
    "--here"?: boolean;
    /** Internal override for tests — bypasses homedir() resolution */
    "--dest"?: string;
  },
): Promise<void> {
  const isRust = !!flags["--rust"];
  const isAs = !!flags["--as"];

  // Validate flags
  if (!isRust && !isAs) {
    console.error("usage: maw plugin create [--rust | --as] <name> [--here]");
    console.error("  Specify either --rust or --as");
    process.exit(1);
  }
  if (isRust && isAs) {
    console.error("  Specify --rust or --as, not both");
    process.exit(1);
  }

  // Validate name
  if (!name) {
    console.error("usage: maw plugin create [--rust | --as] <name> [--here]");
    process.exit(1);
  }
  const nameErr = validatePluginName(name);
  if (nameErr) {
    console.error(`\x1b[31m✗\x1b[0m Invalid plugin name: ${nameErr}`);
    process.exit(1);
  }

  // Resolve destination
  const dest = flags["--dest"]
    ?? (flags["--here"]
      ? join(process.cwd(), name)
      : join(homedir(), ".oracle", "plugins", name));

  if (existsSync(dest)) {
    console.error(`\x1b[31m✗\x1b[0m Destination already exists: ${dest}`);
    process.exit(1);
  }

  const type = isRust ? "Rust" : "AssemblyScript";
  console.log(`\x1b[36m⚡\x1b[0m Creating ${type} plugin \x1b[1m${name}\x1b[0m`);
  console.log(`  → ${dest}`);

  try {
    if (isRust) {
      scaffoldRust(name, dest);
    } else {
      scaffoldAs(name, dest);
    }
  } catch (err: any) {
    console.error(`\x1b[31m✗\x1b[0m ${err.message}`);
    process.exit(1);
  }

  console.log(`\n\x1b[32m✓\x1b[0m Plugin scaffolded: \x1b[1m${name}\x1b[0m`);
  console.log(`\n\x1b[33mNext steps:\x1b[0m`);
  if (isRust) {
    console.log(`  1. cd "${dest}"`);
    console.log(`  2. Edit src/lib.rs — implement your command logic`);
    console.log(`  3. cargo build --release --target wasm32-unknown-unknown`);
    console.log(`  4. maw plugin install "${dest}"`);
  } else {
    console.log(`  1. cd "${dest}"`);
    console.log(`  2. Edit assembly/index.ts — implement your command logic`);
    console.log(`  3. npm install && npm run build`);
    console.log(`  4. maw plugin install "${dest}"`);
  }
}
