#!/usr/bin/env bash
# SessionStart hook: prints a short status banner so Claude knows what the
# repository looks like at the start of a session.
#
# Output goes to stdout. Claude Code surfaces it as additional system context.

set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
short_status=$(git status --short 2>/dev/null | head -n 20)
ahead_behind=$(git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "")

printf '## Repository status\n'
printf -- '- Branch: `%s`\n' "$branch"
if [[ -n "$ahead_behind" ]]; then
  ahead=$(printf '%s' "$ahead_behind" | awk '{print $1}')
  behind=$(printf '%s' "$ahead_behind" | awk '{print $2}')
  printf -- '- Ahead/Behind upstream: %s / %s\n' "$ahead" "$behind"
fi
if [[ -n "$short_status" ]]; then
  printf -- '- Working tree (truncated to 20 lines):\n```\n%s\n```\n' "$short_status"
else
  printf -- '- Working tree: clean\n'
fi

# --- Ghost worktree detection ---------------------------------------------
# Compare the launch cwd (Claude's project directory) against the registered
# worktree list. If the launch cwd lives under `.claude/worktrees/<name>/` but
# is NOT a registered worktree, warn the model: edits made via that path
# will silently land in a gitignored area.
launch_pwd="$PWD"
toplevel=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
worktree_paths=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2}')

# Normalize paths for comparison:
#   - backslash -> forward slash
#   - lowercase (Windows is case-insensitive; Git's output and bash's $PWD differ)
#   - strip trailing slash
#   - convert MSYS-style "/d/foo" -> "d:/foo" so it matches Git's "D:/foo" output
norm_path() {
  local p
  p=$(printf '%s' "$1" | tr '\\' '/' | tr '[:upper:]' '[:lower:]')
  p="${p%/}"
  if [[ "$p" =~ ^/([a-z])(/.*|$) ]]; then
    p="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  fi
  printf '%s' "$p"
}
n_orig=$(norm_path "$launch_pwd")
n_top=$(norm_path "$toplevel")

is_registered_worktree=0
while IFS= read -r wt; do
  [[ -z "$wt" ]] && continue
  n_wt=$(norm_path "$wt")
  if [[ "$n_orig" == "$n_wt" ]]; then
    is_registered_worktree=1
    break
  fi
done <<<"$worktree_paths"

# Always show registered worktrees (so the model can cross-check).
if [[ -n "$worktree_paths" ]]; then
  printf '\n## Git worktrees (registered)\n'
  while IFS= read -r wt; do
    [[ -z "$wt" ]] && continue
    printf -- '- `%s`\n' "$wt"
  done <<<"$worktree_paths"
fi

# Ghost detection: cwd lives under .claude/worktrees/<name>/ but is not in the list.
if [[ -n "$n_top" ]] \
   && [[ "$n_orig" != "$n_top" ]] \
   && [[ "$is_registered_worktree" -eq 0 ]] \
   && [[ "$n_orig" == *"/.claude/worktrees/"* ]]; then
  printf '\n## ⚠ Ghost worktree detected\n'
  printf -- '- Launch cwd: `%s`\n' "$launch_pwd"
  printf -- '- Main repo (git toplevel): `%s`\n' "$toplevel"
  printf -- '- This path looks like a worktree but is **not registered** (likely a leftover after `git worktree remove`).\n'
  printf -- '- Use the **main repo absolute path** for `Edit`/`Write` `file_path` and `gh ... --body-file <abs>` invocations. Edits to the launch cwd will land in a gitignored area and silently disappear.\n'
  printf -- '- For git operations, prefer `git -C "%s" ...` over relying on the current shell pwd.\n' "$toplevel"
fi

printf '\n## 行動原則リマインダー\n'
printf -- '- 方針が定まらないときは、長時間の内部思考ではなくユーザーに質問する\n'
printf -- '- 大きなファイルを読んだ後は、理解した内容を要約してから次のアクションに進む\n'
printf -- '- 連続 3 回以上のツール呼び出しで方針が定まらなければ、状況を要約してユーザーに確認する\n'

exit 0
