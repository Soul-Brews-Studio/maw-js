/**
 * #732 — /api/sessions dedupes windows with the same name within a session.
 *
 * When config.agents lists the same repo across multiple tmux windows,
 * session.windows contains repeated entries with the same name. UI
 * consumers iterate windows to render one row per oracle — duplicates
 * cause React key collisions.
 *
 * dedupeSessionWindows() keeps one window per name, preferring the
 * active one when present.
 */
import { describe, it, expect } from "bun:test";
import { dedupeSessionWindows } from "../src/api/sessions";

describe("#732 — dedupeSessionWindows", () => {
  it("keeps the only window when there are no duplicates", () => {
    const sessions = [
      {
        name: "fleet",
        windows: [
          { index: 0, name: "mawjs-oracle", active: true },
          { index: 1, name: "pulse-oracle", active: false },
        ],
      },
    ];
    const out = dedupeSessionWindows(sessions);
    expect(out[0].windows.length).toBe(2);
    expect(out[0].windows.map(w => w.name)).toEqual(["mawjs-oracle", "pulse-oracle"]);
  });

  it("dedupes windows with the same name within a session", () => {
    const sessions = [
      {
        name: "fleet",
        windows: [
          { index: 0, name: "pulse-oracle", active: false },
          { index: 1, name: "mawjs-oracle", active: false },
          { index: 5, name: "pulse-oracle", active: false },
        ],
      },
    ];
    const out = dedupeSessionWindows(sessions);
    expect(out[0].windows.length).toBe(2);
    expect(out[0].windows.map(w => w.name).sort()).toEqual(["mawjs-oracle", "pulse-oracle"]);
  });

  it("prefers the active window over an earlier non-active one", () => {
    const sessions = [
      {
        name: "fleet",
        windows: [
          { index: 0, name: "pulse-oracle", active: false },
          { index: 3, name: "pulse-oracle", active: true },
          { index: 7, name: "pulse-oracle", active: false },
        ],
      },
    ];
    const out = dedupeSessionWindows(sessions);
    expect(out[0].windows.length).toBe(1);
    expect(out[0].windows[0].active).toBe(true);
    expect(out[0].windows[0].index).toBe(3);
  });

  it("dedupes independently per session", () => {
    const sessions = [
      {
        name: "a",
        windows: [
          { index: 0, name: "pulse-oracle", active: true },
          { index: 1, name: "pulse-oracle", active: false },
        ],
      },
      {
        name: "b",
        windows: [
          { index: 0, name: "pulse-oracle", active: false },
        ],
      },
    ];
    const out = dedupeSessionWindows(sessions);
    expect(out[0].windows.length).toBe(1);
    expect(out[1].windows.length).toBe(1);
  });

  it("preserves extra fields on the session and on the window", () => {
    const sessions = [
      {
        name: "fleet",
        source: "local",
        windows: [
          { index: 0, name: "pulse-oracle", active: false, cwd: "/a" },
          { index: 1, name: "pulse-oracle", active: true, cwd: "/b" },
        ],
      },
    ];
    const out = dedupeSessionWindows(sessions as any);
    expect((out[0] as any).source).toBe("local");
    expect(out[0].windows.length).toBe(1);
    expect((out[0].windows[0] as any).cwd).toBe("/b");
  });

  it("handles empty windows array", () => {
    const sessions = [{ name: "empty", windows: [] }];
    const out = dedupeSessionWindows(sessions);
    expect(out[0].windows).toEqual([]);
  });
});
