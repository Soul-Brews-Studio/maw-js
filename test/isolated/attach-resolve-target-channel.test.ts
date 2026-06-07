import { describe, expect, test } from "bun:test";

const { resolveAttachTarget } = await import("../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts?channel-regression");

describe("attach resolver channel-session filtering", () => {
  test("filters discord channel helper sessions so the oracle admin session wins", async () => {
    const result = await resolveAttachTarget("discord", {
      listSessions: async () => [
        { name: "01-mawjs-discord", windows: [{ name: "mawjs-oracle-discord" }] },
        { name: "02-homekeeper-discord", windows: [{ name: "homekeeper-oracle-discord" }] },
        { name: "03-random-oracle-discord", windows: [{ name: "random" }] },
        { name: "23-discord-admin", windows: [{ name: "discord-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "23-discord-admin" });
  });

  test("does not treat channel helpers as ambiguous matches when no oracle session exists", async () => {
    const result = await resolveAttachTarget("discord", {
      listSessions: async () => [
        { name: "01-mawjs-discord", windows: [{ name: "mawjs-oracle-discord" }] },
        { name: "02-homekeeper-discord", windows: [{ name: "homekeeper-oracle-discord" }] },
        { name: "14-random-oracle-discord", windows: [{ name: "random" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toBeNull();
  });

  test("keeps the oracle own numbered discord-oracle session visible", async () => {
    const result = await resolveAttachTarget("discord", {
      listSessions: async () => [
        { name: "01-mawjs-discord", windows: [{ name: "mawjs-oracle-discord" }] },
        { name: "24-discord-oracle", windows: [{ name: "discord-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "24-discord-oracle" });
  });

  test("returns tier 1 ambiguity details when multiple oracle sessions match", async () => {
    const result = await resolveAttachTarget("calliope", {
      listSessions: async () => [
        { name: "63-calliope-oracle", windows: [{ name: "main" }] },
        { name: "64-calliope-admin", windows: [{ name: "calliope-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({
      tier: 1,
      sessionName: "63-calliope-oracle",
      ambiguousCandidates: ["63-calliope-oracle", "64-calliope-admin"],
    });
  });

  test("prefers a single exact session name over legacy dashless fuzzy ambiguity", async () => {
    const result = await resolveAttachTarget("77-mawjs", {
      listSessions: async () => [
        { name: "51-maw-js", windows: [{ name: "main" }] },
        { name: "77-mawjs", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "77-mawjs" });
  });

  test("falls back to a single sleeping fleet match when no session matches", async () => {
    const result = await resolveAttachTarget("homekeeper", {
      listSessions: async () => [],
      loadFleet: () => [
        { name: "homekeeper-oracle", windows: [{ name: "main" }] },
      ],
    });

    expect(result).toEqual({ tier: 2, fleetName: "homekeeper-oracle" });
  });

  test("returns tier 2 ambiguity details when multiple fleet entries match", async () => {
    const result = await resolveAttachTarget("calliope", {
      listSessions: async () => [],
      loadFleet: () => [
        { name: "primary-calliope-oracle", windows: [{ name: "main" }] },
        { name: "backup-calliope-oracle", windows: [{ name: "main" }] },
      ],
    });

    expect(result).toEqual({
      tier: 2,
      fleetName: "primary-calliope-oracle",
      ambiguousCandidates: [
        "primary-calliope-oracle",
        "backup-calliope-oracle",
      ],
    });
  });

  test("fuzzy mode resolves freshly woken live sessions by substring", async () => {
    const result = await resolveAttachTarget("wind", {
      listSessions: async () => [
        { name: "01-Somwind", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [],
    }, { fuzzy: true });

    expect(result).toEqual({ tier: 1, sessionName: "01-Somwind" });
  });

  test("strict mode leaves substring-only fleet matches unresolved", async () => {
    const result = await resolveAttachTarget("wind", {
      listSessions: async () => [],
      loadFleet: () => [
        { name: "Somwind-oracle", windows: [{ name: "main" }] },
      ],
    });

    expect(result).toBeNull();
  });

  test("fuzzy mode can resolve substring-only sleeping fleet matches", async () => {
    const result = await resolveAttachTarget("wind", {
      listSessions: async () => [],
      loadFleet: () => [
        { name: "Somwind-oracle", windows: [{ name: "main" }] },
      ],
    }, { fuzzy: true });

    expect(result).toEqual({ tier: 2, fleetName: "Somwind-oracle" });
  });

  test("resolves node-qualified attach targets by oracle part", async () => {
    const result = await resolveAttachTarget("m5:mawjs", {
      listSessions: async () => [
        { name: "50-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-mawjs" });
  });

  test("preserves exact live window matches for multi-window sessions", async () => {
    const result = await resolveAttachTarget("mawjs-features", {
      listSessions: async () => [
        {
          name: "50-mawjs",
          windows: [{ name: "mawjs-oracle" }, { name: "mawjs-features" }],
        },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-mawjs", windowName: "mawjs-features" });
  });

  test("keeps tmux numeric window suffixes as session targets", async () => {
    const result = await resolveAttachTarget("neo:0", {
      listSessions: async () => [
        { name: "neo:0", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "neo:0" });
  });

  test("matches legacy dash-stripped fleet session names for canonical hyphenated input", async () => {
    const result = await resolveAttachTarget("mawjs-codex", {
      listSessions: async () => [
        { name: "50-mawjscodex", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-mawjscodex" });
  });

  test("prefers live canonical dash session over sleeping fleet ghosts", async () => {
    const result = await resolveAttachTarget("codex", {
      listSessions: async () => [
        { name: "50-mawjs-codex", windows: [{ name: "mawjs-codex-oracle" }] },
      ],
      loadFleet: () => [
        { name: "codexstark-oracle", windows: [{ name: "codexstark-oracle" }] },
        { name: "mawjs-codex-oracle", windows: [{ name: "mawjs-codex-oracle" }] },
      ],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-mawjs-codex" });
  });

  test("resolves custom session names through oracle window aliases", async () => {
    const result = await resolveAttachTarget("mawjs-codex", {
      listSessions: async () => [
        { name: "50-custom-admin", windows: [{ name: "mawjs-codex-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-custom-admin" });
  });

  test("resolves custom session names through oracle repo metadata aliases", async () => {
    const result = await resolveAttachTarget("mawjs-codex", {
      listSessions: async () => [
        {
          name: "50-custom-admin",
          windows: [{ name: "main", repo: "Soul-Brews-Studio/mawjs-codex-oracle" }],
        },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-custom-admin" });
  });

  test("reports ambiguity when multiple custom sessions share oracle repo aliases", async () => {
    const result = await resolveAttachTarget("mawjs-codex", {
      listSessions: async () => [
        {
          name: "50-custom-admin",
          windows: [{ name: "main", repo: "Soul-Brews-Studio/mawjs-codex-oracle" }],
        },
        {
          name: "51-custom-backup",
          windows: [{ name: "ops", repo: "Soul-Brews-Studio/mawjs-codex-oracle" }],
        },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({
      tier: 1,
      sessionName: "50-custom-admin",
      ambiguousCandidates: ["50-custom-admin", "51-custom-backup"],
    });
  });

});
