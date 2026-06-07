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
const updatePath = import.meta.resolve("../../src/cli/cmd-update.ts");

let updateArgs: unknown[] | null = null;

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
mock.module(updatePath, () => ({ runUpdate: async (...args: unknown[]) => { updateArgs = args; } }));

process.argv = ["bun", "src/cli.ts", "update", "--check"];
await import("../../src/cli.ts");
await new Promise((resolve) => setTimeout(resolve, 0));

describe("cli entry update coverage", () => {
  test("dispatches update through the real entry module", () => {
    expect(updateArgs).toEqual([["update", "--check"]]);
  });
});
