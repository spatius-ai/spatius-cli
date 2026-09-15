# Terminal shell completions

Use this workflow when a user requests shell completion setup. Discover the
installed contract before choosing the script:

```sh
spatius schema completion
spatius completion --help
spatius completion bash
spatius completion zsh
spatius completion fish
```

Choose the user's actual shell. `completion` prints raw shell code on stdout
without requiring login or creating local configuration. It rejects `--json`.
Save or source only the matching script. Modify shell startup files only when
the user requested persistent setup, and preserve their existing configuration.

For a human requesting interactive installation, `npx @spatius/cli install`
offers completion setup after the persistent CLI is available. It suggests
the launching shell through npm's wrapper processes, with a login-shell fallback;
the user can override it or skip. It writes a saved script and, for Bash/Zsh,
an idempotent marked startup block. Existing changed files are backed up.
Do not run this interactive workflow unattended or assume the child process
activated completions in the user's current shell. Relay its activation
command or suggest opening a new terminal.

When initializing Zsh, the installer excludes insecure completion directories
with `compinit -i`. If this omits other completions, inspect `compaudit` and fix
the reported ownership or permissions; do not bypass the audit with `-u`.

Bash can source its script directly. Zsh requires `compinit` before sourcing;
for autoloading, save as `_spatius` in an `fpath` directory configured before
`compinit`. Fish automatically loads `spatius.fish` from its user completions
directory. The packaged `docs/completions.md` contains installation commands.

If completions fail, verify that `spatius` is installed on `PATH`, check the
shell and initialization order, then regenerate the script for the installed
CLI. Do not log in or run setup to fix completions: the internal `__complete`
query only reads command metadata and never calls services. It is a private
shell protocol, not a structured workflow API. Do not suggest credentials,
remote account IDs, or commands that submit jobs while completing input.

If the installer reports `INSTALL_COMPLETIONS_FAILED`, inspect its recovery
paths, permissions, and managed markers. Preserve any partial changes and
backups; rerun once the cause is fixed. If npx is the only available executable
or the global CLI is too old, install the current CLI globally and fix `PATH`
before retrying. Export custom `ZDOTDIR`/XDG locations before installation.
