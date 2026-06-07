import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "fleet",
  description: "Manage the persistent fleet registry; use maw ls for currently live sessions.",
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
    } else if (sub === "rename") {
      const oldName = args[1];
      const newName = args[2];
      if (!oldName || !newName) {
        return { ok: false, error: "usage: maw fleet rename <old-name> <new-name> [--dry-run] [--force]" };
      }
      const { cmdFleetRename } = await import("../../shared/fleet");
      await cmdFleetRename({ oldName, newName, dryRun: args.includes("--dry-run"), force: args.includes("--force") });
    } else if (sub === "validate") {
      const { cmdFleetValidate } = await import("../../shared/fleet");
      await cmdFleetValidate();
    } else if (sub === "health") {
      const { cmdFleetHealth } = await import("./fleet-health");
      await cmdFleetHealth();
    } else if (sub === "doctor" || sub === "dr") {
      const { cmdFleetDoctor } = await import("../../shared/fleet-doctor");
      await cmdFleetDoctor({ fix: args.includes("--fix"), json: args.includes("--json"), reboot: args.includes("--reboot") });
    } else if (sub === "config-doctor" || sub === "config-drift") {
      if (args.includes("--fix")) {
        return { ok: false, error: "maw fleet config-doctor is report-only; review the drift output before copying repo-local config" };
      }
      const baselineFlag = args.findIndex((arg) => arg === "--baseline");
      const baseline = baselineFlag >= 0 ? args[baselineFlag + 1] : undefined;
      if (baselineFlag >= 0 && !baseline) {
        return { ok: false, error: "usage: maw fleet config-doctor [--baseline <path>] [--json]" };
      }
      const { cmdFleetConfigDoctor } = await import("../../shared/fleet-config-doctor");
      await cmdFleetConfigDoctor({ baseline, json: args.includes("--json") });
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
      const { listSnapshots, loadSnapshot, latestSnapshot } = await import("../../../core/fleet/snapshot");
      const action = sub === "snapshot-ls" ? "list" : (args[1] || "list");
      const json = args.includes("--json");
      if (action === "list" || action === "ls") {
        const snaps = listSnapshots();
        if (json) {
          console.log(JSON.stringify({ snapshots: snaps }, null, 2));
        } else if (snaps.length === 0) {
          console.log("no snapshots yet");
          return { ok: true, output: logs.join("\n") || "no snapshots yet" };
        } else {
          console.log(`\x1b[36m📸 ${snaps.length} snapshots\x1b[0m\n`);
          for (const s of snaps) {
            const d = new Date(s.timestamp);
            const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
            console.log(`  ${s.file.replace(".json", "")}  ${local}  \x1b[90m${s.trigger}\x1b[0m  ${s.sessionCount} sessions, ${s.windowCount} windows`);
          }
        }
      } else if (action === "show" || action === "view") {
        const id = args[2];
        const snap = id && id !== "latest" ? loadSnapshot(id) : latestSnapshot();
        if (!snap) {
          return { ok: false, error: "no snapshot found" };
        }
        if (json) {
          console.log(JSON.stringify(snap, null, 2));
        } else {
          const d = new Date(snap.timestamp);
          const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
          console.log(`\x1b[36m📸 Snapshot: ${local} (${snap.trigger})\x1b[0m\n`);
          for (const s of snap.sessions) {
            console.log(`\x1b[33m${s.name}\x1b[0m (${s.windows.length} windows)`);
            for (const w of s.windows) console.log(`  ${w.name}`);
          }
        }
      } else {
        return {
          ok: false,
          error: "usage: maw snapshots [list|show <id>|show latest] [--json]",
        };
      }
    } else if (sub === "restore") {
      const { loadSnapshot, latestSnapshot } = await import("../../../core/fleet/snapshot");
      const snapshotId = args.slice(1).find((arg) => !arg.startsWith("-"));
      const snap = snapshotId && snapshotId !== "latest" ? loadSnapshot(snapshotId) : latestSnapshot();
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

      if (args.includes("--all")) {
        const { cmdWake } = await import("../../shared/wake-cmd");
        console.log("");
        for (const s of snap.sessions) {
          const oracle = s.name.replace(/^\d+-/, "");
          try {
            await cmdWake(oracle, { attach: false });
            console.log(`  \x1b[32m✓\x1b[0m ${s.name}`);
          } catch (e: any) {
            console.log(`  \x1b[31m✗\x1b[0m ${s.name}: ${e?.message || String(e)}`);
          }
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
        error: `unknown fleet subcommand: ${sub}\nusage: maw fleet <init|ls|rename|renumber|validate|health|doctor|config-doctor|consolidate|sync|sync-windows|snapshots|restore|snapshot>\n  tip: maw fleet config-doctor detects repo-local .claude/ drift; maw fleet doctor --reboot checks reboot auto-wake readiness; maw ls shows live sessions`,
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
