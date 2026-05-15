# maw fish completion
complete -c maw -f -n '__fish_use_subcommand' -a '(maw completions commands 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from wake about info' -a '(maw completions oracles 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from peek see a attach bring b hey send tell done finish' -a '(maw completions windows 2>/dev/null)'
complete -c maw -f -n '__fish_seen_subcommand_from completions' -a 'commands oracles windows zsh bash fish --help'
