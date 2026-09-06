#!/usr/bin/env bash
# PreToolUse hook for the Bash tool.
# Blocks `git checkout -b <name>` / `git switch -c <name>` when the branch name
# violates the project convention: <feature|fix|refactor|docs>/#<issue>-<desc>.
#
# Exempt:
#   - claude/*  : Claude Code session-managed branches
#   - main / master / develop : protected branches
#
# Reads JSON via stdin (Claude Code hook protocol). Exit 2 = block.

set -euo pipefail

input=$(cat)
command=$(printf '%s' "$input" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d?.tool_input?.command||"")')

# Skip git commit invocations entirely. Branch-name validation only applies to
# branch-creation commands (`git checkout -b` / `git switch -c`). When a commit
# message body contains the string `git checkout -b foo` (e.g. when documenting
# hook behavior), the regex below would otherwise match `foo` as a branch name
# and block the commit. Commit messages are validated separately by
# validate-commit-message.sh.
if [[ "$command" =~ git[[:space:]]+commit ]]; then
  exit 0
fi

# Match: git checkout -b <branch>  or  git switch -c <branch>
branch=""
if [[ "$command" =~ git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]\;\&\|]+) ]]; then
  branch="${BASH_REMATCH[1]}"
elif [[ "$command" =~ git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]\;\&\|]+) ]]; then
  branch="${BASH_REMATCH[1]}"
fi

# Not a branch-creating command → allow
if [[ -z "$branch" ]]; then
  exit 0
fi

# Exempt branches
case "$branch" in
  claude/*|main|master|develop)
    exit 0
    ;;
esac

# Convention check
if [[ ! "$branch" =~ ^(feature|fix|refactor|docs)/\#[0-9]+-.+ ]]; then
  cat >&2 <<EOF
[hook:validate-branch-name] Branch name '$branch' violates the project convention.

  Expected: <feature|fix|refactor|docs>/#<issue-number>-<kebab-case-description>
  Example:  feature/#42-add-user-model

  See .claude/rules/git-conventions.md for details.
  Exempt prefixes: claude/*, main, master, develop.
EOF
  exit 2
fi

exit 0
