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
| アイコン・トレードID | `GET https://www.pathofexile.com/api/trade2/data/static` | 公式トレードサイトの静的データ(180KB・認証不要)。署名付き画像URLと、出品相場の問い合わせに使う ID(`exalted` 等)を含む。`.cache/trade.json` に保存し1日1回更新 |
| アイコン(補完) | `GET https://www.poe2wiki.net/w/api.php?action=query&prop=imageinfo` | 上の静的データに項目が無いアイテムだけを名前で問い合わせる。`.cache/wiki-icons.json` に保存(空振りも記録し1週間は再問い合わせしない) |
| 日本語アイテム名 | `GET https://jp.pathofexile.com/api/trade2/data/static` | 上と同じ構造の日本語版(190KB・認証不要)。`id` で英語版と結合し「英名 → 日本語名」の表を作って `.cache/trade.json` に同居させる |
| ゴールド手数料 | `https://poe2db.tw/us/Currency_Exchange` | ゲームデータ `CurrencyExchange.GoldPurchaseFee` の poe2db 表示(HTML 570KB)をアイテム名→gold にパース。`.cache/gold.json` に保存し週1回更新。取れなければ手数料「?」表示で続行 |
| 出品相場(参考) | `POST https://www.pathofexile.com/api/trade2/exchange/poe2/<league>` | 公式トレードサイトの Bulk Item Exchange = **プレイヤーの倉庫出品**(ウィスパーして手渡し)。ゲーム内取引所の板ではない。認証不要。UI の「出品相場を取得」ボタンでのみ取得。詳細は下の「出品相場」 |

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
名前ではなく RePoE の `visual_identity.dds_file` と突き合わせている。

2026-09-07 時点で取引所に出ている 660 種(時間帯により増減する)のうち 652 種がこれで一致する。残る 8 種
(The Triskelion Reforged / Shattered Triskelion / Raven's Reflection / Panther・Hawk・Stoat Idol /
Helbrym's Hide / Eonyr's Thunder)は**トレード静的データに項目自体が無く**、旧形式の
`web.poecdn.com/image/Art/2DItems/….png` も 404 なので、署名付きURLを得る手段が無い。
この 8 種はコミュニティ wiki (poe2wiki.net) が `File:<アイテム名> inventory icon.png` という
固定タイトルで同じアイコンを公開しているので、MediaWiki の `imageinfo` API で名前から画像URLを引いて補完する
(`server/wiki.ts`)。RePoE と wiki で metadata id が食い違うアイテムがあるため、突き合わせは表示名で行う。
問い合わせるのは静的データで解決できなかった名前だけで、結果は空振りも含めてキャッシュする。
wiki 側にも無ければ従来どおり空枠のままで、一覧全体は止まらない。

画像はブラウザが poecdn / poe2wiki から直接読む(サーバは中継しない)。

### 日本語アイテム名

公式トレードサイトの静的データは `jp.pathofexile.com` でも同じ構造で配信されていて、`text` だけが日本語になっている。
英語版と日本語版を `id` で結合すると全 772 件が対応し、英語版の `text` は RePoE の `name` と 771/772 件一致するので、
**英名をキーに** 日本語名を引く(アートパスでは変成のオーブ/上級/完全のように同じ画像を使う段階違いが衝突する)。
2026-09-07 時点で取引所に出ていた 548 種(6時間・全ハブペア)のうち 540 種に日本語名が付く。
残りはアイドル・ピナクルキー・一部のリネージジェムで、日本語版にも載っていないため英名のみで表示する。
日本語版の取得に失敗しても英語版が取れていればアイコンは更新し、日本語名は前回のキャッシュを使い続ける。

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

## 出品相場(トレードサイトのプレイヤー出品)

ゲーム内取引所(Alva)の現在の板は公開 API が無い(GGG の Currency Exchange API は「purely historical」)。代わりに、公式トレードサイトの Bulk Item Exchange に出ているプレイヤー出品の最良価格を **参考値** として表示する。手渡し取引の相場なので、Alva の板と一致するとは限らない。

