import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "tmux",
  "version": "0.1.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "tmux control verbs — pane/session tools including peek, attach, pipe-pane, and synchronize-panes.",
  "author": "Soul-Brews-Studio",
  "cli": {
    "command": "tmux",
    "help": "maw tmux <peek|ls|attach|kill|open|close|zoom|pipe|sync> [...] — tmux pane/session tools; ls supports --json and --recent\n  open            join panes from other one-pane windows in this session; not a last-close undo\n  open <target>   split/show a target session; does not pair with the previous close\n  close [pane]    break panes into detached one-pane windows; processes keep running",
    "flags": {
      "--json": "boolean",
      "--all": "boolean",
      "--compact": "boolean",
      "--verbose": "boolean",
      "--roster": "boolean",
      "--fleet-only": "boolean",
      "--recent": "boolean",
      "-r": "boolean",
      "--readonly": "boolean",
      "--read-only": "boolean",
      "--input": "boolean",
      "--output": "boolean",
      "--no-output": "boolean",
      "--only-if-closed": "boolean",
      "-o": "boolean",
      "--force": "boolean",
      "--session": "boolean",
      "-s": "boolean"
    }
  },
  "weight": 10,
  "tier": "standard"
} as const);
