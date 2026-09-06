# Git 規約

このファイルは CLAUDE.md から `@.claude/rules/git-conventions.md` でインポートされる。

## ブランチ命名

```
<type>/#<issue番号>-<kebab-case説明>
```

| type | 用途 | 派生元 | マージ先 |
|------|------|--------|---------|
| `feature` | 新機能開発 | main | main |
| `fix` | バグ修正 | main | main |
| `refactor` | リファクタリング | main | main |
| `docs` | ドキュメント | main | main |

例:

```
feature/#1-add-user-model
fix/#5-fix-date-calculation
refactor/#10-refactor-api-client
```

> **例外**: `claude/*` で始まるブランチは Claude Code が管理するセッションブランチで、Issue番号は不要。`main` ブランチもそのまま使う。

## コミットメッセージ

```
<type>: <subject> #<issue番号>
```

| type | 説明 |
|------|------|
| `feat` | 新機能追加 |
| `fix` | バグ修正 |
| `refactor` | リファクタリング |
| `test` | テスト追加・修正 |
| `docs` | ドキュメント |
| `chore` | ビルド・設定変更 |
| `style` | コードスタイル修正（動作に影響なし） |

例:

```
feat: ユーザーデータモデルを追加 #1
fix: 日付計算の境界条件を修正 #5
test: APIクライアントのユニットテスト追加 #8
```

> **例外**: `claude/*` セッションブランチ上のコミットは Issue番号を省略可。typeプレフィックスは必須。

## Pull Request

### スコープ原則（1 Issue = 1 PR）

- 1つのPRは**1つのIssueの完了条件（DoD）のみ**を満たす変更に限定する
- 作業中に当該Issueのスコープ外の問題を発見しても、同じブランチ／PRで修正しない
- スコープ外の問題は `/issue-start` の提案フロー（Phase 3/5/6 末尾）に従って**別Issueとして起票**し、独立した PR で対応する
- 例外: 作業中のIssueを満たすために不可避な副次変更（例: 同ファイル内で参照先が変わる / 型定義の追従）はこの限りではないが、PR本文の「## 変更点」に明示する

### タイトル

```
<type>: <簡潔な説明> #<issue番号>
```

### 本文に含める内容

- `## 概要`: 変更内容の要約（1〜3行）
- `## 変更点`: 具体的な変更のリスト
- `## テスト`: テスト方法・結果
- `closes #<issue番号>`: マージ時にIssueを自動クローズ

## Issue

### タイトル

```
<ラベル名>: <簡潔な説明>
```

例: `feature: ユーザー設定画面を追加` / `bug: 日付計算が月末にずれる`

### Issueに含める内容

- **背景・目的**: なぜこの作業が必要か
- **要件**: やること／やらないこと
- **完了条件（DoD）**: チェックリスト形式
- **未確定事項**: 要確認な仕様（あれば）

この構成は `.github/ISSUE_TEMPLATE/issue.md`（新規Issue）に Issueテンプレートとして用意してあり、GitHub 上で Issue を新規作成すると選択できる。ほかに知見ボード作成用の `workflow-feedback.md`（meta、セットアップ時に1回だけ使う）がある。テンプレートに沿わない Issue は空白Issueから作成してよい。

### ラベル

| ラベル | 説明 | 色 |
|--------|------|----|
| `feature` | 新機能 | `#0E8A16` |
| `bug` | バグ | `#D73A4A` |
| `refactor` | リファクタリング | `#F9D0C4` |
| `docs` | ドキュメント | `#0075CA` |
| `meta` | ワークフロー改善の知見ボード等、メタ情報用 | `#6B5B95` |
| `question` | 要確認・議論 | `#D876E3` |
| `priority:high` | 優先度高 | `#B60205` |
| `priority:medium` | 優先度中 | `#FBCA04` |
| `priority:low` | 優先度低 | `#C2E0C6` |

### ラベル → ブランチprefix 対応

| Issueラベル | ブランチprefix |
|-------------|---------------|
| `feature` | `feature/` |
| `bug` | `fix/` |
| `refactor` | `refactor/` |
| `docs` | `docs/` |

## 自動検証

`.claude/hooks/validate-branch-name.sh` と `.claude/hooks/validate-commit-message.sh` が PreToolUse hook として `git checkout -b` / `git switch -c` / `git commit` の規約違反をブロックする。
