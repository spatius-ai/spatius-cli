export type CompletionShell = 'bash' | 'zsh' | 'fish';
export const completionShells: CompletionShell[] = ['bash', 'zsh', 'fish'];

// The first protocol line is plain:<prefix> or files:<prefix>. Remaining lines
// are literal candidates, never shell code. The shell owns filename quoting.
const scripts: Record<string, string> = {
  bash: `# Bash 3.2+ completion for spatius. Source this file from ~/.bashrc.
_spatius() {
  local cur word previous='' response header prefix candidate trim i
  local -a args
  COMPREPLY=()
  args=()
  # Readline splits unquoted '=' and ':' into separate words. Reassemble
  # these for the CLI, then trim the already-present portion from replies.
  for ((i=1; i<=COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if (( \${#args[@]} )) && { [[ "$word" == '=' || "$word" == ':' ]] || [[ "$previous" == '=' || "$previous" == ':' ]]; }; then
      args[\${#args[@]}-1]+="$word"
    else
      args+=("$word")
    fi
    previous="$word"
  done
  cur="\${args[\${#args[@]}-1]}"
  response=$(command "\${COMP_WORDS[0]}" __complete -- "\${args[@]}" 2>/dev/null) || return 0
  IFS= read -r header <<< "$response"
  prefix="\${header#*:}"
  trim=$(( \${#cur} - \${#COMP_WORDS[COMP_CWORD]} ))
  if [[ "\${COMP_WORDS[COMP_CWORD]}" == '=' || "\${COMP_WORDS[COMP_CWORD]}" == ':' ]]; then
    trim=\${#cur}
  fi
  if [[ "$header" == files:* ]]; then
    while IFS= read -r candidate; do
      candidate="$prefix$candidate"
      COMPREPLY+=("\${candidate:trim}")
    done < <(compgen -f -- "\${cur:\${#prefix}}")
    # compopt is unavailable in macOS's Bash 3.2. The registration below
    # supplies filename quoting there; newer Bash only enables it for files.
    if type compopt &>/dev/null; then compopt -o filenames; fi
  else
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] && COMPREPLY+=("\${candidate:trim}")
    done < <(printf '%s\\n' "$response" | { IFS= read -r header; cat; })
  fi
  return 0
}
if type compopt &>/dev/null; then
  complete -F _spatius spatius
else
  complete -o filenames -F _spatius spatius
fi
`,
  zsh: `#compdef spatius
# Source after compinit, or save as _spatius in a directory on $fpath.
_spatius() {
  local response header prefix
  local -a args candidates
  args=("\${words[@]:1:$((CURRENT - 2))}" "$PREFIX")
  response=$(command "\${words[1]}" __complete -- "\${args[@]}" 2>/dev/null) || return 0
  candidates=("\${(@f)response}")
  header="$candidates[1]"
  candidates[1]=()
  prefix="\${header#*:}"
  if [[ "$header" == files:* ]]; then
    [[ -n "$prefix" ]] && compset -P "$prefix"
    _files
  else
    compadd -- "\${candidates[@]}"
  fi
}
if [[ "$ZSH_EVAL_CONTEXT" == *:file ]]; then
  compdef _spatius spatius
else
  _spatius "$@"
fi
`,
  fish: `# Fish 3.2+ completion for spatius.
# Save as ~/.config/fish/completions/spatius.fish.
function __spatius_complete
    set -l words (commandline -opc)
    set -l current (commandline -ct | string unescape)
    set -l response (command $words[1] __complete -- $words[2..-1] "$current" 2>/dev/null)
    or return
    if string match -q 'files:*' -- $response[1]
        # Fish's path helper preserves spaces and escapes shell metacharacters.
        set -l prefix (string replace 'files:' '' -- $response[1])
        set -l value (string sub -s (math (string length -- "$prefix") + 1) -- "$current")
        for candidate in (__fish_complete_path "$value")
            printf '%s%s\\n' "$prefix" "$candidate"
        end
    else if test (count $response) -gt 1
        printf '%s\\n' $response[2..-1]
    end
end
complete -c spatius -f -a '(__spatius_complete)'
`,
};

export function completionScript(shell: string): string {
  const script = scripts[shell];
  if (!script) throw new Error(`Unsupported completion shell: ${shell}`);
  return script;
}
