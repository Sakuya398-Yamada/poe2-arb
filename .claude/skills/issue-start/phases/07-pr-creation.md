# Phase 7: PR作成

## 事前チェックリスト（push 前）

push 前に以下を確認する。1つでも該当する場合は対応してから次のステップへ進む。

- [ ] `git status --short` を実行し、`.claude/tmp-*` などの一時ファイルが staging / untracked に含まれていない
  - 含まれている場合: `.gitignore` 側でカバーされているか確認し、必要なら `.gitignore` を修正してから `git rm --cached <path>` で取り除く
- [ ] `git log origin/main..HEAD --stat` でこのブランチのコミットに無関係な変更（生成物・ログ・他Issueの修正等）が混入していない
  - 混入している場合: `git reset --soft <correct-base>` で巻き戻して staging を整理し直す

## 手順

1. リモートにブランチをプッシュする：

   ```bash
   git push -u origin <ブランチ名>
   ```

2. GitHub MCPの `create_pull_request` で main ブランチへのPRを作成する。`.claude/rules/git-conventions.md` のPR規約に従う：

   - `owner` / `repo`: リポジトリ情報
   - `title`: `<type>: <説明> #<issue番号>`
   - `head`: 作業ブランチ名
   - `base`: `main`
   - `body`:

     ```
     ## 概要
     ...

     ## 変更点
     ...

     ## テスト
     ...

     closes #<issue番号>
     ```

3. 作成されたPRのURLをユーザーに返す

## ワークフロー改善余地のメモ（Phase 8 向け）

PR作成フロー自体への気づき（例: テンプレートの不足、`closes #N` の付け忘れ誘因、`git push` 周りのハマりどころ、PR本文テンプレに項目を足したい 等）があれば短文メモとして控え、Phase 8 で知見ボードIssueにユーザー確認のうえ追記する（詳細は `phases/08-issue-recording.md`）。
