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
