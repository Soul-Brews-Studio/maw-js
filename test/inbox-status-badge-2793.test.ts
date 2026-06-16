import { describe, expect, test } from "bun:test";
import {
  INBOX_BADGE_BASE_OPTION,
  formatInboxStatusBadge,
  stripInboxStatusBadge,
  updateInboxStatusBadge,
} from "../src/commands/shared/inbox-status-badge";

function fakeTmux(initial: Record<string, string> = {}) {
  const options = new Map(Object.entries(initial));
  const calls: string[][] = [];
  return {
    calls,
    options,
    tmux: {
      async run(...args: string[]) {
        calls.push(args);
        if (args[0] === "show-option") {
          const key = args.at(-1)!;
          return options.get(key) ?? "";
        }
        if (args[0] === "set-option" && args.includes("-u")) {
          options.delete(args.at(-1)!);
          return "";
        }
        if (args[0] === "set-option") {
          const key = args.at(-2)!;
          const value = args.at(-1)!;
          options.set(key, value);
          return "";
        }
        throw new Error(`unexpected tmux call: ${args.join(" ")}`);
      },
    },
  };
}

describe("persistent inbox status badge (#2793)", () => {
  test("formats and strips the tmux status-right badge", () => {
    const badge = formatInboxStatusBadge(3);
    expect(badge).toBe("#[fg=colour220,bold]📬 inbox:3#[default]");
    expect(stripInboxStatusBadge(`${badge} %H:%M`)).toBe("%H:%M");
  });

  test("saves the original session status-right and overlays unread count", async () => {
    const h = fakeTmux({ "status-right": "%H:%M" });

    await expect(updateInboxStatusBadge("50-atlas:atlas-oracle", 3, h)).resolves.toMatchObject({
      status: "set",
      session: "50-atlas",
      unread: 3,
    });

    expect(h.options.get(INBOX_BADGE_BASE_OPTION)).toBe("%H:%M");
    expect(h.options.get("status-right")).toBe("#[fg=colour220,bold]📬 inbox:3#[default] %H:%M");
  });

  test("reuses the saved base when unread count changes", async () => {
    const h = fakeTmux({
      [INBOX_BADGE_BASE_OPTION]: "%H:%M",
      "status-right": "#[fg=colour220,bold]📬 inbox:3#[default] %H:%M",
    });

    await updateInboxStatusBadge("50-atlas:atlas-oracle", 5, h);

    expect(h.options.get(INBOX_BADGE_BASE_OPTION)).toBe("%H:%M");
    expect(h.options.get("status-right")).toBe("#[fg=colour220,bold]📬 inbox:5#[default] %H:%M");
    expect(h.calls).not.toContainEqual(["set-option", "-t", "50-atlas", INBOX_BADGE_BASE_OPTION, "%H:%M"]);
  });

  test("clears badge and restores status-right once unread reaches zero", async () => {
    const h = fakeTmux({
      [INBOX_BADGE_BASE_OPTION]: "%H:%M",
      "status-right": "#[fg=colour220,bold]📬 inbox:1#[default] %H:%M",
    });

    await expect(updateInboxStatusBadge("50-atlas:atlas-oracle", 0, h)).resolves.toMatchObject({
      status: "cleared",
      session: "50-atlas",
      unread: 0,
    });

    expect(h.options.get("status-right")).toBe("%H:%M");
    expect(h.options.has(INBOX_BADGE_BASE_OPTION)).toBe(false);
  });
});
