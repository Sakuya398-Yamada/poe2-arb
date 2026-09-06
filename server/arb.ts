// Pure arbitrage math. No I/O here so it can be unit-tested.
import { HUB_IDS, type GggMarket, type Hub, type HubQuote, type Loop, type LoopStep, type Range, type Recurrence } from '../shared/types.js';

const ID_TO_HUB: Record<string, Hub> = Object.fromEntries(
	(Object.entries(HUB_IDS) as [Hub, string][]).map(([h, id]) => [id, h]),
) as Record<string, Hub>;

export function hubOf(id: string): Hub | undefined {
	return ID_TO_HUB[id];
}

/**
 * GGG ratio semantics (verified against live data):
 *   ratio = qty[pair[0]] / qty[pair[1]], `lowest_ratio` is the min of that, `highest_ratio` the max.
 * Returns "units of `quoteId` per 1 unit of `baseId`" as a range, or null if the market had no trades.
 */
export function pricePerUnit(m: GggMarket, baseId: string, quoteId: string): Range | null {
	const lo = m.lowest_ratio, hi = m.highest_ratio;
	if (!lo || !hi) return null;
	const a = lo[baseId], b = lo[quoteId], c = hi[baseId], d = hi[quoteId];
	if (!a || !b || !c || !d) return null; // 0 or missing → no trades this hour
	const p1 = b / a; // quote per base, from the "lowest" record
	const p2 = d / c;
	return { lo: Math.min(p1, p2), hi: Math.max(p1, p2) };
}

export function mergeRange(a: Range | undefined, b: Range): Range {
	return a ? { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) } : { ...b };
}

export interface HubRate {
	/** from-units per 1 to-unit, min..max */
	price: Range;
	/** volume-weighted average from-units per 1 to-unit */
	vwap: number;
	volumeFrom: number;
	volumeTo: number;
}

export interface Book {
	/** itemId → hub → quote */
	items: Map<string, Partial<Record<Hub, HubQuote>>>;
	/** "from|to" → rate */
	hubRates: Map<string, HubRate>;
}

/** Fold one or more hourly snapshots (already filtered to one league) into per-item hub quotes. */
export function buildBook(markets: GggMarket[]): Book {
	const items: Book['items'] = new Map();
	const hubRates: Book['hubRates'] = new Map();

	for (const m of markets) {
		const [p0, p1] = m.market_pair;
		const h0 = hubOf(p0), h1 = hubOf(p1);

		if (h0 && h1) {
			// hub↔hub: store both directions
			for (const [from, to, fromId, toId] of [[h0, h1, p0, p1], [h1, h0, p1, p0]] as const) {
				const price = pricePerUnit(m, toId, fromId); // from per 1 to
				if (!price) continue;
				const key = `${from}|${to}`;
				const prev = hubRates.get(key);
				const volumeFrom = (prev?.volumeFrom ?? 0) + (m.volume_traded[fromId] ?? 0);
				const volumeTo = (prev?.volumeTo ?? 0) + (m.volume_traded[toId] ?? 0);
				if (volumeTo === 0) continue;
				hubRates.set(key, { price: mergeRange(prev?.price, price), vwap: volumeFrom / volumeTo, volumeFrom, volumeTo });
			}
			continue;
		}

		const hub = h0 ?? h1;
		if (!hub) continue; // item↔item market, not used
		const itemId = h0 ? p1 : p0;
		const hubId = h0 ? p0 : p1;
		const price = pricePerUnit(m, itemId, hubId);
		if (!price) continue;

		const entry = items.get(itemId) ?? {};
		const prev = entry[hub];
		const volumeItems = (prev?.volumeItems ?? 0) + (m.volume_traded[itemId] ?? 0);
		const volumeHub = (prev?.volumeHub ?? 0) + (m.volume_traded[hubId] ?? 0);
		if (volumeItems === 0) continue;
		entry[hub] = { hub, price: mergeRange(prev?.price, price), vwap: volumeHub / volumeItems, volumeItems, volumeHub };
		items.set(itemId, entry);
	}
	return { items, hubRates };
}

