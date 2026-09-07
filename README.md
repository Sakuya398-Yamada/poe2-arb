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
| アイテム名 | `https://repoe-fork.github.io/poe2/base_items.json` | 初回のみDL(8MB)→ `.cache/names.json` に名前・カテゴリ・アート(dds)パスだけ保存。取得に失敗しても一覧は止めず、IDの末尾(例: `CurrencyAddModToRare`)を名前として表示し10分後に再試行 |
| アイコン | `GET https://www.pathofexile.com/api/trade2/data/static` | 公式トレードサイトの静的データ(180KB・認証不要)。署名付き画像URLを含む。`.cache/icons.json` に保存し1日1回更新 |
| ゴールド手数料 | `https://poe2db.tw/us/Currency_Exchange` | ゲームデータ `CurrencyExchange.GoldPurchaseFee` の poe2db 表示(HTML 570KB)をアイテム名→gold にパース。`.cache/gold.json` に保存し週1回更新。取れなければ手数料「?」表示で続行 |

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
それは嘘ではないが、その時間にその量しか捌けていないという意味なので、再現性は売り側の量と下記の再現性スコアで判断すること。

### 再現性(hours ≥ 2 のとき)

N 時間マージの VWAP とは別に、**時間バケットごとに** Book を組み直してループを計算し、同じループ(アイテム + 方向)が
各時間でどう出たかを集計する(`server/arb.ts` の `scoreRecurrence`)。

- **再現**: VWAP 利益 > 0% で出現した時間数 / 窓の時間数。片側のハブ市場に約定が無い時間は「出現なし」として分母に残す。
  薄い市場で 1 時間だけ良いレートが出たループは `1/6` のように低くなる
- **利益(中央値)**: ループが算出できた各時間の VWAP 利益の中央値(利益なしの時間も含む)。1 時間だけ突出した約定に引きずられない

hours = 1 のときは `1/1` にしかならないので UI では列を隠す。GGG API の取得は従来どおり時間バケット単位のキャッシュから
行い、再現性の計算で取得回数は増えない。

### ゴールド手数料

取引所は注文成立時に **「要求側(I want)のアイテム 1 個あたり固定のゴールド × 個数」** を取る、として見積もっている。

- 出典: ゲームデータの `CurrencyExchange` テーブルにアイテムごとの `GoldPurchaseFee`(整数)がある([poe-tool-dev/dat-schema](https://github.com/poe-tool-dev/dat-schema))。
  RePoE の PoE2 版はこの表を出力していないので、[poe2db の Currency Exchange ページ](https://poe2db.tw/us/Currency_Exchange)に表示されている値を使う(687 品目、2026-09-07 時点で 高貴 120 / カオス 160 / 神 800 / 変質 50 / ミラー 25000)。
  第三者記事の「120 gold per exalt requested, 160 per chaos, 800 per divine」とも一致する。
- **実機では未検証**(要求 10 個で 10 倍になるか、提供側に課金されないか、端数の丸め)。検証したら Issue #6 に記録する。
- 手数料はレートや取引総額に依存しない固定値なので、レートの向きの取り違えのようなバグ源にはならない。

ループ 1 周(アイテム 1 個)あたりの見積り:

```
fee = fee(item) × 1                                   # レグ1: item を要求
    + fee(to)   × sell(to per item)                   # レグ2: to を要求
    + fee(from) × sell(to per item) × rate(from per to) # レグ3: from を要求
```

環境変数 `POE2ARB_GOLD_PER_EX`(1 高貴あたりのゴールド。自分の感覚値)を設定すると、
ハブ通貨換算した手数料を VWAP 利益から引いた **手数料込み利益** も出す:

```
profitAfterFee = profitVWAP − fee / goldPer(from) / buy(from per item)
goldPer(div|chaos) = POE2ARB_GOLD_PER_EX × VWAP(ex per div|chaos)
```

ゴールドとハブ通貨の換算レートは外部から取っていない(ゴールドは取引できず、相場が存在しないため)。

## 制約(重要)

- 板の現在値ではなく、**完了した直近1時間の約定の集計**。ゲーム内でAltキーで競合注文を見てから実行すること。
- ゴールド手数料は「要求側 1 個あたり固定 × 個数」の見積りで、実機未検証(「計算 › ゴールド手数料」)。手数料込み利益は `POE2ARB_GOLD_PER_EX` を設定した時だけ出る。
- アイテム名は英語(RePoEの `name`)。
- poe.ninja は使っていない(1ペア分のレートしか公開していないため、三角裁定には不足)。
- GGGのAPIは「be reasonable」方針なので、取得は1時間バケット単位でメモリキャッシュし、5分ポーリング。

## 構成

```
server/index.ts   http サーバ。/api/loops, /api/leagues, dist/ 配信
server/ggg.ts     GGG API 取得(最新の完了時間の探索・キャッシュ・N時間マージ)
server/arb.ts     純粋関数: レシオ正規化・Book 構築・ループ計算
server/names.ts   RePoE から名前解決
server/icons.ts   公式トレード静的データからアイコンURL解決
server/gold.ts    poe2db からゴールド手数料表を取得
shared/types.ts   サーバ/フロント共通型
web/              Vite + 素の TypeScript(依存なし)
test/arb.test.ts  実データの値を使ったユニットテスト(レシオの向き・VWAP・再現性スコア)
test/ggg.test.ts  fetchWindow のスタブテスト(バケット分割・取得回数)
```

## API

`GET /api/loops?league=Forbidden%20Rites&hours=1&hubs=ex,div`

- `hours`: 1〜24。複数時間はレシオ幅を広げ、量を足し合わせる。各ループの `recurrence`(`hoursProfitable` / `hoursTotal` / `medianProfit`)は時間バケットごとの再計算から出す
- `hubs`: `ex,div` / `ex,chaos` / `chaos,div`(順不同、両方向のループが返る)
- 各ループの `goldFee`(item / toHub / fromHub / total、gold/個)と `profit.afterFee`(`POE2ARB_GOLD_PER_EX` 設定時のみ)。レスポンス直下の `goldPerHub` は換算に使った 1 ハブあたりのゴールド

## 次にやると良さそうなこと

- 公式トレードサイトの `trade2/exchange` の板(現在の注文)を足して「今すぐ成立するか」を判定する(POESESSID とレート制限の扱いが必要)
- 日本語アイテム名(RePoE に翻訳が無いので別ソースが要る)
- オーバーレイ化 / ゲーム内チャットへコピー
