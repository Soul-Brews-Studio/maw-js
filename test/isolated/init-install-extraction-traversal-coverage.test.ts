import { describe, expect, mock, test } from "bun:test";

mock.module("child_process", () => ({
  execSync: () => "",
  spawnSync: () => ({ status: 0, stdout: "../escape.txt\n", stderr: "" }),
}));

const { extractTarball } = await import("../../src/vendor/mpr-plugins/init/internal/install-extraction.ts?init-install-extraction-traversal-coverage");

describe("vendor init install-extraction traversal guard", () => {
  test("rejects tarball entries that would escape the staging directory", () => {
    expect(extractTarball("plugin.tgz", "/tmp/staging")).toEqual({
      ok: false,
      error: 'tarball rejected: path traversal in entry "../escape.txt"',
    });
  });
});
