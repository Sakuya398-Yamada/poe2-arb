# ドキュメント運用方針

このファイルは CLAUDE.md から `@.claude/rules/documentation-policy.md` でインポートされる。

## 基本方針

- **`CLAUDE.md` は索引・コア原則のみに保つ**: プロジェクトの中核となる開発方針（Issue駆動開発、1 Issue = 1 PR、推測しない、思考よりも対話、中間報告など）と、詳細規約ファイルへの索引（Memory Imports）だけを置く場所
- **詳細規約は `.claude/rules/*.md` に分離する**: 個別領域ごとの具体的な規約・運用手順・リファレンスは `.claude/rules/` 配下に配置し、`@.claude/rules/<name>.md` 形式で CLAUDE.md から Memory Imports する
- **新規規約を追加するときは原則 `.claude/rules/*.md` 側を作成・更新する**: コア原則そのものの再定義でなければ、CLAUDE.md 本文を直接膨らませず、対応する rules ファイル（既存 or 新規）を編集する。CLAUDE.md 側の更新は Memory Imports リストへの 1 行追加で済むのが理想

## 既存 rules ファイルとスコープ

| ファイル | スコープ |
|---------|---------|
| `git-conventions.md` | ブランチ・コミット・PR・Issue 規約 |
| `coding-standards.md` | 言語規約・命名・ディレクトリ構成・コメント方針 |
| `tech-stack.md` | 技術スタック・開発環境・コマンド |
| `context-efficiency.md` | コンテキスト効率・ファイル読解ルール |
| `workflow-feedback.md` | ワークフロー改善知見ボード運用 |
| `documentation-policy.md` | ドキュメント運用方針（このファイル） |

## 新規 rules ファイル追加時のチェック

1. スコープが既存 rules と重複しないか確認（重複するなら既存ファイルへの追記を選ぶ）
2. 冒頭に `このファイルは CLAUDE.md から @.claude/rules/<name>.md でインポートされる` を記載
3. CLAUDE.md の「## 詳細規約（Memory Imports）」見出し直下のリストに `@.claude/rules/<name>.md` を追加

## 「CLAUDE.md にも追記」と書きたくなったら

実装中・Issue 本文で「CLAUDE.md にも追記する」のような表現が出てきたら、まず「索引・コア原則として CLAUDE.md に置くべき内容か」を自問する。次のいずれかに該当しなければ、対応する `.claude/rules/*.md` 側に書く方を選ぶ：

- プロジェクトのコア原則そのもの（既存「## 開発方針」と同等のレイヤー）
- 全 Phase / 全領域に横断的に効く絶対ルール
- 詳細規約ファイルが分かれていない領域への新規索引追加