/**
 * Loop: start with `from`, buy item with `from`, sell item for `to`, convert `to` back to `from`.
 * multiplier = sellPrice(to per item) * rate(from per to) / buyPrice(from per item)
 */
export function computeLoop(
	itemId: string,
	name: string,
	category: string,
	buyQ: HubQuote,
	sellQ: HubQuote,
	rate: HubRate, // from-units per 1 to-unit
	icon?: string,
): Loop {
	const buy: LoopStep = { hub: buyQ.hub, worst: buyQ.price.hi, best: buyQ.price.lo, vwap: buyQ.vwap, volumeItems: buyQ.volumeItems, volumeHub: buyQ.volumeHub };
	const sell: LoopStep = { hub: sellQ.hub, worst: sellQ.price.lo, best: sellQ.price.hi, vwap: sellQ.vwap, volumeItems: sellQ.volumeItems, volumeHub: sellQ.volumeHub };
	const convert = { worst: rate.price.lo, best: rate.price.hi, vwap: rate.vwap };
	return {
		itemId, name, category,
		...(icon ? { icon } : {}),
		from: buyQ.hub, to: sellQ.hub,
		buy, sell, convert,
		profit: {
			vwap: (sell.vwap * convert.vwap) / buy.vwap,
			conservative: (sell.worst * convert.worst) / buy.worst,
			optimistic: (sell.best * convert.best) / buy.best,
		},
		capacityItems: Math.min(buyQ.volumeItems, sellQ.volumeItems),
	};
}

export interface NameResolver {
	(itemId: string): { name: string; category: string; icon?: string };
}

/** Identity of a loop: same item, same direction. */
export function loopKey(l: Pick<Loop, 'itemId' | 'from' | 'to'>): string {
	return `${l.itemId}|${l.from}|${l.to}`;
}

/**
 * Recurrence over hour buckets. `hourly[i]` = loops computed from bucket i alone.
 * An hour where the loop is absent (no trades on one hub side) counts as not profitable, so a loop that
 * appears only in a thin hour scores low even if that hour's VWAP looks great.
 * medianProfit is taken over the hours where the loop existed, profitable or not, so it reflects stability.
 */
export function scoreRecurrence(hourly: Loop[][]): Map<string, Recurrence> {
	const profits = new Map<string, number[]>();
	for (const loops of hourly) {
		for (const l of loops) {
			const key = loopKey(l);
			const arr = profits.get(key) ?? [];
			arr.push(l.profit.vwap);
			profits.set(key, arr);
		}
	}
	const out = new Map<string, Recurrence>();
	for (const [key, arr] of profits) {
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = sorted.length >> 1;
		const medianProfit = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
		out.set(key, { hoursProfitable: arr.filter((p) => p > 1).length, hoursTotal: hourly.length, medianProfit });
	}
	return out;
}

/** All loops between the two hubs, both directions. Unsorted. */
export function findLoops(book: Book, hubA: Hub, hubB: Hub, resolve: NameResolver): { loops: Loop[]; skipped: number } {
	const loops: Loop[] = [];
	let skipped = 0;
	const rateAB = book.hubRates.get(`${hubA}|${hubB}`); // A per B
	const rateBA = book.hubRates.get(`${hubB}|${hubA}`); // B per A
	for (const [itemId, quotes] of book.items) {
		const qa = quotes[hubA], qb = quotes[hubB];
		if (!qa || !qb) { skipped++; continue; }
		const { name, category, icon } = resolve(itemId);
		if (rateAB) loops.push(computeLoop(itemId, name, category, qa, qb, rateAB, icon)); // A→item→B→A
		if (rateBA) loops.push(computeLoop(itemId, name, category, qb, qa, rateBA, icon)); // B→item→A→B
	}
	return { loops, skipped };
}
