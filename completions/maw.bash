# maw bash completion
_maw_complete() {
  local cur cmd words
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    words="$(maw completions commands 2>/dev/null)"
    COMPREPLY=( $(compgen -W "$words" -- "$cur") )
    return 0
  fi

  cmd="${COMP_WORDS[1]}"
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
complete -F _maw_complete maw
