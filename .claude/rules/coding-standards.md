# コーディング規約

このファイルは CLAUDE.md から `@.claude/rules/coding-standards.md` でインポートされる。

## 基本方針

- 言語は **TypeScript** で統一する（サーバ・フロント・テスト・スクリプトすべて。`scripts/dev.mjs` のみ例外）
- `tsconfig.json` の `strict: true` を維持する。`any` は使わない。外部 JSON は取り込み口で型を付ける（`as GggHour` 等）
- ランタイム依存を増やさない（フレームワーク・HTTP クライアント・ユーティリティ含む）。標準 API（`fetch`、`node:http`、`node:fs/promises`）で書く
- **純粋関数と I/O を分ける**: 計算ロジックは `server/arb.ts` のように I/O を持たない純粋関数にしてユニットテストする。外部取得（`ggg.ts` / `names.ts` / `icons.ts`）は `fetchImpl` を注入可能にする
- サーバとフロントで共有する型は `shared/types.ts` にだけ置く（ランタイム依存なし）
- 外部 API の取得失敗は**全体を止めない**方向に倒す（例: アイコンが取れなければ名前だけ表示）
- 数値の意味（「1アイテムあたりのハブ通貨量」「from 単位 / to 単位」等）はコメントか型名で明示する。レシオの向きの取り違えがこのツール最大のバグ源

## ディレクトリ構成

```
poe2-arb/
├── CLAUDE.md
├── README.md            # ツールの仕様（データ源・計算式・制約・API）
├── server/
│   ├── index.ts         # node:http サーバ。/api/loops, /api/leagues, dist/ 配信
│   ├── ggg.ts           # GGG API 取得（最新完了時間の探索・メモリキャッシュ・N時間マージ）
│   ├── arb.ts           # 純粋関数: レシオ正規化・Book 構築・ループ計算
│   ├── names.ts         # RePoE から名前・カテゴリ・アートパス解決（.cache/names.json）
│   └── icons.ts         # 公式トレード静的データからアイコンURL解決（.cache/icons.json）
├── shared/
│   └── types.ts         # サーバ/フロント共通型・ハブ通貨定義
├── web/                 # Vite root。index.html / main.ts / style.css
├── test/                # vitest。*.test.ts
├── scripts/dev.mjs      # tsx watch + vite を同時起動
└── .claude/
    ├── agents/          # サブエージェント定義
    ├── rules/           # @import される規約集
    ├── hooks/           # PreToolUse 等で使うシェルスクリプト
    ├── settings.json    # フック設定
    ├── skills/          # スラッシュ起動可能なスキル
    └── launch.json      # Browser ペイン用のサーバ起動設定
```

## スタイル

- インデントは **タブ**、文字列は **シングルクォート**、セミコロンあり（既存コードに合わせる）
- import は相対パスに `.js` 拡張子を付ける（`NodeNext` 解決のため）: `import { x } from './arb.js'`
- 1 ファイルの冒頭に「何をするファイルか」を 1〜3 行のコメントで書く（既存ファイルと同じ流儀）

## 命名規約

| 対象 | 規約 | 例 |
|------|------|----|
| ファイル名 | 小文字（短い単語 1 つ。複数語なら `kebab-case`） | `arb.ts`, `names.ts` |
| 変数・関数 | `camelCase` | `buildBook`, `pricePerUnit` |
| 定数 | `UPPER_SNAKE_CASE` | `HUB_IDS`, `CACHE_FILE` |
| 型・インターフェース | `PascalCase`（`I` 接頭辞なし） | `GggMarket`, `LoopStep` |
| ハブ通貨 | `Hub` 型のリテラル `'ex' / 'div' / 'chaos'` | 表示名は `HUB_LABEL` 経由 |

## テスト

- 計算ロジックの変更には `test/` にテストを足す。既存テストは **実データで観測した値**（README「実データで検証したレシオの向き」）を固定しているので、失敗したら実装側を疑う
- 外部 API を叩くテストは書かない（`fetchImpl` にスタブを渡す）

## コメントとドキュメント

- 自明なコードにコメントは付けない
- ロジックが直感的でない場所のみ「なぜそうしたか」を書く（例: なぜ保守値でランキングしないか、なぜ署名付きURLが必要か）
- 触っていないコードに後付けで型注釈・コメント・docstringを追加しない
- ユーザー向けの説明（仕様・制約・データ源）は `README.md` に書き、`CLAUDE.md` / `rules/` には開発ルールだけを書く
