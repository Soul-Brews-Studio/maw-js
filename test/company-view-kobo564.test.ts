import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roomHtml } from "../src/views/room";
import { messagesHtml } from "../src/views/messages";

// kobo-564 — the class of bug (kobo-513): room.ts/messages.ts each serve their
// entire client page as ONE big template literal. A backslash written in that
// literal is JS SOURCE TEXT, and it goes through JS's own escape-cooking when
// the file is loaded — `\s`, `\d`, `\w`, `\.` etc. are not recognised escapes,
// so the backslash is silently DROPPED (`\s` -> `s`). The regex still looks
// plausible and code review of the SOURCE passes, because the source is
// correct — only the SERVED string is wrong (room.ts:862, tagQueryAt, fixed
// in this card by writing `\\s` so it survives cooking as `\s`).
//
// This only matters for a backslash the author wants to SURVIVE as a literal
// backslash. `\n`/`\t`/`\\`/`\'`/`\"`/`` \` ``/`\0`/`\x..`/`\u....`/`\$` are all
// recognised escapes that intentionally produce a different character (e.g.
// messages.ts uses `\n` to join lines with a real newline) — those are not
// bugs, and this guard must not flag them.
const SAFE_ESCAPES = new Set(["'", '"', "`", "\\", "b", "f", "n", "r", "t", "v", "0", "x", "u", "$", "\n"]);

function findDangerousBackslashes(text: string): Array<{ match: string; index: number }> {
  const dangerous: Array<{ match: string; index: number }> = [];
  const re = /\\(.)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!SAFE_ESCAPES.has(m[1])) dangerous.push({ match: m[0], index: m.index });
  }
  return dangerous;
}

// Coverage ceiling — read this before trusting "green" as "the whole app is
// safe". Only files shaped as ONE giant template literal (exactly 2
// backticks in the whole file — the opening `return \`` and its matching
// close) are covered, because that shape is what lets this test safely slice
// "the literal's raw text" out of the file with `indexOf`/`lastIndexOf`
// instead of a real parser. `company.ts` (20 backticks) and
// `company-status.ts` (6 backticks) serve the SAME shape of giant client-JS
// literal but also contain other backtick-delimited strings, so a naive
// slice would grab the wrong span — they are NOT covered here. A new
// `*Html(): string` view added later is NOT auto-covered either: it must be
// added to COVERED_VIEWS by hand, same as company.ts/company-status.ts would
// need to be if someone builds a correct extractor for their shape.
const COVERED_VIEWS: Array<{ name: string; relFile: string; served: string }> = [
  { name: "room.ts", relFile: "src/views/room.ts", served: roomHtml() },
  { name: "messages.ts", relFile: "src/views/messages.ts", served: messagesHtml() },
];

function literalSlice(relFile: string): string {
  const raw = readFileSync(join(import.meta.dir, "..", relFile), "utf8");
  const backtickCount = (raw.match(/`/g) ?? []).length;
  if (backtickCount !== 2) {
    throw new Error(
      `${relFile}: expected exactly 2 backticks (this test's single-literal slice assumption), found ${backtickCount} — ` +
        `the file's shape changed, this guard's extraction is no longer valid for it, don't just adjust the number`,
    );
  }
  return raw.slice(raw.indexOf("`") + 1, raw.lastIndexOf("`"));
}

describe("view template literals — no backslash silently eaten by escape-cooking (kobo-564)", () => {
  for (const { name, relFile } of COVERED_VIEWS) {
    test(`${name}: source has zero backslashes that won't survive into the served string`, () => {
      const dangerous = findDangerousBackslashes(literalSlice(relFile));
      expect(dangerous).toEqual([]);
    });
  }
});

// AC's mutation-test requirement: prove this guard actually watches, by
// reintroducing the exact kobo-513/kobo-564 bug and confirming it goes red.
// Done against the detector directly (not by mutating the real file and
// re-importing it) so this test is fast and needs no file-system round trip.
describe("findDangerousBackslashes — mutation test (kobo-564)", () => {
  test("flags a single backslash that would be eaten (the original kobo-513 bug, reintroduced)", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "src/views/room.ts"), "utf8");
    const mutated = raw.replace("(?:^|\\\\s)@", "(?:^|\\s)@"); // put the pre-fix single-backslash text back
    expect(mutated).not.toBe(raw); // sanity: the replace actually matched something
    const dangerous = findDangerousBackslashes(mutated.slice(mutated.indexOf("`") + 1, mutated.lastIndexOf("`")));
    expect(dangerous.map((d) => d.match)).toContain("\\s");
  });

  test("does not flag a legitimate single-char escape (messages.ts's `\\n` line-join)", () => {
    expect(findDangerousBackslashes("['a', 'b'].join('\\n')")).toEqual([]);
  });

  test("does not flag a correctly doubled backslash (what the room.ts fix produces)", () => {
    expect(findDangerousBackslashes("/(?:^|\\\\s)@([a-z0-9]+)$/i")).toEqual([]);
  });
});

// AC1/AC — behavioural proof the FIX works, not just a string-pin (kobo-445's
// own scar: a test that only checks "the source contains this line" stays
// green even if the served behaviour is destroyed). Extract tagQueryAt()
// straight out of the SERVED string (roomHtml(), not the source file) and
// run it — this is exactly what the browser executes.
function extractTagQueryAt(html: string) {
  const start = html.indexOf("function tagQueryAt(value, caret) {");
  const end = html.indexOf("\n}", start) + 2;
  if (start === -1 || end === 1) {
    throw new Error("extractTagQueryAt: markers not found — tagQueryAt's text in room.ts changed, update this test's markers");
  }
  const src = html.slice(start, end);
  const factory = new Function(`${src}\nreturn tagQueryAt;`);
  return factory();
}

describe("tagQueryAt — @-mention picker opens on the served page (kobo-564 AC1)", () => {
  const tagQueryAt = extractTagQueryAt(roomHtml());

  test("opens mid-sentence after a space", () => {
    expect(tagQueryAt("hello @eq3", "hello @eq3".length)).not.toBeNull();
    expect(tagQueryAt("x @eq3", "x @eq3".length)).not.toBeNull();
  });

  test("does not open when @ is stuck to the end of a word", () => {
    expect(tagQueryAt("things@eq3", "things@eq3".length)).toBeNull();
  });

  test("opens at the start of the message", () => {
    expect(tagQueryAt("@eq3", "@eq3".length)).not.toBeNull();
  });
});
