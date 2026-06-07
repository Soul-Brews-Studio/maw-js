import { describe, expect, mock, test } from "bun:test";

const instancePresetPath = import.meta.resolve("../../src/cli/instance-preset.ts");
const auditPath = import.meta.resolve("../../src/core/fleet/audit.ts");
const verbosityPath = import.meta.resolve("../../src/cli/verbosity.ts");
const usagePath = import.meta.resolve("../../src/cli/usage.ts");
const registryPath = import.meta.resolve("../../src/cli/command-registry.ts");
const bootstrapPath = import.meta.resolve("../../src/cli/plugin-bootstrap.ts");
const autoRestorePath = import.meta.resolve("../../src/cli/auto-restore.ts");
const dispatchPath = import.meta.resolve("../../src/cli/dispatch.ts");
const errorHandlerPath = import.meta.resolve("../../src/cli/error-handler.ts");
const versionPath = import.meta.resolve("../../src/cli/cmd-version.ts");

let printed: string[] = [];

mock.module(instancePresetPath, () => ({ applyInstancePreset: () => undefined }));
mock.module(auditPath, () => ({ logAudit: () => undefined }));
mock.module(verbosityPath, () => ({
  setVerbosityFlags: () => undefined,
  isSilent: () => false,
  isQuiet: () => true,
  verbose: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
}));
mock.module(usagePath, () => ({ usage: () => undefined }));
mock.module(registryPath, () => ({ scanCommands: async () => undefined }));
mock.module(bootstrapPath, () => ({ runBootstrap: async () => undefined }));
mock.module(autoRestorePath, () => ({ maybeAutoRestore: async () => undefined }));
mock.module(dispatchPath, () => ({ dispatchCommand: async () => undefined }));
mock.module(errorHandlerPath, () => ({ handleTopLevelError: () => undefined }));
mock.module(versionPath, () => ({ getVersionString: () => "maw-version-covered" }));

process.argv = ["bun", "src/cli.ts", "--version"];
console.log = (...args: unknown[]) => printed.push(args.map(String).join(" "));
await import("../../src/cli.ts");
await new Promise((resolve) => setTimeout(resolve, 0));

describe("cli entry version coverage", () => {
  test("prints version through the real entry module", () => {
    expect(printed).toEqual(["maw-version-covered"]);
  });
});
