/**
 * kobo-470 — `maw inbox status` prints identical output whether the box is
 * genuinely empty or the WRITER is disabled (MAW_HEY_INBOX_AUTOWRITE=0, or
 * MAW_TEST_MODE — the same fallback that turns the writer off in every test
 * suite). Three people read that identical line the same night, each time
 * concluding "no work", each time wrong about why.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildInboxStatus, formatInboxStatus, formatInboxStatusList, compareInboxStatusForList, type InboxStatus } from "./impl";

// %11 c4's trap: MAW_TEST_MODE is BOTH the suite's own env AND the fallback that
// disables the writer (receiver-inbox.ts:66, `env.MAW_TEST_MODE !== "1"`). Any
// test that wants writerEnabled=true must either override via `deps.writerEnabled`
// (buildInboxStatus's test seam) or explicitly set MAW_HEY_INBOX_AUTOWRITE=1 to
// win over the MAW_TEST_MODE fallback — never assume the ambient env supplies it.
const envKeys = ["MAW_HEY_INBOX_AUTOWRITE", "MAW_TEST_MODE"] as const;
const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
function restoreEnv(): void {
  for (const k of envKeys) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(restoreEnv);

function emptyTarget(suffix: string) {
  return { oracle: `kobo470-${suffix}`, inboxDir: join(tmpdir(), `kobo470-nonexistent-${suffix}`) };
}

function targetWithOneUnread(suffix: string) {
  const inboxDir = mkdtempSync(join(tmpdir(), `kobo470-inbox-${suffix}-`));
  writeFileSync(
    join(inboxDir, "2026-07-28_00-00_someone_hi.md"),
    "---\nfrom: someone\nto: me\ntimestamp: 2026-07-28T00:00:00Z\nread: false\n---\nhi\n",
  );
  return { oracle: `kobo470-${suffix}`, inboxDir };
}

describe("kobo-470 — writer-disabled status must be structurally distinct from a real empty box", () => {
  it("formatInboxStatus: writer disabled produces a structurally different line than a real empty box — a reader skimming can't confuse them", () => {
    const disabled = buildInboxStatus(emptyTarget("d1"), Date.now(), {}, { writerEnabled: () => false });
    const enabled = buildInboxStatus(emptyTarget("e1"), Date.now(), {}, { writerEnabled: () => true });
    const disabledLine = formatInboxStatus(disabled);
    const enabledLine = formatInboxStatus(enabled);
    expect(disabledLine).not.toBe(enabledLine);
    expect(disabledLine).not.toContain("UNREAD 0 (oldest"); // not just the old line with a suffix swapped
  });

  it("formatInboxStatus: writer disabled at unread>0 still says writer-disabled, not red-escalation", () => {
    const status = buildInboxStatus(targetWithOneUnread("d2"), Date.now(), {}, { writerEnabled: () => false });
    expect(status.unread).toBe(1); // proves this isn't accidentally testing the unread=0 case
    const line = formatInboxStatus(status);
    expect(line).toContain("WRITER DISABLED");
    expect(line).not.toContain("not draining"); // disabled must win over the red-escalation message, not just at 0
  });

  it("buildInboxStatus reads writerEnabled from receiverInboxAutoWriteEnabled(), not re-derived", () => {
    // no `deps.writerEnabled` override here — this is the ONLY test proving the real
    // wiring, everything else above uses the DI seam deliberately (%11 c4's trap).
    process.env.MAW_HEY_INBOX_AUTOWRITE = "0";
    delete process.env.MAW_TEST_MODE;
    expect(buildInboxStatus(emptyTarget("w1"), Date.now(), {}).writerEnabled).toBe(false);

    process.env.MAW_HEY_INBOX_AUTOWRITE = "1";
    expect(buildInboxStatus(emptyTarget("w2"), Date.now(), {}).writerEnabled).toBe(true);
  });

  it("formatInboxStatus: writer enabled + real empty box → unchanged from current output", () => {
    const status = buildInboxStatus(emptyTarget("e2"), Date.now(), {}, { writerEnabled: () => true });
    expect(status.level).toBe("green");
    expect(formatInboxStatus(status)).toBe(
      "🟢 UNREAD 0 (oldest none, last archive never, Δ 0 last cycle)",
    );
  });

  it("the writer-disabled line cannot be mistaken for a healthy quiet inbox — distinct leading symbol, none of the healthy-state markers", () => {
    const disabled = buildInboxStatus(emptyTarget("d3"), Date.now(), {}, { writerEnabled: () => false });
    const enabled = buildInboxStatus(emptyTarget("e3"), Date.now(), {}, { writerEnabled: () => true });
    const disabledLine = formatInboxStatus(disabled);
    const enabledLine = formatInboxStatus(enabled);

    // property-based, not string-equality — survives copy edits, fails if the two
    // states re-converge (e.g. a future "unify the formatting" tidy-up)
    expect(disabledLine).not.toContain("🔴");
    expect(disabledLine).not.toContain("🟢");
    expect(disabledLine).not.toContain("not draining");
    const disabledSymbol = disabledLine.trim()[0];
    const enabledSymbol = enabledLine.trim()[0];
    expect(disabledSymbol).not.toBe(enabledSymbol);
  });
});

describe("kobo-470 c7 — the SIBLING renderer (formatInboxStatusList / `status --all`, `ls`) had the identical defect, unpatched in round one", () => {
  it("formatInboxStatusList: a writer-disabled entry renders unmistakably, not as a healthy 🟢 with a plain count", () => {
    const disabled = buildInboxStatus(emptyTarget("list-d1"), Date.now(), {}, { writerEnabled: () => false });
    const enabled = buildInboxStatus(emptyTarget("list-e1"), Date.now(), {}, { writerEnabled: () => true });
    const [disabledLine, enabledLine] = formatInboxStatusList([disabled]).split("\n").concat(formatInboxStatusList([enabled]));
    expect(disabledLine).not.toContain("🟢");
    expect(disabledLine).not.toContain("🔴");
    expect(disabledLine).toContain("WRITER DISABLED");
    expect(disabledLine.trim()[0]).not.toBe(enabledLine.trim()[0]);
  });

  it("compareInboxStatusForList: a disabled-writer entry sorts ahead of BOTH red and green — never ranked as though its count were evidence", () => {
    const red = buildInboxStatus(targetWithOneUnread("sort-red"), Date.now(), {}, { writerEnabled: () => true });
    red.reasons = ["unread>50"]; red.level = "red"; // force red without needing 51 real fixture files
    const green = buildInboxStatus(emptyTarget("sort-green"), Date.now(), {}, { writerEnabled: () => true });
    const disabled = buildInboxStatus(emptyTarget("sort-disabled"), Date.now(), {}, { writerEnabled: () => false });

    const sorted = [green, red, disabled].sort(compareInboxStatusForList);
    expect(sorted[0]).toBe(disabled); // ahead of red, not just ahead of green
    expect(sorted[1]).toBe(red);
    expect(sorted[2]).toBe(green);
  });
});
