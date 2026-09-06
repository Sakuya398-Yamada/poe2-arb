---
name: issue-start
description: GitHub Issueを読み取り、ブランチ作成・実装・PR作成まで一連の開発を行うスキル。ユーザーが「Issue #Nをやって」「#N を実装して」「/issue-start #N」のようにIssue番号を指定して作業を依頼したときに使う。Issue駆動開発、ブランチ作成、PR作成、GitHub Issue対応といったキーワードでも発動すること。各Phaseの詳細は phases/ 配下の個別ファイルに分割されており、必要なPhaseだけ読めば動けるprogressive disclosure設計。code-explorer/code-architect/code-reviewer のサブエージェント定義は .claude/agents/ に配置済み。
---

# Issue開発スキル

指定されたGitHub Issueに基づいて、ブランチ作成から実装、PR作成まで一連の開発を行う。

## 使い方

```
/issue-start #1
/issue-start 1
```

引数からIssue番号を取得する。`#` の有無は問わない。

---

## Phase一覧（Progressive Disclosure）

各 Phase の詳細手順は `phases/` 配下の個別ファイルに分割されている。**該当Phaseに入る直前にそのファイルを Read して内容に従うこと**。すべてを冒頭でまとめて読み込む必要はない。

| # | Phase | ファイル | スキップ可? |
|---|-------|---------|-------------|
| 1 | Issue分析・不足確認・自動補完 | `phases/01-issue-analysis.md` | × |
| 2 | ラベル付与・ブランチ作成 | `phases/02-branch-setup.md` | × |
| 3 | コード探索（code-explorer） | `phases/03-exploration.md` | bug/docs時可 |
| 4 | 設計（code-architect） | `phases/04-design.md` | 単純変更時可 |
| 5 | 実装 | `phases/05-implementation.md` | × |
| 6 | コードレビュー（code-reviewer） | `phases/06-review.md` | docs時可 |
| 7 | PR作成 | `phases/07-pr-creation.md` | × |
| 8 | Issueへの記録（+ 知見ボード追記） | `phases/08-issue-recording.md` | × |

---

## サブエージェント

Phase 3/4/6 で呼ぶ専門エージェントは `.claude/agents/` に集約済み（`subagent_type` で直接指定するだけで使える）：

| subagent_type | 役割 | 定義 |
|---------------|------|------|
| `code-explorer` | コード探索・トレース | `.claude/agents/code-explorer.md` |
| `code-architect` | アーキテクチャ設計 | `.claude/agents/code-architect.md` |
| `code-reviewer` | レビュー（信頼度80以上のみ報告） | `.claude/agents/code-reviewer.md` |

各Phaseで2〜3個並列起動して観点を分散させる。

---

## MCPツール活用方針

プロジェクトに接続済みの MCP サーバーを各Phaseで活用し、情報収集の質を向上させる。MCP は**補助的な手段**であり、未接続・エラー時は従来手段（`gh` CLI・手動検索・ユーザーへの確認）にフォールバックしてフロー全体を止めない。

### このプロジェクトで使える手段

GitHub MCP は **未接続**。Issue/PR 操作はすべて `gh` CLI で行う（以降の Phase 説明にある `issue_read` / `issue_write` / `add_issue_comment` / `search_issues` はそれぞれ下表の `gh` コマンドに読み替える）。

| 手段 | コマンド／ツール例 | 用途 |
|------|-------------------|------|
| `gh` CLI | `gh issue view N --comments`, `gh issue list`, `gh search issues`, `gh issue create`, `gh issue comment`, `gh issue edit --add-label`, `gh pr create`, `gh pr view` | Issue/PR操作全般。本文が長いときは `--body-file` を使う |
| Claude Code 内蔵 Browser ペイン | `preview_start`（`.claude/launch.json` の `poe2-arb`）、`navigate`, `screenshot`, `read_page` | フロントエンド変更時のUI動作確認。事前に `npm run build` |
| WebFetch / WebSearch | 組み込みツール | GGG API・RePoE・トレード静的データの仕様確認 |
| GitHub MCP（接続した場合） | `issue_read`, `issue_write`, `list_issues`, `search_issues`, `create_pull_request`, `add_issue_comment` | 接続後は `gh` より優先してよい |

### Phase別MCPツール対応表

