import { describe, test, expect } from "bun:test";
import { ansiToHtml, stripAnsi } from "../office/src/lib/ansi";

describe("stripAnsi", () => {
  test("removes basic color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("removes multiple codes", () => {
    expect(stripAnsi("\x1b[1;32mbold green\x1b[0m normal")).toBe("bold green normal");
  });

  test("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips 256-color codes", () => {
    expect(stripAnsi("\x1b[38;5;196mred256\x1b[0m")).toBe("red256");
  });

  test("strips RGB codes", () => {
    expect(stripAnsi("\x1b[38;2;255;0;0mrgb\x1b[0m")).toBe("rgb");
  });
});

describe("ansiToHtml", () => {
  test("returns plain text as-is", () => {
    expect(ansiToHtml("hello")).toBe("hello");
  });

  test("escapes HTML entities", () => {
    expect(ansiToHtml("<div>&</div>")).toBe("&lt;div&gt;&amp;&lt;/div&gt;");
  });

  test("converts basic foreground color", () => {
    const html = ansiToHtml("\x1b[31mred\x1b[0m");
    expect(html).toContain("color:#f38ba8");
    expect(html).toContain("red");
  });

  test("converts bold", () => {
    const html = ansiToHtml("\x1b[1mbold\x1b[0m");
    expect(html).toContain("font-weight:bold");
  });

  test("converts italic", () => {
    const html = ansiToHtml("\x1b[3mitalic\x1b[0m");
    expect(html).toContain("font-style:italic");
  });

  test("converts underline", () => {
    const html = ansiToHtml("\x1b[4munderline\x1b[0m");
    expect(html).toContain("text-decoration:underline");
  });

  test("converts background color", () => {
    const html = ansiToHtml("\x1b[41mbg\x1b[0m");
    expect(html).toContain("background:#f38ba8");
  });

  test("converts 256-color foreground", () => {
    const html = ansiToHtml("\x1b[38;5;82mgreen\x1b[0m");
    expect(html).toContain("color:");
    expect(html).toContain("green");
  });

  test("converts bright colors (90-97)", () => {
    const html = ansiToHtml("\x1b[91mbright red\x1b[0m");
    expect(html).toContain("color:");
    expect(html).toContain("bright red");
  });

  test("handles reset mid-stream", () => {
    const html = ansiToHtml("\x1b[31mred\x1b[0m normal");
    expect(html).toContain("</span>");
    expect(html).toContain("normal");
  });

  test("handles empty input", () => {
    expect(ansiToHtml("")).toBe("");
  });

  test("handles consecutive styles", () => {
    const html = ansiToHtml("\x1b[1m\x1b[31mbold red\x1b[0m");
    expect(html).toContain("font-weight:bold");
    expect(html).toContain("color:#f38ba8");
  });
});
