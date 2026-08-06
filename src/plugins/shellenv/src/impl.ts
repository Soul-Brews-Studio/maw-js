/**
 * maw shellenv — emit shell init code for `eval "$(maw shellenv <shell>)"`.
 *
 * Pattern stolen from `direnv hook`, `zoxide init`, `starship init`,
 * `brew shellenv`, `rbenv init` — five precedents users already trust.
 *
 * The emitted snippet defines a `maw()` shell function that intercepts
 * `maw warp [<oracle>]` (does in-shell `cd` via `command maw locate
 * --path`) and passes every other subcommand through to the real
 * binary. `warp` is shell-only by design — see issue #812 / ADR 0001.
 *
 * Phase A: zsh + bash. fish deferred to v2 (genuinely different syntax).
 */
import { UserError } from "./internal/user-error";
import { zshSnippet } from "./snippets/zsh";
import { bashSnippet } from "./snippets/bash";

export const SUPPORTED_SHELLS = ["zsh", "bash"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

const HELP = `usage: maw shellenv <shell>

Emit shell init code for eval-style installation.

  Install (zsh):
    eval "$(maw shellenv zsh)"     # add to ~/.zshrc

  Install (bash):
    eval "$(maw shellenv bash)"    # add to ~/.bashrc

Available shells: ${SUPPORTED_SHELLS.join(", ")}
(fish deferred to v2 — see #812)

The emitted snippet installs a maw() function that adds:
  maw warp [<oracle>]    cd into an oracle's repo (default: mawjs)
  maw <other>            pass-through to the real binary

`;

export interface ShellenvOpts {
  help?: boolean;
}

function emit(shell: SupportedShell): string {
  switch (shell) {
    case "zsh":
      return zshSnippet();
    case "bash":
      return bashSnippet();
  }
}

function isSupported(s: string): s is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(s);
}

export async function cmdShellenv(
  shell: string | undefined,
  opts: ShellenvOpts = {},
): Promise<void> {
  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (!shell) {
    console.error(
      `Error: shell '' not supported. Available: ${SUPPORTED_SHELLS.join(", ")}`,
    );
    throw new UserError("missing shell argument");
  }

  if (!isSupported(shell)) {
    console.error(
      `Error: shell '${shell}' not supported. Available: ${SUPPORTED_SHELLS.join(", ")}`,
    );
    throw new UserError(`unsupported shell: ${shell}`);
  }

  console.log(emit(shell));
}
