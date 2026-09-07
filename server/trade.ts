// Player listings from the official trade site's Bulk Item Exchange ("trade2/exchange"). These are stash-tab
// listings that need a whisper and a manual trade — NOT the in-game Currency Exchange order book (GGG exposes no
// live data for that; ggg.ts only gets hourly digests). Shown next to the VWAP loops as a reference price.
//   POST https://www.pathofexile.com/api/trade2/exchange/poe2/<league>      (no auth; observed 2026-09-07)
//   body: {"query":{"status":{"option":"online"},"have":[ids I pay],"want":[ids I get]},"sort":{"have":"asc"}}
// Rate limit per IP (X-Rate-Limit-Ip): 5/15s, 10/90s, 30/300s; penalties 60s/300s/1800s. We pace requests to
// those windows, cache every query for TTL_MS and never poll on our own (the UI has a button).
import type { Hub, LoopReference, ReferenceLeg } from '../shared/types.js';

const BASE = 'https://www.pathofexile.com/api/trade2/exchange/poe2';
const UA = process.env.POE2ARB_UA ?? 'poe2-arb/0.1 (personal currency-exchange viewer)';
export const TTL_MS = 5 * 60 * 1000;
/** [max requests, window seconds] as advertised by X-Rate-Limit-Ip on 2026-09-07 */
const LIMITS: [number, number][] = [[5, 15], [10, 90], [30, 300]];
/** listings farther than this factor from the VWAP are ignored (joke listings like 1 ex → 1 div) */
export const OUTLIER_FACTOR = 3;

/** One listing seen from the buyer: pay `giveAmount` of `give`, receive `getAmount` of `get`; `stock` is in `get` units. */
export interface Offer { give: string; giveAmount: number; get: string; getAmount: number; stock: number }
export interface ExchangeResult { offers: Offer[]; total: number; truncated: boolean }

interface TradeResponse {
	total?: number;
	result?: Record<string, {
		listing?: {
			offers?: { exchange?: { currency?: string; amount?: number }; item?: { currency?: string; amount?: number; stock?: number } }[];
		};
	}>;
}

export function parseExchange(body: TradeResponse): ExchangeResult {
	const offers: Offer[] = [];
	const listings = Object.values(body.result ?? {});
	for (const l of listings) {
		for (const o of l.listing?.offers ?? []) {
			const give = o.exchange?.currency, get = o.item?.currency;
			if (!give || !get) continue;
			offers.push({ give, giveAmount: o.exchange?.amount ?? 0, get, getAmount: o.item?.amount ?? 0, stock: o.item?.stock ?? 0 });
		}
	}
	const total = body.total ?? listings.length;
	return { offers, total, truncated: listings.length < total };
}

/**
 * Best listing trading `base` against `quote`, as quote units per 1 base.
 * side 'buy': you pay quote to get base → lowest price wins. 'sell': you give base for quote → highest wins.
 * Listings outside vwap/OUTLIER_FACTOR..vwap*OUTLIER_FACTOR are preferred; when every listing falls outside
 * (the two markets disagree, e.g. an exchange VWAP built from a handful of odd trades) the best one is still
 * returned with `inBand: false` so the caller can show the gap instead of pretending there is no market.
 */
export function bestOffer(offers: Offer[], base: string, quote: string, side: 'buy' | 'sell', vwap?: number): ReferenceLeg | null {
	const seen: { price: number; stock: number }[] = [];
	for (const o of offers) {
		if (o.give === quote && o.get === base && o.getAmount > 0 && o.giveAmount > 0) {
			seen.push({ price: o.giveAmount / o.getAmount, stock: o.stock });
		} else if (o.give === base && o.get === quote && o.giveAmount > 0 && o.getAmount > 0) {
			const price = o.getAmount / o.giveAmount;
			seen.push({ price, stock: Math.floor(o.stock / price) }); // stock is in quote units here → convert to base
		}
	}
	if (seen.length === 0) return null;
	const inRange = vwap && Number.isFinite(vwap) && vwap > 0
		? seen.filter((s) => s.price >= vwap / OUTLIER_FACTOR && s.price <= vwap * OUTLIER_FACTOR)
		: seen;
	const pool = inRange.length > 0 ? inRange : seen;
	const best = pool.reduce((a, b) => (side === 'buy' ? b.price < a.price : b.price > a.price) ? b : a);
	return { price: best.price, stock: best.stock, offers: inRange.length, listed: seen.length, inBand: inRange.length > 0 };
}

// --- fetching: per-query cache, pacing against the advertised windows, 429 back-off ---
interface CacheEntry { at: number; data: ExchangeResult }
const cache = new Map<string, CacheEntry>();
const sentAt: number[] = [];
let blockedUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pacing = true;

/** Forget cache, pacing history and back-off. For tests, which also skip the real waits with `pacing: false`. */
export function resetTradeState(opts: { pacing?: boolean } = {}): void {
	cache.clear();
	sentAt.length = 0;
	blockedUntil = 0;
	pacing = opts.pacing ?? true;
}

/** Waits until one more request fits in every rate-limit window, then records it. */
async function pace(): Promise<void> {
	if (!pacing) return;
	for (;;) {
		const now = Date.now();
		while (sentAt.length && now - sentAt[0] > LIMITS[LIMITS.length - 1][1] * 1000) sentAt.shift();
		let wait = 0;
		for (const [max, sec] of LIMITS) {
			const inWindow = sentAt.filter((t) => now - t < sec * 1000);
			if (inWindow.length >= max) wait = Math.max(wait, inWindow[0] + sec * 1000 - now + 100);
		}
		if (wait === 0) { sentAt.push(now); return; }
		await sleep(wait);
	}
}

