# Phase 2: ラベル自動付与 & ブランチ作成

## ラベル自動付与

Issueにラベルが付いていない場合、Issue本文の内容から適切なラベルを判定して自動付与する。

判定基準：
- 新しい機能やデータモデルの追加 → `feature`
- 既存機能の不具合修正 → `bug`
- 動作を変えないコード改善 → `refactor`
- ドキュメントのみの変更 → `docs`
- 判断がつかない場合 → ユーザーに確認

GitHub MCPの `issue_write`（method: `update`、`labels` パラメータ）でラベルを付与する。

## ラベル → ブランチ prefix 対応表

| Issueラベル | ブランチprefix |
|-------------|---------------|
| `feature` | `feature/` |
| `bug` | `fix/` |
| `refactor` | `refactor/` |
| `docs` | `docs/` |

## ブランチ作成手順

```bash
git checkout main
git pull origin main
git checkout -b <type>/#<issue番号>-<kebab-case説明>
```

> **Hooks による自動検証**: `.claude/hooks/validate-branch-name.sh` がブランチ名を PreToolUse で検証する。規約違反だとブロックされるので、上記フォーマットに必ず従うこと。

## 古い main 派生ブランチの検知

`git pull origin main` を忘れる、worktree がローカル main を更新できなかった、別作業から復帰した直後など、新ブランチが古い main から派生してしまう事故が起き得る。テストが失敗するまで気付かないと `stash → fetch → merge → unstash` の手戻りが発生する。

ブランチ作成後の最初のコミット前に **必ず** 以下を実行する：

```bash
git fetch origin main
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" -gt 0 ]; then
  echo "⚠ 新ブランチは origin/main より $behind コミット遅れています"
fi
```

### `behind > 0` の場合の対処

新ブランチに切り替えてから古さを発見した場合、以下のいずれかで取り込む：

```bash
# 作業中の変更がある場合は先に stash する
git stash push -m "issue-start wip"

# main の最新を新ブランチへ取り込む
git fetch origin main
git merge origin/main      # ファストフォワード or 3-way merge

# stash を戻す
git stash pop
```

`git merge origin/main` により新ブランチに `Merge branch 'main' into <feature>` コミットが追加される。これは正常な挙動で、PR を `main` へ squash merge する運用なら最終 commit 履歴には影響しない。

> **なぜ自動化しないか**: `git merge` を hook で強制すると stash の取り扱いミスや conflict 解消の自動化リスクが大きい。検知だけ自動化し、対処は明示的な人手 (Claude) で行う方針。
