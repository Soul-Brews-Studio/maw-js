import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "maw-js/sdk";
import { discoverPackages } from "maw-js/plugin/registry";

const CORE_COMMANDS = [
  "hey", "send",
  "plugins", "plugin", "artifacts", "artifact",
  "agents", "agent", "audit", "serve",
  "update", "upgrade", "version",
];

const TOP_ALIASES = [
  "a", "kill", "split", "open", "close", "t", "layout", "zoom",
  "panes", "cleanup", "tile", "bring", "b", "ls", "wake", "new", "preflight",
];

const HELP = `usage: maw completions <commands|oracles|windows|zsh|bash|fish>

Generate maw shell completions or dynamic completion data.

Install examples:
  zsh:  mkdir -p ~/.zsh/completions && maw completions zsh > ~/.zsh/completions/_maw
        add to ~/.zshrc before compinit: fpath=(~/.zsh/completions $fpath)
  bash: maw completions bash > ~/.maw-completion.bash
        add to ~/.bashrc: source ~/.maw-completion.bash
  fish: mkdir -p ~/.config/fish/completions && maw completions fish > ~/.config/fish/completions/maw.fish

Data subcommands:
  commands   command names for first-position completion
  oracles    oracle names from fleet configs
  windows    tmux window/session names from fleet configs`;

function pluginCliNames(p: ReturnType<typeof discoverPackages>[number]): string[] {
  if (p.disabled) return [];
  if (p.manifest.cli) return [
    p.manifest.cli.command,
    ...(p.manifest.cli.aliases ?? []),
  ];
  if (p.kind === "ts" && p.entryPath) return [p.manifest.name];
  if (p.kind === "wasm" && p.wasmPath) return [p.manifest.name];
  return [];
}

function discoverCommands(): string[] {
  const cmds = new Set<string>([...CORE_COMMANDS, ...TOP_ALIASES]);
  try {
    for (const plugin of discoverPackages()) {
      for (const name of pluginCliNames(plugin)) cmds.add(name);
    }
  } catch {
    // Fallback if plugin discovery fails during early shell init.
    for (const name of ["ls", "peek", "hey", "wake", "bring", "b", "fleet", "tile", "team", "plugin", "serve"]) {
      cmds.add(name);
    }
  }
  return [...cmds].filter(Boolean).sort();
}

function completionTargets(kind: "oracles" | "windows"): string[] {
  const names = new Set<string>();
  try {
    for (const f of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8"));
      for (const w of (config.windows || [])) {
        if (kind === "oracles") {
          if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
        } else if (typeof w.name === "string") {
          names.add(w.name);
        }
      }
    }
  } catch { /* expected: fleet or tmux may not be initialized yet */ }
  return [...names].sort();
}

const ZSH_COMPLETION = `#compdef maw

_maw_dynamic_words() {
  local out
  out=(\${(f)"$(maw completions "$1" 2>/dev/null)"})
  print -l -- \${out[@]}
}

_maw_oracles() {
  local -a oracles
  oracles=(\${(f)"$(maw completions oracles 2>/dev/null)"})
  _describe 'oracle' oracles
}

_maw_windows() {
  local -a windows
  windows=(\${(f)"$(maw completions windows 2>/dev/null)"})
  _describe 'window' windows
}

_maw() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      local -a commands oracles all
      commands=(\${(f)"$(maw completions commands 2>/dev/null)"})
      oracles=(\${(f)"$(maw completions oracles 2>/dev/null)"})
      all=(\${commands[@]})
      for o in \${oracles[@]}; do all+=("$o:Oracle (peek/send shorthand)"); done
      _describe 'command' all
      ;;
    args)
      case $line[1] in
        peek|see|a|attach|bring|b|hey|send|tell|done|finish)
          _maw_windows
          ;;
        wake|about|info)
          _maw_oracles
          ;;
        completions)
          _values 'completion mode' commands oracles windows zsh bash fish --help
          ;;
        plugin|plugins)
          _values 'plugin action' ls list enable disable info standard full lean nuke
          ;;
        serve)
          _message 'port (default: 3456)'
          ;;
        *)
          _message 'argument'
          ;;
      esac
      ;;
  esac
}

_maw "$@"`;

const BASH_COMPLETION = `# maw bash completion
_maw_complete() {
  local cur cmd words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    words="$(maw completions commands 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$words" -- "$cur") )
    return 0
  fi

  cmd="\${COMP_WORDS[1]}"
  case "$cmd" in
    peek|see|a|attach|bring|b|hey|send|tell|done|finish)
      words="$(maw completions windows 2>/dev/null)"
      ;;
    wake|about|info)
      words="$(maw completions oracles 2>/dev/null)"
      ;;
    completions)
      words="commands oracles windows zsh bash fish --help"
      ;;
    plugin|plugins)
      words="ls list enable disable info standard full lean nuke"
      ;;
    *)
      words=""
      ;;
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _maw_complete maw`;

const FISH_COMPLETION = `# maw fish completion
complete -c maw -f -n '__fish_use_subcommand' -a '(maw completions commands 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from wake about info' -a '(maw completions oracles 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from peek see a attach bring b hey send tell done finish' -a '(maw completions windows 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from completions' -a 'commands oracles windows zsh bash fish --help'`;

export async function cmdCompletions(sub?: string) {
  const mode = (sub ?? "--help").toLowerCase();
  if (mode === "--help" || mode === "-h" || mode === "help") {
    console.log(HELP);
  } else if (mode === "commands") {
    console.log(discoverCommands().join(" "));
  } else if (mode === "oracles" || mode === "windows") {
    console.log(completionTargets(mode).join("\n"));
  } else if (mode === "fleet") {
    console.log("init ls renumber validate sync");
  } else if (mode === "pulse") {
    console.log("add ls list");
  } else if (mode === "zsh") {
    console.log(ZSH_COMPLETION);
  } else if (mode === "bash") {
    console.log(BASH_COMPLETION);
  } else if (mode === "fish") {
    console.log(FISH_COMPLETION);
  } else {
    console.error(HELP);
    throw new Error(`unknown completion mode: ${sub}`);
  }
}
