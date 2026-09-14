# Shell completions

`spatius completion <shell>` writes a script to stdout for `bash`, `zsh`, or
`fish`. It does not edit startup files or require authentication. Do not pass
`--json`: the output is shell code, with no JSON envelope. Invalid arguments
still produce a structured error on stderr and exit with code 2.

Completions cover nested commands, help/schema paths, global and command flags,
allowed values (including `--fit=contain`), media inputs, and download paths.
The shell handles filename quoting and directory navigation. Account IDs, names,
tokens, and arbitrary values are not suggested. Pressing Tab queries the local
CLI command registry; it does not read credentials or make service requests.

## Bash

Bash 3.2 or newer is supported, including macOS's bundled Bash. The separate
`bash-completion` package is not required.

```bash
mkdir -p ~/.local/share/bash-completion/completions
spatius completion bash > ~/.local/share/bash-completion/completions/spatius
```

Add this line to `~/.bashrc`, then start a new shell or run the line once:

```bash
source ~/.local/share/bash-completion/completions/spatius
```

If your login shell only reads `~/.bash_profile`, ensure it sources `~/.bashrc`.
An existing bash-completion installation may already load the generated file;
in that case, the explicit source line is unnecessary.

## Zsh

To load completions on demand, save the script as `_spatius`:

```zsh
mkdir -p ~/.local/share/zsh/site-functions
spatius completion zsh > ~/.local/share/zsh/site-functions/_spatius
```

Add the directory to `fpath` in `~/.zshrc` **before** your existing `compinit` call
or shell framework initialization:

```zsh
fpath=(~/.local/share/zsh/site-functions $fpath)
```

If your configuration has no completion initialization, add this after `fpath`:

```zsh
autoload -Uz compinit
compinit
```

Alternatively, add `source <(spatius completion zsh)` after your existing
completion initialization. Choose one method to avoid duplicate setup.

## Fish

Fish 3.2 or newer is supported:

```fish
mkdir -p ~/.config/fish/completions
spatius completion fish > ~/.config/fish/completions/spatius.fish
```

If you set `XDG_CONFIG_HOME`, use `$XDG_CONFIG_HOME/fish/completions` instead.
Fish loads this file automatically. For only the current session, use
`spatius completion fish | source`.

## Recovery and removal

- Check `command -v spatius` and `spatius completion bash` (or your chosen shell).
  Use a globally installed executable on `PATH`; the scripts do not run `npx`
  or install packages during completion.
- If you see `compdef: command not found`, initialize Zsh's completion system
  before sourcing the script. If an autoloaded `_spatius` is not discovered,
  verify `fpath` order and run `compinit` again.
- After upgrading the CLI, regenerate saved scripts using the same command.
  Command and option suggestions follow the executable on `PATH`; regenerating
  also picks up changes to the shell adapter.
- If a shell is unsupported, inspect `spatius completion --help` for the
  supported choices. Use that shell's own script.
- To remove completions, remove your source/fpath line if you added one solely
  for Spatius, delete the generated file, and start a new shell. Keep shared
  completion directories and your general shell initialization intact.
