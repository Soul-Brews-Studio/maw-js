/**
 * Canonical ssh.ts mock — USE THIS for all mock.module calls on ssh.ts.
 *
 * @target-module src/core/transport/ssh.ts
 * (Checked by scripts/check-mock-export-sync.sh — #435)
 *
 * Why: mock.module writes to a process-global module registry. When test A
 * mocks ssh.ts with N exports and test B mocks it with N-3, test B leaves
 * the global polluted. When later test C imports the real ssh.ts, its
 * import resolves to the polluted mock and fails with:
 *
 *   SyntaxError: Export named 'selectWindow' not found in module ...
 *
 * The fix: every mock.module on ssh.ts MUST declare ALL 10 exports. This
 * helper gives you the full defensive default — override only what your
 * test actually cares about.
 *
 * Usage:
 *   import { mockSshModule } from "../helpers/mock-ssh";
 *   mock.module("../../src/core/transport/ssh", () =>
 *     mockSshModule({
 *       hostExec: myCustomExec,
 *     })
 *   );
 *
 * When ssh.ts gains a new export, add the stub here ONCE. All tests
 * automatically benefit.
 *
 * See #375 / alpha.33 for historical pollution incidents.
 */
export interface SshMockOverrides {
  hostExec?: (...args: any[]) => any;
  ssh?: (...args: any[]) => any;
  findWindow?: (...args: any[]) => any;
  listSessions?: (...args: any[]) => any;
  capture?: (...args: any[]) => any;
  sendKeys?: (...args: any[]) => any;
  selectWindow?: (...args: any[]) => any;
  switchClient?: (...args: any[]) => any;
  getPaneCommand?: (...args: any[]) => any;
  getPaneCommands?: (...args: any[]) => any;
  getPaneInfos?: (...args: any[]) => any;
  HostExecError?: any;
}

// #431 added HostExecError — mocks must re-export the class shape or
// imports of the real module leak the pollution pattern above.
class MockHostExecError extends Error {
  readonly target: string;
  readonly transport: "local" | "ssh";
  readonly underlying: Error;
  readonly exitCode?: number;
  constructor(target: string, transport: "local" | "ssh", underlying: Error, exitCode?: number) {
    super(`[${transport}:${target}] ${underlying.message}`);
    this.name = "HostExecError";
    this.target = target;
    this.transport = transport;
    this.underlying = underlying;
    this.exitCode = exitCode;
  }
}

export function mockSshModule(overrides: SshMockOverrides = {}) {
  return {
    // All real exports from src/core/transport/ssh.ts, stubbed.
    // Override any of these via the argument.
    hostExec: async () => "",
    ssh: async () => "",
    findWindow: () => null,
    listSessions: async () => [],
    capture: async () => "",
    sendKeys: async () => {},
    selectWindow: async () => {},
    switchClient: async () => {},
    getPaneCommand: async () => "",
    getPaneCommands: async () => ({}),
    getPaneInfos: async () => ({}),
    HostExecError: MockHostExecError,
    ...overrides,
  };
}
