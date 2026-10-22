/**
 * route-comm-send.test.ts — #1388 regression guard.
 *
 * Top-level `maw send` is message delivery, not raw pane typing. It must
 * route through the same core cmdSend path as `maw hey`, which appends Enter
 * through the transport and reports `delivered` instead of leaving text in the
 * target prompt buffer.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

const calls: unknown[][] = [];
const peekCalls: unknown[][] = [];
const logs: string[] = [];
const errors: string[] = [];

mock.module("../../src/commands/shared/comm", () => ({
  cmdSend: async (...args: unknown[]) => { calls.push(args); },
  cmdPeek: async (...args: unknown[]) => { peekCalls.push(args); },
}));

const origLog = console.log;
const origError = console.error;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

const { routeComm } = await import("../../src/cli/route-comm");

afterAll(() => { console.log = origLog; console.error = origError; });

beforeEach(() => {
  calls.length = 0;
  peekCalls.length = 0;
  logs.length = 0;
  errors.length = 0;
});

describe("routeComm — top-level send uses core delivery (#1388)", () => {
  test("maw send <target> <message> routes through cmdSend like maw hey", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "world"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello world", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  test("--force is preserved as deprecated compatibility and stripped from the delivered message", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "--force"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", true, { approve: false, trust: false, inboxOnly: false }],
    ]);
    expect(errors.join("\n")).toContain("--force is deprecated");
  });

  test("--inbox is stripped from the delivered message and opts out of pane injection", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "hello", "--inbox"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", false, { approve: false, trust: false, inboxOnly: true }],
    ]);
  });

  test("maw hey remains on the same core path", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "ping"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "ping", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  test("maw send --help prints usage instead of treating --help as a target (#1531)", async () => {
    const handled = await routeComm("send", ["send", "--help"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("usage: maw send");
    expect(logs.join("\n")).toContain("MAW_SENDER");
    expect(logs.join("\n")).toContain("local:");
  });

  test("maw hey -h prints usage instead of treating -h as a target (#1531)", async () => {
    const handled = await routeComm("hey", ["hey", "-h"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("usage: maw hey");
    expect(logs.join("\n")).toContain("MAW_SENDER");
  });

  test("--approve/--trust are stripped from the delivered message and passed as delivery opts", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "hello", "--approve", "--trust"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", false, { approve: true, trust: true, inboxOnly: false }],
    ]);
  });

  test("--from may appear before target and is passed as a sender override", async () => {
    const handled = await routeComm("hey", ["hey", "--from", "alpha:volt-oracle", "m5:mawjs", "hello"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["m5:mawjs", "hello", false, { approve: false, trust: false, inboxOnly: false, from: "alpha:volt-oracle" }],
    ]);
  });

  test("--from=value is stripped from delivered message", async () => {
    const handled = await routeComm("send", ["send", "local:mawjs", "hello", "--from=alpha:volt-oracle"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello", false, { approve: false, trust: false, inboxOnly: false, from: "alpha:volt-oracle" }],
    ]);
  });

  test("--from without a value reports a usage error", async () => {
    await expect(routeComm("hey", ["hey", "--from", "--inbox", "m5:mawjs", "hello"])).rejects.toThrow("missing value for --from");

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("missing value for --from");
    expect(errors.join("\n")).toContain("node:oracle");
  });

  test("missing target prints usage to stderr and throws a UserError", async () => {
    await expect(routeComm("send", ["send"])).rejects.toThrow("missing target and message");

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("usage: maw send");
    expect(errors.join("\n")).toContain("MAW_SENDER");
  });

  test("missing message names the target and throws a UserError", async () => {
    await expect(routeComm("hey", ["hey", "local:mawjs"])).rejects.toThrow("missing message for 'local:mawjs'");

    expect(calls).toEqual([]);
    const text = errors.join("\n");
    expect(text).toContain("✗ missing message for target 'local:mawjs'");
    expect(text).toContain("maw hey local:mawjs <message>");
  });

  test("non-comm commands are not handled", async () => {
    await expect(routeComm("wake", ["wake", "mawjs"])).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(peekCalls).toEqual([]);
  });

  test("maw peek routes through federation-aware cmdPeek, not tmux alias", async () => {
    const handled = await routeComm("peek", ["peek", "m5:mawjs"]);

    expect(handled).toBe(true);
    expect(peekCalls).toEqual([["m5:mawjs"]]);
    expect(calls).toEqual([]);
  });
});

/**
 * ด่าน fail-closed สำหรับ flag ที่ไม่รู้จัก
 *
 * ก่อนแพตช์: token ใด ๆ ที่ไม่ตรง flag ที่รู้จัก ตกลงไปเป็น "เนื้อข้อความ" แล้วคืน rc=0
 * ⇒ `maw hey morse --file /path/msg.md` ส่งบรรทัดเดียวว่า `--file /path/msg.md` ให้ผู้รับ
 *   โดยพิมพ์ `delivered` และไม่มีอะไรเตือน (volt พลาดข้อนี้ 3 ครั้งใน 4 วัน)
 * 📎 morse: นี่คือ fail-open ⇒ วินัยคนพิมพ์กันไม่ได้ ต้องให้เครื่องปฏิเสธ
 */
