import { existsSync } from "fs";
import { join } from "path";
import { mawDataPath } from "../../core/xdg";
import { validatePluginName } from "./plugin-create-scaffold";
import { scaffoldRust } from "./plugin-create-rust";
import { scaffoldAs } from "./plugin-create-as";
import { UserError } from "../../core/util/user-error";

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
    throw new UserError("usage: maw plugin create [--rust | --as] <name> [--here]\n  Specify either --rust or --as");
  }
  if (isRust && isAs) {
    throw new UserError("Specify --rust or --as, not both");
  }

  // Validate name
  if (!name) {
    throw new UserError("usage: maw plugin create [--rust | --as] <name> [--here]");
  }
  const nameErr = validatePluginName(name);
  if (nameErr) {
    throw new UserError(`Invalid plugin name: ${nameErr}`);
  }

  // Resolve destination
  const dest = flags["--dest"]
    ?? (flags["--here"]
      ? join(process.cwd(), name)
      : join(process.env.MAW_PLUGIN_HOME ?? mawDataPath("plugins"), name));

  if (existsSync(dest)) {
    throw new UserError(`Destination already exists: ${dest}`);
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
    throw new UserError(String(err?.message ?? err));
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
