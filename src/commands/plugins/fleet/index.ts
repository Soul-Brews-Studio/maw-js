import type { InvokeContext, InvokeResult } from "../../../plugin/types";

interface SubcommandDef {
  desc: string;
  args?: string;
  aliases?: string[];
  handler: (args: string[]) => Promise<void>;
}

const FLEET: Record<string, SubcommandDef> = {
  ls: {
    desc: "list fleet configs",
    args: "[--json] [--verbose|-v]",
    handler: async (args) => {
      const { cmdFleetLs } = await import("../../shared/fleet");
      await cmdFleetLs({ json: args.includes("--json"), verbose: args.includes("--verbose") || args.includes("-v") });
    },
  },
  init: {
    desc: "initialize fleet (or agents-only)",
    args: "[--agents] [--dry-run]",
    handler: async (args) => {
      if (args.includes("--agents")) {
        const { cmdFleetInitAgents } = await import("./fleet-init");
        await cmdFleetInitAgents({ dryRun: args.includes("--dry-run") });
      } else {
        const { cmdFleetInit } = await import("./fleet-init");
        await cmdFleetInit();
      }
    },
  },
  wake: {
    desc: "cold-start all fleet sessions (skips dormant)",
    args: "[--all] [--kill]",
    handler: async (args) => {
      const { cmdWakeAll } = await import("../../shared/fleet");
      await cmdWakeAll({ all: args.includes("--all"), kill: args.includes("--kill") });
    },
  },
  hibernate: {
    desc: "hibernate idle session(s)",
    args: "[name]",
    aliases: ["sleep"],
    handler: async (args) => {
      const { cmdHibernate } = await import("./fleet-hibernate");
      await cmdHibernate(args);
    },
  },
  resume: {
    desc: "resume hibernated session(s)",
    args: "[name]",
    handler: async (args) => {
      const { cmdResume } = await import("./fleet-hibernate");
      await cmdResume(args);
    },
  },
  status: {
    desc: "show hibernate state",
    aliases: ["st"],
    handler: async () => {
      const { cmdFleetStatus } = await import("./fleet-hibernate");
      await cmdFleetStatus();
    },
  },
  adopt: {
    desc: "scan ghq repos for orphan oracles",
    args: "--scan",
    handler: async (args) => {
      const { cmdFleetAdopt } = await import("./fleet-adopt");
      await cmdFleetAdopt(args);
    },
  },
  compose: {
    desc: "generate docker-compose.yml for maw serve",
    args: "[--output <path>]",
    aliases: ["to-compose"],
    handler: async (args) => {
      const { cmdFleetCompose } = await import("./fleet-compose");
      await cmdFleetCompose(args);
    },
  },
  health: {
    desc: "fleet health check",
    handler: async () => {
      const { cmdFleetHealth } = await import("./fleet-health");
      await cmdFleetHealth();
    },
  },
  doctor: {
    desc: "diagnose fleet issues",
    args: "[--fix] [--json]",
    aliases: ["dr"],
    handler: async (args) => {
      const { cmdFleetDoctor } = await import("../../shared/fleet-doctor");
      await cmdFleetDoctor({ fix: args.includes("--fix"), json: args.includes("--json") });
    },
  },
  validate: {
    desc: "validate fleet configs",
    handler: async () => {
      const { cmdFleetValidate } = await import("../../shared/fleet");
      await cmdFleetValidate();
    },
  },
  sync: {
    desc: "sync fleet configs",
    handler: async () => {
      const { cmdFleetSyncConfigs } = await import("../../shared/fleet");
      await cmdFleetSyncConfigs();
    },
  },
  "sync-windows": {
    desc: "sync window names",
    aliases: ["syncwin"],
    handler: async () => {
      const { cmdFleetSync } = await import("../../shared/fleet");
      await cmdFleetSync();
    },
  },
  renumber: {
    desc: "renumber fleet sessions",
    handler: async () => {
      const { cmdFleetRenumber } = await import("../../shared/fleet");
      await cmdFleetRenumber();
    },
  },
  consolidate: {
    desc: "consolidate duplicate configs",
    args: "[--dry-run] [--remove]",
    handler: async (args) => {
      const { cmdFleetConsolidate } = await import("./fleet-consolidate");
      await cmdFleetConsolidate({ dryRun: args.includes("--dry-run"), remove: args.includes("--remove") });
    },
  },
  snapshot: {
    desc: "take fleet snapshot",
    args: "[trigger]",
    handler: async (args) => {
      const { takeSnapshot } = await import("../../../core/fleet/snapshot");
      const trigger = args[0] || "manual";
      const path = await takeSnapshot(trigger);
      console.log(`\x1b[32m📸\x1b[0m snapshot saved: ${path} (trigger: ${trigger})`);
    },
  },
  snapshots: {
    desc: "list snapshots",
    aliases: ["snapshot-ls"],
    handler: async () => {
      const { listSnapshots } = await import("../../../core/fleet/snapshot");
      const snaps = listSnapshots();
      if (snaps.length === 0) { console.log("no snapshots yet"); return; }
      console.log(`\x1b[36m📸 ${snaps.length} snapshots\x1b[0m\n`);
      for (const s of snaps) {
        const d = new Date(s.timestamp);
        const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
        console.log(`  ${s.file.replace(".json", "")}  ${local}  \x1b[90m${s.trigger}\x1b[0m  ${s.sessionCount} sessions, ${s.windowCount} windows`);
      }
    },
  },
  restore: {
    desc: "restore from snapshot",
    args: "<id> [--all]",
    handler: async (args) => {
      const { loadSnapshot, latestSnapshot } = await import("../../../core/fleet/snapshot");
      const snap = args[0] ? loadSnapshot(args[0]) : latestSnapshot();
      if (!snap) throw new Error("no snapshot found");
      const d = new Date(snap.timestamp);
      const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
      console.log(`\x1b[36m📸 Snapshot: ${local} (${snap.trigger})\x1b[0m\n`);
      for (const s of snap.sessions) {
        console.log(`\x1b[33m${s.name}\x1b[0m (${s.windows.length} windows)`);
        for (const w of s.windows) { console.log(`  ${w.name}`); }
      }
      if (args.includes("--all")) {
        const { cmdWake } = await import("../../shared/wake-cmd");
        console.log("");
        for (const s of snap.sessions) {
          const oracle = s.name.replace(/^\d+-/, "");
          try {
            await cmdWake(oracle, { attach: false });
            console.log(`  \x1b[32m✓\x1b[0m ${s.name}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  \x1b[31m✗\x1b[0m ${s.name}: ${msg}`);
          }
        }
      }
    },
  },
};

function generateHelp(): string {
  const lines = ["usage: maw fleet <subcommand> [args]\n\nsubcommands:"];
  for (const [name, def] of Object.entries(FLEET)) {
    const label = def.args ? `${name} ${def.args}` : name;
    lines.push(`  ${label.padEnd(25)} ${def.desc}`);
  }
  return lines.join("\n");
}

function resolveSubcommand(name: string): SubcommandDef | undefined {
  if (FLEET[name]) return FLEET[name];
  for (const def of Object.values(FLEET)) {
    if (def.aliases?.includes(name)) return def;
  }
  return undefined;
}

export const command = {
  name: "fleet",
  description: "Fleet management — init, sync, health, doctor, snapshots.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push((a as unknown[]).map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push((a as unknown[]).map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0];

    if (sub === "--help" || sub === "-h") {
      return { ok: true, output: generateHelp() };
    }

    const def = sub ? resolveSubcommand(sub) : FLEET.ls;
    if (!def) {
      return {
        ok: false,
        error: `unknown fleet subcommand: ${sub}\navailable: ${Object.keys(FLEET).join(", ")}`,
      };
    }

    await def.handler(args.slice(sub ? 1 : 0));
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
