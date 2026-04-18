import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "fleet",
  description: "Fleet management — init, sync, health, doctor, snapshots.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0];

    if (sub === "init") {
      if (args.includes("--agents")) {
        const { cmdFleetInitAgents } = await import("./fleet-init");
        await cmdFleetInitAgents({ dryRun: args.includes("--dry-run") });
      } else {
        const { cmdFleetInit } = await import("./fleet-init");
        await cmdFleetInit();
      }
    } else if (sub === "ls") {
      const { cmdFleetLs } = await import("../../shared/fleet");
      await cmdFleetLs();
    } else if (sub === "renumber") {
      const { cmdFleetRenumber } = await import("../../shared/fleet");
      await cmdFleetRenumber();
    } else if (sub === "validate") {
      const { cmdFleetValidate } = await import("../../shared/fleet");
      await cmdFleetValidate();
    } else if (sub === "health") {
      const { cmdFleetHealth } = await import("./fleet-health");
      await cmdFleetHealth();
    } else if (sub === "doctor" || sub === "dr") {
      const { cmdFleetDoctor } = await import("../../shared/fleet-doctor");
      await cmdFleetDoctor({ fix: args.includes("--fix"), json: args.includes("--json") });
    } else if (sub === "consolidate") {
      const { cmdFleetConsolidate } = await import("./fleet-consolidate");
      await cmdFleetConsolidate({ dryRun: args.includes("--dry-run"), remove: args.includes("--remove") });
    } else if (sub === "sync") {
      const { cmdFleetSyncConfigs } = await import("../../shared/fleet");
      await cmdFleetSyncConfigs();
    } else if (sub === "sync-windows" || sub === "syncwin") {
      const { cmdFleetSync } = await import("../../shared/fleet");
      await cmdFleetSync();
    } else if (sub === "snapshots" || sub === "snapshot-ls") {
      const { listSnapshots } = await import("../../../core/fleet/snapshot");
      const snaps = listSnapshots();
      if (snaps.length === 0) {
        console.log("no snapshots yet");
        return { ok: true, output: logs.join("\n") || "no snapshots yet" };
      }
      console.log(`\x1b[36m📸 ${snaps.length} snapshots\x1b[0m\n`);
      for (const s of snaps) {
        const d = new Date(s.timestamp);
        const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
        console.log(`  ${s.file.replace(".json", "")}  ${local}  \x1b[90m${s.trigger}\x1b[0m  ${s.sessionCount} sessions, ${s.windowCount} windows`);
      }
    } else if (sub === "restore") {
      const { loadSnapshot, latestSnapshot } = await import("../../../core/fleet/snapshot");
      const snap = args[1] ? loadSnapshot(args[1]) : latestSnapshot();
      if (!snap) {
        return { ok: false, error: "no snapshot found" };
      }
      const d = new Date(snap.timestamp);
      const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
      console.log(`\x1b[36m📸 Snapshot: ${local} (${snap.trigger})\x1b[0m\n`);
      for (const s of snap.sessions) {
        console.log(`\x1b[33m${s.name}\x1b[0m (${s.windows.length} windows)`);
        for (const w of s.windows) {
          console.log(`  ${w.name}`);
        }
      }
    } else if (sub === "snapshot") {
      const { takeSnapshot } = await import("../../../core/fleet/snapshot");
      const trigger = args[1] || "manual";
      const path = await takeSnapshot(trigger);
      console.log(`\x1b[32m📸\x1b[0m snapshot saved: ${path} (trigger: ${trigger})`);
    } else if (!sub) {
      const { cmdFleetLs } = await import("../../shared/fleet");
      await cmdFleetLs();
    } else {
      return {
        ok: false,
        error: `unknown fleet subcommand: ${sub}\nusage: maw fleet <init|ls|renumber|validate|health|doctor|consolidate|sync|sync-windows|snapshots|restore|snapshot>`,
      };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
