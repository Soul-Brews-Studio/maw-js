import { describe, expect, test } from "bun:test";
import {
  daysFromFile,
  deduplicateItems,
  extractDetail,
  extractRepo,
  extractSection,
  extractTitle,
  isNoise,
  shareKeywords,
} from "../../src/vendor/mpr-plugins/dream/impl";

type DreamItem = Parameters<typeof deduplicateItems>[0][number];

describe("dream extraction helpers", () => {
  test("extractTitle prefers a substantial H1 over later metadata", () => {
    const content = `---\ntitle: ignored\n---\n# Retrospective captured the plugin coverage gap\nSummary: this should not win`;

    expect(extractTitle(content, "/vault/maw-js/ψ/memory/logs/2026-05-18_note.md")).toBe(
      "Retrospective captured the plugin coverage gap",
    );
  });

  test("extractTitle falls back to session summary and then cleaned filename with repo prefix", () => {
    expect(
      extractTitle(
        "---\n# tiny\nSession Summary: Coverage pass found dream plugin seams worth testing\n",
        "/vault/maw-js/ψ/memory/logs/info/2026-05-18_dream-pass.md",
      ),
    ).toBe("Coverage pass found dream plugin seams worth testing");

    expect(
      extractTitle(
        "---\ntitle: too short\n---",
        "/vault/maw-js-oracle/ψ/memory/logs/info/2026-05-18_dream-coverage-thread.md",
      ),
    ).toBe("maw-js — dream coverage thread");
  });

  test("extractSection handles inline values, multiline sections, and stopping headings", () => {
    expect(extractSection("Next Steps: - add focused tests around extraction helpers", "Next Steps")).toBe(
      "add focused tests around extraction helpers",
    );

    const content = `## Summary\n- First useful captured point\n- Second useful captured point\n\n**Next Heading**\n- should not leak`;
    expect(extractSection(content, "Summary")).toBe("First useful captured point - Second useful captured point");

    expect(extractSection("## Summary:\nshort\n", "Missing")).toBeNull();
  });

  test("extractDetail prefers structured sections and otherwise skips metadata", () => {
    expect(
      extractDetail(
        `title: Ignore metadata\nSummary:\n- Focused dream helpers now have concrete tests\n## Next\nThis longer prose should not win.`,
      ),
    ).toBe("Focused dream helpers now have concrete tests");

    expect(
      extractDetail(
        `---\ntags: test\ncreated: now\nThis first substantial prose line becomes the fallback detail for the dream item.`,
      ),
    ).toBe("This first substantial prose line becomes the fallback detail for the dream item.");
  });

  test("extractRepo resolves normal psi paths, worktree agent paths, and unknown paths", () => {
    expect(extractRepo("/vault/maw-js-oracle/ψ/memory/logs/info/note.md")).toBe("maw-js");
    expect(extractRepo("/vault/maw-js/.claude/worktrees/agent-7/ψ/inbox/handoff/note.md")).toBe("maw-js");
    expect(extractRepo("/vault/no-psi-here/note.md")).toBe("unknown");
  });

  test("extractRepo resolves psi directly under worktrees back to the owning repo", () => {
    expect(extractRepo("/vault/maw-js/.claude/worktrees/ψ/inbox/handoff/note.md")).toBe("maw-js");
  });
});

describe("dream filtering and matching helpers", () => {
  test("isNoise rejects market-trading titles without rejecting ordinary project work", () => {
    expect(isNoise("BTC long position close plan")).toBe(true);
    expect(isNoise("Dream plugin coverage plan")).toBe(false);
  });

  test("shareKeywords counts meaningful overlapping terms and ignores stop words", () => {
    expect(shareKeywords("lesson learned dream plugin coverage seam", "dream coverage seam regression", 3)).toBe(true);
    expect(shareKeywords("the and this session learned", "the and this session learned", 1)).toBe(false);
  });

  test("deduplicateItems keeps first matching category/project/title-prefix item only", () => {
    const first = dreamItem({ title: "Dream plugin coverage seam keeps leaking state" });
    const duplicate = dreamItem({ title: "Dream plugin coverage seam keeps leaking state after retry", detail: "later" });
    const differentProject = dreamItem({ project: "other", title: first.title });
    const differentCategory = dreamItem({ category: "plan", title: first.title });

    expect(deduplicateItems([first, duplicate, differentProject, differentCategory])).toEqual([
      first,
      differentProject,
      differentCategory,
    ]);
  });

  test("daysFromFile derives age from slash or dash date paths and uses 999 when absent", () => {
    const originalNow = Date.now;
    Date.now = () => new Date("2026-05-18T00:00:00.000Z").getTime();
    try {
      expect(daysFromFile("/vault/2026-05-17_dream.md")).toBe(1);
      expect(daysFromFile("/vault/2026/05/16/dream.md")).toBe(2);
      expect(daysFromFile("/vault/no-date/dream.md")).toBe(999);
    } finally {
      Date.now = originalNow;
    }
  });
});

function dreamItem(overrides: Partial<DreamItem> = {}): DreamItem {
  return {
    category: "pain",
    title: "Dream plugin coverage seam",
    detail: "detail",
    source: "source.md",
    project: "maw-js",
    confidence: "high",
    daysAgo: 0,
    ...overrides,
  };
}
