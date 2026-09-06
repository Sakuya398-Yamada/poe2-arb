# poe2-arb

Path of Exile 2 の通貨取引所（Currency Exchange）で **ハブ通貨 → アイテム → 別のハブ通貨 → 元のハブ通貨** の三角裁定が成立しているアイテムを探すローカルツール。
GGG公式の1時間ごとの約定集計を読み、VWAP利益でランキングして表示する。仕様・計算式・制約の詳細は `README.md`。

## 開発方針

- **Issue駆動開発**: すべての作業はGitHub Issueから始める。Issueが唯一の情報源
- **1 Issue = 1 PR**: 作業中のIssueスコープ外の変更を同じPRに混ぜない
- **スコープ外問題は起票提案**: 作業中に当該Issueのスコープ外の問題（別バグ・改善余地・技術負債）を発見した場合、Claude Code が **その場で修正せずユーザーに Issue起票を提案** する。承認後に子Issueを作成し、親Issueへリンクを記録する
- **推測しない**: 不明な仕様はユーザーに確認する。特に GGG API のレシオの向きなど**実データで検証済みの前提**（`README.md` と `test/arb.test.ts` に記録）を推測で変えない
- **思考よりも対話**: 方針が定まらない場合、長時間の内部思考ではなくユーザーへの質問で解決する。連続して 3 回以上ツール呼び出しを繰り返しても方針が定まらないときは、いったん状況を要約してユーザーに質問を投げる
- **中間報告**: 大きなファイルや複雑なコードを読み込んだ後は、理解した内容を 2〜3 行で要約し、次のアクションをユーザーに示してから進む
- **コード読みは必要最小限**: 全文理解目的の一括読みは禁止。Grep で該当行を特定してから `Read` に `offset`/`limit` を付けて局所読みする。500 行超のファイルは全読みしない。3ファイル以上の横断読みは `code-explorer` サブエージェントに委譲し、プロンプトに返却量の上限（例: 「`file:line` と 5 行以内の要約のみ」）を必ず明記する。詳細は `@.claude/rules/context-efficiency.md`
- **外部APIは控えめに**: GGG の API は「be reasonable」方針。取得は1時間バケット単位のメモリキャッシュ＋5分ポーリングを維持し、動作確認で連打しない。RePoE・トレード静的データは `.cache/` に保存済みのものを使う
- **Issueへの記録**: 実装中に判明した技術情報や判断はIssueにコメントとして残す
- **過去Issueの参照**: 関連する過去のIssueから情報を収集し、実装に活かす

## 詳細規約（Memory Imports）

具体的な規約は以下のファイルにモジュール分割している。Claude Code は起動時にこれらを自動的に読み込む。**`CLAUDE.md` は索引・コア原則のみに保ち、詳細規約は `.claude/rules/*.md` 側に書く**（運用方針は `@.claude/rules/documentation-policy.md` 参照）。

@.claude/rules/git-conventions.md
@.claude/rules/coding-standards.md
@.claude/rules/tech-stack.md
@.claude/rules/context-efficiency.md
@.claude/rules/workflow-feedback.md
@.claude/rules/documentation-policy.md

## 開発フロー

1. **Issue作成（ユーザー）**: GitHub上でIssueを作成し、要件・設計・定義を記載
2. **Issue指定（ユーザー）**: Claude Code を起動し `/issue-start #<番号>` で作業対象を指定
3. **ブランチ作成＆実装（Claude Code）**: Issueと関連する過去Issueを読み取り、ブランチ作成・実装
4. **PR作成（Claude Code）**: `closes #<issue番号>` を含めたPRを作成
5. **最終確認＆マージ（ユーザー）**: PRを承認・マージ。Issueが自動クローズされる

`/issue-start` の各Phase詳細は `.claude/skills/issue-start/SKILL.md` 参照。

### スコープ外問題の取り扱い

`/issue-start` 実行中（Phase 3/5/6）にスコープ外の問題を検出した場合は、以下のいずれかに当てはまるものだけを起票候補として扱う：

- **起票する**: 機能不具合・仕様乖離・データ誤り・ユーザー体験を損なう振る舞い・複数機能横断の類似問題
- **起票しない**: コードスタイルの好み・影響の無いリファクタ案・当該Issueの DoD に含まれる範囲・既存Issueの重複

起票前に必ず `gh issue list` / `gh search issues`（GitHub MCP 接続時は `search_issues` / `list_issues`）で重複をチェックし、ユーザー確認（Y=そのまま起票 / E=編集して起票 / N=起票しない）を挟んでから起票する。起票した子Issueは Phase 8 で親Issueへコメント記録する。

## 自動ガードレール

`.claude/settings.json` の PreToolUse hook が以下を強制する：

- ブランチ名規約: `<feature|fix|refactor|docs>/#<issue>-<desc>`（`claude/*` は除外）
- コミットメッセージ規約: `<type>: <subject> #<issue>`（`claude/*` 上はissue番号省略可）

違反は exit 2 でブロックされる。意図的にバイパスしない。

## ドキュメントの自動更新

実装の過程で規約・フロー・技術スタックなどに変更が生じた場合、以下のドキュメントを適宜更新する：

- **CLAUDE.md**: コア原則（このファイル）
- **`.claude/rules/*.md`**: 個別の詳細規約
- **`README.md`**: データ源・計算式・制約・API・構成など、ツールの仕様そのもの

更新が必要になるケース例：
- 技術スタックが決定・変更されたとき → `.claude/rules/tech-stack.md`
- コーディング規約が追加されたとき → `.claude/rules/coding-standards.md`
- Git/PR/Issue規約が変わったとき → `.claude/rules/git-conventions.md`
- データ源・計算式・APIが変わったとき → `README.md`
- 開発フロー全体が変わったとき → このファイル
