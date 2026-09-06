# 技術スタック

このファイルは CLAUDE.md から `@.claude/rules/tech-stack.md` でインポートされる。

## レイヤー構成

| レイヤー | 技術 | 備考 |
|---------|------|------|
| 言語 | TypeScript（`strict`、ESM、`NodeNext`） | Node.js 20 以上。`tsx` で直接実行し、サーバはトランスパイルしない |
| フロントエンド | Vite + 素の TypeScript（フレームワーク無し） | `web/` 配下。DOM 直接操作。ビルド成果物は `dist/` |
| バックエンド | `node:http` のみ（フレームワーク無し） | `server/index.ts`。`/api/*` と `dist/` の静的配信 |
| DB | なし | GGG の1時間バケットはメモリキャッシュ。RePoE 名前表とアイコン表は `.cache/*.json` にファイルキャッシュ |
| 外部データ | GGG Currency Exchange API / RePoE (PoE2) / 公式トレード静的データ | 認証不要。詳細と URL は `README.md` の「データ源」 |
| テスト | vitest | `npm test`。`test/arb.test.ts` は実データの値で検証しているので数値を勝手に変えない |
| 型チェック | `tsc --noEmit` | `npm run typecheck`。リンターは未導入 |
| CI | なし | 現状は手元で `npm test` / `npm run typecheck` / `npm run build` を通す |
| Issue/PR操作 | `gh` CLI | GitHub MCP は未接続。接続した場合は MCP を優先してよい |

ランタイム依存は **ゼロ**（devDependencies のみ: vite / vitest / tsx / typescript / @types/node）。依存追加は Issue で合意してから。

## 開発環境

- OS: Windows 11 + Git Bash で動作実績あり（hooks も同環境で動作）。macOS / Linux でも動くはず
- 必要ツール: git、Node.js 20+、`gh` CLI（ログイン済みであること）
- 環境変数: `PORT`（既定 8765）、`POE2ARB_LEAGUE`（既定 `Forbidden Rites`）、`POE2ARB_UA`（User-Agent）
- 初回起動時に RePoE（8MB）とトレード静的データ（180KB）をダウンロードして `.cache/` に保存する。`.cache/` は gitignore 済み

## よく使うコマンド

| コマンド | 説明 |
|---------|------|
| `npm install` | 依存インストール（`package-lock.json` あり。CI 相当なら `npm ci`） |
| `npm run dev` | API サーバ（tsx watch, :8765）と Vite（:5173、`/api` を 8765 にプロキシ）を同時起動 |
| `npm start` | `vite build` してから本番相当のサーバ起動 → http://localhost:8765 |
| `npm run serve` | ビルド済み `dist/` でサーバのみ起動 |
| `npm test` | vitest 一括実行 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | フロントエンドを `dist/` にビルド |

Claude Code の Browser ペインから動作確認する場合は `.claude/launch.json` の `poe2-arb` 構成（`npx tsx server/index.ts`、port 8765）を使う。事前に `npm run build` が必要。

## 完了前チェック

PR を作る前に必ず以下を通す：

```
npm run typecheck && npm test && npm run build
```