describe("routeComm — flag ที่ไม่รู้จักต้องถูกปฏิเสธ ไม่ใช่กลายเป็นข้อความ", () => {
  test("flag แปลกหลัง target = พิมพ์ผิด ⇒ throw และไม่ส่งอะไรเลย", async () => {
    await expect(routeComm("hey", ["hey", "local:mawjs", "--file", "/tmp/msg.md"]))
      .rejects.toThrow("unknown flag: --file");
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("unknown flag: --file");
  });

  test("flag แปลกก่อน target ก็ถูกปฏิเสธเหมือนกัน", async () => {
    await expect(routeComm("send", ["send", "--file", "local:mawjs", "hello"]))
      .rejects.toThrow("unknown flag: --file");
    expect(calls).toEqual([]);
  });

  test("`--` คั่นแล้ว ข้อความที่ขึ้นต้นด้วย -- ส่งได้ปกติ", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "--", "--file", "/tmp/msg.md"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "--file /tmp/msg.md", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  // 🔴 near-miss จาก traffic จริง (📎 แม่ Labubu 18.08 · กวาด inbox ทุกบ้าน 3,913 บรรทัด)
  //    `---` = บรรทัดแรกของ YAML frontmatter · มีเอกสารเต็มใบ **4 ใบที่เคยส่งสำเร็จ** ขึ้นต้นแบบนี้
  //    ด่านฉบับแรก (`startsWith("--")`) จะปฏิเสธทั้ง 4 ใบ ทั้งที่ไม่ใช่การพิมพ์ผิดเลย
  //    เคสนี้คือสิ่งเดียวที่กันไม่ให้ใครแก้ด่านกลับไปกว้างเหมือนเดิม — ห้ามลบ
  test("เอกสารที่ขึ้นต้นด้วย --- (frontmatter) ต้องส่งได้ ไม่ใช่ถูกปฏิเสธ", async () => {
    const doc = "---\nfrom: volt\nto: morse\n---\n\nเนื้อความ";
    const handled = await routeComm("hey", ["hey", "local:mawjs", doc]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", doc, false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  test("`--` เปล่า ๆ ที่ไม่มีตัวอักษรตาม ไม่ถูกอ่านเป็น flag แปลก", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "--", "-- ขีดสองอันเฉย ๆ"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "-- ขีดสองอันเฉย ๆ", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });

  // negative control — ด่านต้องไม่กว้างเกินไป: `--` ที่โผล่ "หลังเนื้อข้อความเริ่มแล้ว"
  // เป็นส่วนหนึ่งของประโยค ไม่ใช่ flag ⇒ พฤติกรรมเดิมต้องไม่เปลี่ยน
  test("ข้อความที่มี --word อยู่กลางประโยค ยังส่งได้เหมือนเดิม", async () => {
    const handled = await routeComm("hey", ["hey", "local:mawjs", "hello", "--world"]);

    expect(handled).toBe(true);
    expect(calls).toEqual([
      ["local:mawjs", "hello --world", false, { approve: false, trust: false, inboxOnly: false }],
    ]);
  });
});
