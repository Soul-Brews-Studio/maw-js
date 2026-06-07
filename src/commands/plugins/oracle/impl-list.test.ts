import { describe, it, expect } from "bun:test";
import { formatRow, type EnrichedEntry } from "./impl-list";

function enriched(partial: Partial<EnrichedEntry> & { name?: string } = {}): EnrichedEntry {
  const name = partial.name ?? "neo";
  return {
    entry: {
      org: "Soul-Brews-Studio",
      repo: `${name}-oracle`,
      name,
      local_path: `/tmp/${name}-oracle`,
      has_psi: true,
      has_fleet_config: false,
      budded_from: null,
      budded_at: null,
      federation_node: null,
      detected_at: "2026-05-17T00:00:00.000Z",
    },
    awake: false,
    session: null,
    lineage: {
      hasPsi: true,
      hasFleetConfig: false,
      isAwake: false,
      inAgents: false,
      federationNode: undefined,
    },
    sources: ["oracles-json"],
    ...partial,
  };
}

describe("formatRow", () => {
  it("renders fleet+awake entries with federation node", () => {
    const row = formatRow(
      enriched({
        awake: true,
        session: "team",
        lineage: {
          hasPsi: true,
          hasFleetConfig: true,
          isAwake: true,
          inAgents: true,
          federationNode: "white",
        },
      }),
      { showPath: false },
    );

    expect(row).toContain("fleet+awake");
    expect(row).toContain("oracle (ψ/)");
    expect(row).toContain("· white");
    expect(row).not.toContain("/tmp/neo-oracle");
  });

  it("renders sleeping fleet-only manifest entries as not cloned", () => {
    const row = formatRow(
      enriched({
        entry: {
          ...enriched().entry,
          local_path: "",
          has_psi: false,
          has_fleet_config: true,
        },
        lineage: {
          hasPsi: false,
          hasFleetConfig: true,
          isAwake: false,
          inAgents: false,
          federationNode: undefined,
        },
      }),
      { showPath: true },
    );

    expect(row).toContain("fleet      ");
    expect(row).toContain("fleet-only");
    expect(row).toContain("not cloned");
  });

  it("renders filesystem-only rows with register hint and optional path", () => {
    const row = formatRow(enriched(), { showPath: true });

    expect(row).toContain("fs         ");
    expect(row).toContain("oracle (ψ/)");
    expect(row).toContain("not registered");
    expect(row).toContain("/tmp/neo-oracle");
  });

  it("renders uncertain rows and pads nickname display by visible width", () => {
    const row = formatRow(
      enriched({
        entry: {
          ...enriched().entry,
          name: "morpheus",
          nickname: "Morph",
          local_path: "/tmp/morpheus-oracle",
          has_psi: false,
          has_fleet_config: false,
        },
        lineage: {
          hasPsi: false,
          hasFleetConfig: false,
          isAwake: false,
          inAgents: false,
          federationNode: undefined,
        },
      }),
      { showPath: false },
    );

    expect(row).toContain("fs (?)");
    expect(row).toContain("morpheus");
    expect(row).toContain("Morph");
    expect(row).toContain("uncertain");
    expect(row).toContain("not registered");
  });

  it("renders budded lineage before generic filesystem lineage", () => {
    const row = formatRow(
      enriched({
        entry: {
          ...enriched().entry,
          budded_from: "trinity",
        },
        lineage: {
          hasPsi: true,
          hasFleetConfig: false,
          isAwake: false,
          inAgents: false,
          federationNode: undefined,
        },
      }),
      { showPath: false },
    );

    expect(row).toContain("budded from trinity");
  });
});
