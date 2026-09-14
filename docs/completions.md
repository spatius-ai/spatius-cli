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

## Interactive installation

```sh
npx @spatius/cli install
```

After installing or finding a persistent CLI, the installer offers completion
setup. It looks through npm's wrapper processes for Bash, Zsh, or Fish and
suggests the shell it finds. If process inspection is unavailable, it uses
the configured login shell (`SHELL`) as a suggestion. You can choose another
shell or Skip; an unknown shell defaults to Skip. The temporary npx executable
and npm-injected project bin directories do not count as a persistent CLI.

The selected shell controls which files are configured:

| Shell | Completion script                                 | Startup configuration                                                                                                                            |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bash  | `$XDG_DATA_HOME/spatius/completions/spatius.bash` | `~/.bashrc` and the first existing file among `~/.bash_profile`, `~/.bash_login`, and `~/.profile`; creates `.bash_profile` only when none exist |
| Zsh   | `$XDG_DATA_HOME/spatius/completions/spatius.zsh`  | `$ZDOTDIR/.zshrc`, or `~/.zshrc` when `ZDOTDIR` is not exported; initializes completions if needed                                               |
| Fish  | `$XDG_CONFIG_HOME/fish/completions/spatius.fish`  | Automatically loaded by Fish; no profile edit                                                                                                    |

`XDG_DATA_HOME` defaults to `~/.local/share`; `XDG_CONFIG_HOME` defaults to
`~/.config`. Export custom locations before running the installer. Relative
XDG paths are ignored, following the XDG convention.

The installer shows the configured paths and activation command. Its child
process cannot activate completions inside your current shell, so open a new
terminal or run that command yourself. The saved scripts use `spatius` on your
normal `PATH`, never a cached npx path, and do not launch npx on Tab presses.
If the global bin directory needs a PATH fix, complete that first and rerun
the installer to set up completions.

Existing startup content is preserved outside a marked Spatius completion
block. Re-running updates that block rather than appending duplicates. Changed
existing files receive a sibling `.spatius-backup-<id>` backup; unchanged files
are reused. Symlinked dotfiles retain their links and update the target file.
Automatic setup is supported on macOS and Linux.

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
- For installer-managed setup, remove the block between
  `# >>> spatius completions >>>` and `# <<< spatius completions <<<` from the
  startup files listed in the installer summary, then remove its generated
  script. If installation failed partway, inspect those files and the reported
  backups before retrying; completed changes are retained. Correct malformed
  markers or file permissions rather than deleting unrelated startup content.
