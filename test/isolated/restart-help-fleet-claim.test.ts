/**
 * Regression: `maw restart` help/metadata must state it restarts the WHOLE
 * fleet (stop + wake all) and must never claim to restart only the server.
 *
 * Origin: runbook overlap audit 2026-08-17 (Riddler) — plugin metadata said
 * "restart the maw server" while the implementation (impl.ts) does
 * sleep-fleet + wake-all; an operator inside a fleet session trusting the
 * help text would take down every agent, not just the daemon.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const restartDir = join(root, "src/vendor/mpr-plugins/restart");

const SERVER_ONLY_CLAIM = /restart the maw server/i;
const FLEET_CLAIM = /whole\s+(maw\s+)?fleet/i;

function metadataStrings(): Array<{ where: string; text: string }> {
  const pluginJson = JSON.parse(readFileSync(join(restartDir, "plugin.json"), "utf8"));
  const registryMeta = JSON.parse(readFileSync(join(restartDir, "registry.meta.json"), "utf8"));
  const indexSrc = readFileSync(join(restartDir, "index.ts"), "utf8");
  const pluginTsSrc = readFileSync(join(restartDir, "plugin.ts"), "utf8");
  return [
    { where: "plugin.json description", text: String(pluginJson.description ?? "") },
    { where: "plugin.json cli.help", text: String(pluginJson.cli?.help ?? "") },
    { where: "registry.meta.json summary", text: String(registryMeta.summary ?? "") },
    { where: "index.ts source (command.description + HELP_TEXT)", text: indexSrc },
    { where: "plugin.ts source", text: pluginTsSrc },
  ];
}

describe("restart help/metadata fleet claim", () => {
  test("no surface claims server-only restart", () => {
    for (const { where, text } of metadataStrings()) {
      expect(SERVER_ONLY_CLAIM.test(text), `${where} still claims server-only restart`).toBe(false);
    }
  });

  test("user-facing description and help say WHOLE fleet", () => {
    const pluginJson = JSON.parse(readFileSync(join(restartDir, "plugin.json"), "utf8"));
    expect(String(pluginJson.description)).toMatch(FLEET_CLAIM);
    expect(String(pluginJson.cli?.help)).toMatch(FLEET_CLAIM);
  });

  test("--help output describes the whole-fleet sequence, not a server restart", async () => {
    const { default: handler } = await import(join(restartDir, "index.ts"));
    let printed = "";
    const orig = console.log;
    console.log = (msg?: unknown) => { printed += String(msg ?? "") + "\n"; };
    try {
      await handler(["--help"]);
    } finally {
      console.log = orig;
    }
    expect(SERVER_ONLY_CLAIM.test(printed)).toBe(false);
    expect(printed).toMatch(/whole maw fleet/i);
    expect(printed).toMatch(/wake fleet|wake all/i);
  });
});