| Phase | 主MCPツール | 活用場面 |
|-------|-------------|---------|
| 1 | `gh issue view`, WebFetch | Issue/PR取得、GGG API 等の外部仕様確認 |
| 1.5 | `gh issue edit` / `gh issue view` | Issue本文の更新、関連Issue取得 |
| 2 | `gh issue edit --add-label` | ラベル付与 |
| 3 | WebFetch | 外部データ（GGG / RePoE / トレード静的データ）の形式確認 |
| 5 | WebFetch | 外部APIの正確な仕様参照 |
| 6 | Browser ペイン | UI動作確認（`npm run build` → `preview_start`） |
| 7 | `gh pr create` | PR作成 |
| 8 | `gh issue comment` | Issueコメント追加、知見ボード（#1）追記 |

---

## スコープ外問題の起票提案（Phase横断）

`/issue-start` 実行中に、当該Issueのスコープ外の問題を見つけた場合は **その場で直さず、別Issueとして起票を提案する**。1 Issue = 1 PR 原則（`.claude/rules/git-conventions.md`）を守るため、混ぜ込みは禁止。

### いつ発生するか（Phase別）

| Phase | 検出タイミング | 扱い |
|-------|---------------|------|
| 3（コード探索） | 既存コードの別バグ・設計上の違和感 | Phase末尾で一覧化して提示 |
| 5（実装） | 実装中に周辺コードのバグに遭遇 | 即時は記録のみ、Phase末尾でまとめて提示 |
| 6（レビュー） | レビュアーの指摘が当該Issue DoD 外 | スコープ内（即修正）／外（起票候補）に仕分け |

### 起票判定基準

- **起票する**: 機能不具合／仕様乖離／データ誤り／ユーザー体験を損なう振る舞い／複数機能横断の類似問題
- **起票しない**: コードスタイルの好み／影響の無いリファクタ案／当該Issue DoD 内／既存Issueの重複

### 起票フロー（共通）

1. **重複チェック**: GitHub MCP の `search_issues`（または `list_issues`）でタイトル・内容の近いものを検索する
   - 重複候補がある場合は既存Issueリンクをユーザーに提示して判断を仰ぐ
2. **ユーザー確認**: 以下のフォーマットで提示し、対話する

   ```
   【候補N】
   タイトル案: <type>: <subject>
   ラベル: bug / feature / refactor / docs のいずれか
   概要: 何が問題か（1〜3行）
   コード箇所: path/to/file.ts:L10-20（バグの場合）
   再現手順: 箇条書き（バグの場合のみ）
   既存Issue重複チェック: なし / 候補 #NN

   起票しますか？
    [Y] そのまま起票
    [E] タイトル/本文を編集して起票
    [N] 起票しない（口頭報告のみ）
   ```

3. **起票**: 承認（Y/E）後、GitHub MCP の `issue_write`（method: `create`）で子Issueを作成する
   - 本文末尾に `親Issue: #<親番号>` を明記する
4. **親Issueへの記録**: Phase 8 で親Issueに子Issue番号・タイトル・リンクをコメント追記する（`phases/08-issue-recording.md` 参照）

### 自動化しないこと

- **必ずユーザー確認を挟む**。無人起票はしない
- スコープ外問題を自動修正しない（口頭報告 or 起票のみ）

---

## ワークフロー改善余地の知見ボード（Phase 8 拡張）

個別Issueのスコープ外問題（コードバグ・仕様乖離等）とは別に、**ワークフロー自体（`/issue-start` 手順・`.claude/rules/*`・`CLAUDE.md`・hooks・skills・MCP 運用）への気づき** を累積する常時Open Issue を用意している。

- **知見ボードIssue**: #1（`meta: ワークフロー改善の知見ボード`）
- **書き込み**: Phase 8 の最後にユーザー確認を挟んで `add_issue_comment` で追記
- **運用規約**: `.claude/rules/workflow-feedback.md`
- **Phase 5/6/7 との連携**: 実装・レビュー・PR作成中に気づいた改善余地は短文メモとして控え、Phase 8 で棚卸し・確認・追記する
- **気づきが無い場合**: スキップしてよい（「特になし」コメントは不要）
- **棚卸し**: 溜まったコメントは**ユーザー側**で実際の改善Issueに昇格させる（無人昇格はしない）

---

## ガードレール（自動）

`.claude/settings.json` に登録された PreToolUse hook が以下を**決定論的に**検証する：

- `git checkout -b` / `git switch -c` のブランチ名規約 → `.claude/hooks/validate-branch-name.sh`
- `git commit -m` のメッセージ規約 → `.claude/hooks/validate-commit-message.sh`

規約違反は exit 2 でブロックされる。詳細は `.claude/rules/git-conventions.md`。

---

## 注意事項

- すべてのブランチは `main` から派生し、`main` にマージする
- 作業中の変更がある場合はユーザーに確認してからブランチを切り替える
- 過去のIssueやPRから関連情報を積極的に収集する
