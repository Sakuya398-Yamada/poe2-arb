# poe2-arb

Path of Exile 2 の通貨取引所(Currency Exchange / Alva)で、
**高貴 → アイテム → 神 → 高貴**(と逆方向)の三角裁定が成立しているアイテムを探すローカルツール。

```
npm install
npm start          # ビルドしてサーバ起動 → http://localhost:8765
```

開発時(ホットリロード):

```
npm run dev        # API: 8765 / Vite: http://localhost:5173 (/api は 8765 にプロキシ)
npm test           # vitest
npm run typecheck
```

環境変数: `PORT`(既定 8765)、`POE2ARB_LEAGUE`(既定 `Forbidden Rites`)、`POE2ARB_UA`(User-Agent)。

## データ源

| 何 | どこから | 備考 |
|---|---|---|
| 約定データ | `GET https://web.poecdn.com/api/currency-exchange/poe2/<unixHour>` | GGG公式・認証不要。**完了した1時間**の全ペアの集計。約5分遅延。`markets` が空 = その時間はまだ無い |
| アイテム名 | `https://repoe-fork.github.io/poe2/base_items.json` | 初回のみDL(8MB)→ `.cache/names.json` に名前・カテゴリ・アート(dds)パスだけ保存 |
| アイコン | `GET https://www.pathofexile.com/api/trade2/data/static` | 公式トレードサイトの静的データ(180KB・認証不要)。署名付き画像URLを含む。`.cache/icons.json` に保存し1日1回更新 |

GGGのレコード(1ペア1時間)は次の形:

```
market_pair:   [A, B]
volume_traded: {A: nA, B: nB}       # その時間に動いた総量
lowest_ratio:  {A: a, B: b}         # ratio = qty[A]/qty[B] の最小
highest_ratio: {A: c, B: d}         # 同 最大
```

実データで検証したレシオの向き: `Div|Ex` で `lowest {div:1, ex:106}, highest {div:1, ex:90}` → 1 div = 90〜106 ex。
ハブ通貨(Ex/Div/Chaos)はペアの先頭にも末尾にも来るので `server/arb.ts:pricePerUnit` で正規化している。

### アイコン

PoE2 固有のアートは `web.poecdn.com/image/Art/2DItems/….png` の旧形式では 404 で、
`web.poecdn.com/gen/image/<base64パラメータ>/<ハッシュ>/<名前>.png` という**署名付きURL**でしか配信されない。
署名は生成できないので、公式トレードサイトの静的データ(`trade2/data/static`)に載っている画像URLを使う。
base64 部分には `{"f":"2DItems/Currency/…","scale":1,"realm":"poe2"}` の形でアートパスが入っているので、
名前ではなく RePoE の `visual_identity.dds_file` と突き合わせている(2026-09-07 時点で取引所に出ている 670 種のうち 661 種が一致。
残りはピナクルキー・アイドル等で、アイコン無しの空枠になる)。
画像はブラウザが poecdn から直接読む(サーバは中継しない)。

## 計算

ループ `from → item → to → from` の倍率:

```
profit = sell(to per item) × rate(from per to) / buy(from per item)
```

3種類出している:

- **VWAP**(主指標・既定ソート): 各レグを `volume_traded` から出した約定量加重平均で計算。`volumeHub / volumeItems`。
- **保守**: 各レグを不利な側の極端値(lowest/highest)で計算した下限。
- **楽観**: 有利な側の極端値で計算した上限。

### なぜ保守値でランキングしないか

当初は「不利な側のレシオ」で並べる予定だったが、実データを見ると極端値は
1件の変な約定(例: 1 div = 25 ex の約定が1時間に1回)で大きく振れ、ランキングとして機能しなかった。
`volume_traded` の比から出るVWAPは実際に動いた量で加重されるので、こちらを主指標にし、極端値は幅として併記している。

### 取引数(capacity)

`min(買い側で動いたアイテム数, 売り側で動いたアイテム数)`。
括弧内に「売り側で動いたハブ通貨の量」も出している。
**神側の市場は薄いことが多く、そこで数div分だけ良いレートの約定があるとVWAP利益が数百%になる**。
それは嘘ではないが、その時間にその量しか捌けていないという意味なので、再現性は売り側の量で判断すること。

## 制約(重要)

- 板の現在値ではなく、**完了した直近1時間の約定の集計**。ゲーム内でAltキーで競合注文を見てから実行すること。
- ゴールド手数料は考慮していない。
- アイテム名は英語(RePoEの `name`)。
- poe.ninja は使っていない(1ペア分のレートしか公開していないため、三角裁定には不足)。
- GGGのAPIは「be reasonable」方針なので、取得は1時間バケット単位でメモリキャッシュし、5分ポーリング。

## 構成

```
server/index.ts   http サーバ。/api/loops, /api/leagues, dist/ 配信
server/ggg.ts     GGG API 取得(最新の完了時間の探索・キャッシュ・N時間マージ)
server/arb.ts     純粋関数: レシオ正規化・Book 構築・ループ計算
server/names.ts   RePoE から名前解決
shared/types.ts   サーバ/フロント共通型
web/              Vite + 素の TypeScript(依存なし)
test/arb.test.ts  実データの値を使ったユニットテスト
```

## API

`GET /api/loops?league=Forbidden%20Rites&hours=1&hubs=ex,div`

- `hours`: 1〜24。複数時間はレシオ幅を広げ、量を足し合わせる
- `hubs`: `ex,div` / `ex,chaos` / `chaos,div`(順不同、両方向のループが返る)

## 次にやると良さそうなこと

- 公式トレードサイトの `trade2/exchange` の板(現在の注文)を足して「今すぐ成立するか」を判定する(POESESSID とレート制限の扱いが必要)
- 数時間分の履歴で「毎時間出ている=再現性あり」ループをスコアリング
- 日本語アイテム名(RePoE に翻訳が無いので別ソースが要る)
- オーバーレイ化 / ゲーム内チャットへコピー