- **対象**: 表示中のテーブルの上位 5 ループ(フィルタ・ソート適用後)。「出品相場を取得」ボタンを押したときだけ取得し、自動ポーリングはしない
- **リクエスト数**: ハブ方向ごとに、買いレグ・売りレグ・ハブ間換算。各レグはまず 1 回のまとめ取得(`have=[from], want=[items]`)を試し、**応答が全件返ったときだけ**それを使う。切り詰められていたらアイテムごとに取り直す(1 レグ最大 6 回)。上位 5 ループが同じ方向なら 3〜13 回。全件返らない理由は下記
- **まとめ取得を信用しない理由**: 複数アイテムを `want` に並べると、トレードサイトはレシオ順ではなく提示額順にページングする。2026-09-07 の実測では 5 アイテムのまとめ取得が 357 件中 100 件しか返さず、Lesser Jeweller's Orb が実勢 0.106 ex に対し 0.5 ex 以上の出品しか含まれていなかった。切り詰められたページは標本として使えない
- **レート制限**: IP 単位で `5回/15秒・10回/90秒・30回/300秒`(レスポンスヘッダ `X-Rate-Limit-Ip`、2026-09-07 観測)。超過ペナルティは 60秒/300秒/1800秒。サーバ側で各窓に収まるよう送信間隔を空け、429 を受けたら `Retry-After` の間は送らない
- **キャッシュ**: クエリ単位で 5 分間メモリキャッシュ。同じ上位 5 ループなら連打してもリクエストは出ない
- **最良価格の選び方**: 買いは最安、売り・換算は最高。ただし GGG 約定の VWAP から 1/3〜3倍を外れる出品(1 ex → 1 div のような冗談出品)は無視する
- **両市場が食い違う場合**: 出品が 1 件もない場合は「出品なし」。出品はあるが全件が 1/3〜3倍の外なら、最良出品を出したうえで「約定VWAPと乖離」と表示し、**参考利益は計算しない**(取引所の VWAP と無関係な価格を掛け合わせても意味がないため)。上位ループは薄い約定で VWAP が跳ねていることが多く、この乖離表示自体が「その VWAP は当てにならない」という手掛かりになる
- **表示**: テーブルの「出品相場」列に最良出品で回した場合の利益と在庫上限、詳細パネルにレグごとの価格・在庫・出品数
- 取得失敗・レート制限中でも VWAP 表示は影響を受けない(エラーはボタン横に出るだけ)

## 制約(重要)

- 板の現在値ではなく、**完了した直近1時間の約定の集計**。ゲーム内でAltキーで競合注文を見てから実行すること。出品相場は補助情報で、しかも手渡し取引の板。
- ゴールド手数料は「要求側 1 個あたり固定 × 個数」の見積りで、実機未検証(「計算 › ゴールド手数料」)。手数料込み利益は `POE2ARB_GOLD_PER_EX` を設定した時だけ出る。
- アイテム名は公式トレードサイトの日本語名を主表示にし、英名(RePoEの `name`)を添える。日本語名が無いアイテムは英名のみ。
- poe.ninja は使っていない(1ペア分のレートしか公開していないため、三角裁定には不足)。
- GGGのAPIは「be reasonable」方針なので、取得は1時間バケット単位でメモリキャッシュし、5分ポーリング。

## 構成

```
server/index.ts   http サーバ。/api/loops, /api/leagues, dist/ 配信
server/ggg.ts     GGG API 取得(最新の完了時間の探索・キャッシュ・N時間マージ)
server/arb.ts     純粋関数: レシオ正規化・Book 構築・ループ計算
server/names.ts   RePoE から名前解決
server/trade.ts   公式トレード静的データ(EN/JP)からアイコンURL・日本語名・トレードIDを解決
server/exchange.ts トレードサイトの出品相場(取得・5分キャッシュ・レート制限ペーシング・最良価格)
server/wiki.ts    トレード静的データに無いアイテムのアイコンを poe2wiki から補完
server/gold.ts    poe2db からゴールド手数料表を取得
shared/types.ts   サーバ/フロント共通型
web/              Vite + 素の TypeScript(依存なし)
test/arb.test.ts  実データの値を使ったユニットテスト(レシオの向き・VWAP・再現性スコア)
test/ggg.test.ts  fetchWindow のスタブテスト(バケット分割・取得回数)
test/trade.test.ts トレード静的データの変換と名前解決のテスト
test/wiki.test.ts  wiki アイコン補完(タイトル変換・imageinfo 解析・優先順位)のテスト
```

## API

`GET /api/loops?league=Forbidden%20Rites&hours=1&hubs=ex,div`

- `hours`: 1〜24。複数時間はレシオ幅を広げ、量を足し合わせる。各ループの `recurrence`(`hoursProfitable` / `hoursTotal` / `medianProfit`)は時間バケットごとの再計算から出す
- `hubs`: `ex,div` / `ex,chaos` / `chaos,div`(順不同、両方向のループが返る)
- 各ループの `name` は英名、`ja` は日本語名(無いときはキー自体が無い)、`icon` は画像URL(同上)
- 各ループの `goldFee`(item / toHub / fromHub / total、gold/個)と `profit.afterFee`(`POE2ARB_GOLD_PER_EX` 設定時のみ)。レスポンス直下の `goldPerHub` は換算に使った 1 ハブあたりのゴールド

`GET /api/reference?league=…&hours=1&hubs=ex,div&loops=ex>Metadata/Items/Currency/CurrencyCorrupt>div,…`

- `loops`: `/api/loops` の結果の `from>itemId>to` を 1〜5 個。レグごとの最良出品(`price` は Loop と同じ向き)・在庫・出品数と参考利益、`errors` を返す。トレードサイトが落ちていても 200 でレグが `null` になるだけ

## 次にやると良さそうなこと

- ゲーム内取引所(Alva)の現在の板を読める方法が見つかったら「今すぐ成立するか」を判定する(2026-09-07 時点で公開 API は無い。トレードサイトの出品相場で代替中)
- オーバーレイ化 / ゲーム内チャットへコピー
