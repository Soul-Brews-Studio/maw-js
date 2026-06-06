import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { resolveAttachTarget } = await import("../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts?channel-regression");

const originalSshConfigFile = process.env.SSH_CONFIG_FILE;

beforeEach(() => {
  process.env.SSH_CONFIG_FILE = join(tmpdir(), "maw-empty-ssh-config-does-not-exist");
});

afterEach(() => {
  if (originalSshConfigFile === undefined) delete process.env.SSH_CONFIG_FILE;
  else process.env.SSH_CONFIG_FILE = originalSshConfigFile;
});

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
      listRemoteSessions: async () => [],
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

  test("prefers a fleet-numbered live session over an orphan suffix match", async () => {
    const result = await resolveAttachTarget("mawjs", {
      listSessions: async () => [
        { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] },
        { name: "cnx-mawjs", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [
        { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
    });

    expect(result).toEqual({ tier: 1, sessionName: "77-mawjs" });
  });

  test("keeps live matches ambiguous when multiple numbered sessions match", async () => {
    const result = await resolveAttachTarget("mawjs", {
      listSessions: async () => [
        { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] },
        { name: "78-mawjs-backup", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({
      tier: 1,
      sessionName: "77-mawjs",
      ambiguousCandidates: ["77-mawjs", "78-mawjs-backup"],
    });
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
      listRemoteSessions: async () => [],
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

  test("resolves explicit node-qualified attach targets as tier 3 remote ssh targets", async () => {
    const result = await resolveAttachTarget("m5:mawjs", {
      listSessions: async () => [
        { name: "50-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
      resolvePeer: async (alias: string) => ({
        alias,
        url: "http://m5.local:3456",
        node: "m5",
        sshAlias: "m5-ssh",
      }),
    });

    expect(result).toEqual({
      tier: 3,
      node: "m5",
      sessionName: "mawjs",
      peerUrl: "http://m5.local:3456",
      sshAlias: "m5-ssh",
    });
  });

  test("derives cross-node ssh aliases from peer URL and node alias", async () => {
    const result = await resolveAttachTarget("alpha:volt-oracle", {
      listSessions: async () => [],
      loadFleet: () => [],
      resolvePeer: async (alias: string) => ({
        alias,
        url: "http://white.wg:3461",
        node: "white",
      }),
    });

    expect(result).toEqual({
      tier: 3,
      node: "alpha",
      sessionName: "volt-oracle",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
    });
  });

  test("uses configured peer ssh target before raw URL fallback and applies ssh user override", async () => {
    const result = await resolveAttachTarget("oracle-world:volt-oracle", {
      listSessions: async () => [],
      loadFleet: () => [],
      resolvePeer: async (alias: string) => ({
        alias,
        url: "http://10.20.0.16:3456",
        node: "oracle-world",
        sshAlias: "oracle-world",
        sshUser: "sila",
      }),
    });

    expect(result).toEqual({
      tier: 3,
      node: "oracle-world",
      sessionName: "volt-oracle",
      peerUrl: "http://10.20.0.16:3456",
      sshAlias: "sila@oracle-world",
    });
  });

  test("keeps a full configured ssh target intact when ssh user is also present", async () => {
    const result = await resolveAttachTarget("oracle-world:volt-oracle", {
      listSessions: async () => [],
      loadFleet: () => [],
      resolvePeer: async (alias: string) => ({
        alias,
        url: "http://10.20.0.16:3456",
        node: "oracle-world",
        sshAlias: "nat@oracle-world",
        sshUser: "sila",
      }),
    });

    expect(result).toEqual({
      tier: 3,
      node: "oracle-world",
      sessionName: "volt-oracle",
      peerUrl: "http://10.20.0.16:3456",
      sshAlias: "nat@oracle-world",
    });
  });

  test("uses ssh config host aliases before raw peer IP fallback", async () => {
    const previousSshConfig = process.env.SSH_CONFIG_FILE;
    const tempDir = mkdtempSync(join(tmpdir(), "maw-ssh-config-"));
    const configPath = join(tempDir, "config");
    writeFileSync(configPath, [
      "Host oracle-world",
      "  HostName floodboy-white4.alchemycat.org",
      "Host white-tunnel",
      "  HostName 10.20.0.16",
    ].join("\n"));
    process.env.SSH_CONFIG_FILE = configPath;

    try {
      const byPeerName = await resolveAttachTarget("oracle-world:volt-oracle", {
        listSessions: async () => [],
        loadFleet: () => [],
        resolvePeer: async (alias: string) => ({
          alias,
          url: "http://10.20.0.16:3456",
          node: "oracle-world",
        }),
      });
      expect(byPeerName).toEqual({
        tier: 3,
        node: "oracle-world",
        sessionName: "volt-oracle",
        peerUrl: "http://10.20.0.16:3456",
        sshAlias: "oracle-world",
      });

      const byHostName = await resolveAttachTarget("alpha:volt-oracle", {
        listSessions: async () => [],
        loadFleet: () => [],
        resolvePeer: async (alias: string) => ({
          alias,
          url: "http://10.20.0.16:3456",
          node: "white",
          sshUser: "sila",
        }),
      });
      expect(byHostName).toEqual({
        tier: 3,
        node: "alpha",
        sessionName: "volt-oracle",
        peerUrl: "http://10.20.0.16:3456",
        sshAlias: "sila@white-tunnel",
      });
    } finally {
      if (previousSshConfig === undefined) delete process.env.SSH_CONFIG_FILE;
      else process.env.SSH_CONFIG_FILE = previousSshConfig;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reports unknown explicit remote peers instead of falling back locally", async () => {
    const result = await resolveAttachTarget("badnode:mawjs", {
      listSessions: async () => [
        { name: "50-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
      resolvePeer: async () => null,
    });

    expect(result).toEqual({
      tier: "error",
      error: "peer 'badnode' not found — check maw peers list",
    });
  });

  test("bare attach stays local-only and never consults peers", async () => {
    let peerLookups = 0;
    const result = await resolveAttachTarget("mawjs", {
      listSessions: async () => [
        { name: "50-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
      resolvePeer: async () => {
        peerLookups++;
        return null;
      },
    });

    expect(result).toEqual({ tier: 1, sessionName: "50-mawjs" });
    expect(peerLookups).toBe(0);
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

  test("bare attach can opt into federation after local and fleet misses", async () => {
    let remoteLookups = 0;
    const result = await resolveAttachTarget("volt", {
      listSessions: async () => [],
      loadFleet: () => [],
      listRemoteSessions: async () => {
        remoteLookups++;
        return [{
          alias: "alpha",
          node: "white",
          url: "http://white.wg:3461",
          sessions: [{ name: "05-volt-oracle", windows: [{ name: "volt-oracle" }] }],
        }];
      },
    }, { federation: true });

    expect(remoteLookups).toBe(1);
    expect(result).toEqual({
      tier: 3,
      node: "alpha",
      sessionName: "05-volt-oracle",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
    });
  });

  test("federation precheck prefers an exact remote session over fuzzy ambiguity", async () => {
    const result = await resolveAttachTarget("volt", {
      listSessions: async () => [],
      loadFleet: () => [],
      listRemoteSessions: async () => [
        {
          alias: "alpha",
          node: "white",
          url: "http://white.wg:3461",
          sessions: [{ name: "volt", windows: [{ name: "main" }] }],
        },
        {
          alias: "beta",
          node: "white",
          url: "http://white.wg:3462",
          sessions: [{ name: "05-volt-oracle", windows: [{ name: "main" }] }],
        },
      ],
    }, { federation: true });

    expect(result).toEqual({
      tier: 3,
      node: "alpha",
      sessionName: "volt",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
    });
  });

  test("federation precheck reports ambiguous remote candidates", async () => {
    const result = await resolveAttachTarget("volt", {
      listSessions: async () => [],
      loadFleet: () => [],
      listRemoteSessions: async () => [
        {
          alias: "alpha",
          node: "white",
          url: "http://white.wg:3461",
          sessions: [{ name: "05-volt-oracle", windows: [{ name: "main" }] }],
        },
        {
          alias: "beta",
          node: "white",
          url: "http://white.wg:3462",
          sessions: [{ name: "07-volt-lab", windows: [{ name: "main" }] }],
        },
      ],
    }, { federation: true });

    expect(result).toEqual({
      tier: 3,
      node: "alpha",
      sessionName: "05-volt-oracle",
      peerUrl: "http://white.wg:3461",
      sshAlias: "alpha@white.wg",
      ambiguousCandidates: ["alpha:05-volt-oracle", "beta:07-volt-lab"],
    });
  });

  test("local sleeping fleet matches skip the federation precheck", async () => {
    let remoteLookups = 0;
    const result = await resolveAttachTarget("volt", {
      listSessions: async () => [],
      loadFleet: () => [{ name: "volt-oracle", windows: [{ name: "main" }] }],
      listRemoteSessions: async () => {
        remoteLookups++;
        return [{ alias: "alpha", node: "white", url: "http://white.wg:3461", sessions: [] }];
      },
    }, { federation: true });

    expect(remoteLookups).toBe(0);
    expect(result).toEqual({ tier: 2, fleetName: "volt-oracle" });
  });


});