export async function fetchExchange(league: string, have: string[], want: string[], fetchImpl: typeof fetch = fetch): Promise<ExchangeResult> {
	const key = `${league}|${have.join(',')}|${want.join(',')}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
	if (Date.now() < blockedUntil) throw new Error(`trade2 exchange: rate limited, retry in ${Math.ceil((blockedUntil - Date.now()) / 1000)}s`);
	await pace();
	const res = await fetchImpl(`${BASE}/${encodeURIComponent(league)}`, {
		method: 'POST',
		headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: { status: { option: 'online' }, have, want }, sort: { have: 'asc' } }),
	});
	if (res.status === 429) {
		const retry = Number(res.headers.get('Retry-After')) || 60;
		blockedUntil = Date.now() + retry * 1000;
		throw new Error(`trade2 exchange: rate limited (429), retry in ${retry}s`);
	}
	if (!res.ok) throw new Error(`trade2 exchange: HTTP ${res.status}`);
	const data = parseExchange((await res.json()) as TradeResponse);
	cache.set(key, { at: Date.now(), data });
	return data;
}

/** What the caller knows about one loop: trade-site ids for every leg and the VWAPs used to reject outliers. */
export interface LoopRequest {
	itemId: string;
	from: Hub;
	to: Hub;
	/** trade-site ids ("exalted"); undefined when the item has no trade-site listing category */
	item?: string;
	fromId: string;
	toId: string;
	/** hub units per item / from-units per to-unit, same as Loop */
	buyVwap: number;
	sellVwap: number;
	convertVwap: number;
}

export interface ReferenceResult { loops: LoopReference[]; requests: number; errors: string[] }

/**
 * Reference prices for a handful of loops with as few requests as possible: per hub direction one query for all
 * buy legs (have=from, want=items), one for all sell legs (have=items, want=to) and one for the hub conversion.
 * When a batched answer was cut off and an item got nothing, that item is re-queried alone.
 * Never throws: a failed query leaves its legs null and adds a message to `errors`.
 */
export async function fetchReference(league: string, reqs: LoopRequest[], fetchImpl: typeof fetch = fetch): Promise<ReferenceResult> {
	const errors: string[] = [];
	let requests = 0;
	const query = async (have: string[], want: string[]): Promise<ExchangeResult | null> => {
		try {
			const before = cache.size;
			const r = await fetchExchange(league, have, want, fetchImpl);
			if (cache.size > before) requests++;
			return r;
		} catch (e) {
			const msg = (e as Error).message;
			if (!errors.includes(msg)) errors.push(msg);
			return null;
		}
	};
	/**
	 * Offers for one leg of several items. One batched query answers all of them when the trade site returns the
	 * whole result set. A truncated answer is NOT a usable sample — the page is ordered by the amount offered, not
	 * by the ratio, so a deep market comes back showing only its worst listings — and every item is re-queried alone.
	 */
	const legOffers = async (batchHave: string[], batchWant: string[], items: string[], itemSide: 'want' | 'have'): Promise<Map<string, Offer[]>> => {
		const out = new Map<string, Offer[]>();
		if (items.length === 0) return out;
		const single = async (it: string) => query(itemSide === 'want' ? batchHave : [it], itemSide === 'want' ? [it] : batchWant);
		if (items.length > 1) {
			const batch = await query(batchHave, batchWant);
			if (batch && !batch.truncated) {
				for (const it of items) out.set(it, batch.offers.filter((o) => (itemSide === 'want' ? o.get : o.give) === it));
				return out;
			}
		}
		for (const it of items) {
			const r = await single(it);
			if (r) out.set(it, r.offers);
		}
		return out;
	};

	const out = new Map<LoopRequest, LoopReference>();
	for (const r of reqs) {
		out.set(r, { itemId: r.itemId, from: r.from, to: r.to, buy: null, sell: null, convert: null, profit: null, ...(r.item ? {} : { note: 'トレードサイトに無いアイテム' }) });
	}
	const groups = new Map<string, LoopRequest[]>();
	for (const r of reqs) {
		if (!r.item) continue;
		const k = `${r.from}|${r.to}`;
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	for (const group of groups.values()) {
		const { fromId, toId } = group[0];
		const items = [...new Set(group.map((r) => r.item!))];
		const buys = await legOffers([fromId], items, items, 'want');
		const sells = await legOffers(items, [toId], items, 'have');
		const conv = await query([toId], [fromId]);
		for (const r of group) {
			const ref = out.get(r)!;
			ref.buy = bestOffer(buys.get(r.item!) ?? [], r.item!, fromId, 'buy', r.buyVwap);
			ref.sell = bestOffer(sells.get(r.item!) ?? [], r.item!, toId, 'sell', r.sellVwap);
			ref.convert = conv ? bestOffer(conv.offers, toId, fromId, 'sell', r.convertVwap) : null;
			const legs = [ref.buy, ref.sell, ref.convert];
			const missing = [!ref.buy && '買い', !ref.sell && '売り', !ref.convert && '換算'].filter(Boolean);
			const offBand = [ref.buy?.inBand === false && '買い', ref.sell?.inBand === false && '売り', ref.convert?.inBand === false && '換算'].filter(Boolean);
			if (legs.every((l) => l?.inBand)) ref.profit = (ref.sell!.price * ref.convert!.price) / ref.buy!.price;
			else if (missing.length > 0) ref.note = `${missing.join('・')}の出品なし`;
			else ref.note = `${offBand.join('・')}が約定VWAPと乖離`;
		}
	}
	return { loops: reqs.map((r) => out.get(r)!), requests, errors };
}
