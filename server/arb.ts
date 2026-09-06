// Pure arbitrage math. No I/O here so it can be unit-tested.
import { HUB_IDS, type GggMarket, type GoldFee, type Hub, type HubQuote, type Loop, type LoopStep, type Range } from '../shared/types.js';

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

export interface GoldConfig {
	/** gold charged per 1 unit when `itemId` is the requested side; undefined when unknown */
	feeOf: (itemId: string) => number | undefined;
	/** gold per 1 hub unit (for converting the fee into the loop's `from` currency); empty when not configured */
	goldPerHub?: Partial<Record<Hub, number>>;
}

/**
 * Gold fee for 1 item through the loop. Every leg charges fee(requested item) × units received:
 *   leg 1 requests 1 item, leg 2 requests `to` (sell.vwap units), leg 3 requests `from` (sell.vwap × convert.vwap units).
 * Uses VWAP quantities, so this is the fee matching `profit.vwap`.
 */
export function goldFeePerItem(feeItem: number, feeTo: number, feeFrom: number, sellVwap: number, convertVwap: number): GoldFee {
	const item = feeItem;
	const toHub = feeTo * sellVwap;
	const fromHub = feeFrom * sellVwap * convertVwap;
	return { item, toHub, fromHub, total: item + toHub + fromHub };
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
	gold?: GoldConfig,
): Loop {
	const buy: LoopStep = { hub: buyQ.hub, worst: buyQ.price.hi, best: buyQ.price.lo, vwap: buyQ.vwap, volumeItems: buyQ.volumeItems, volumeHub: buyQ.volumeHub };
	const sell: LoopStep = { hub: sellQ.hub, worst: sellQ.price.lo, best: sellQ.price.hi, vwap: sellQ.vwap, volumeItems: sellQ.volumeItems, volumeHub: sellQ.volumeHub };
	const convert = { worst: rate.price.lo, best: rate.price.hi, vwap: rate.vwap };
	const vwap = (sell.vwap * convert.vwap) / buy.vwap;

	let goldFee: GoldFee | undefined;
	let afterFee: number | undefined;
	if (gold) {
		const feeItem = gold.feeOf(itemId), feeTo = gold.feeOf(HUB_IDS[sell.hub]), feeFrom = gold.feeOf(HUB_IDS[buy.hub]);
		if (feeItem !== undefined && feeTo !== undefined && feeFrom !== undefined) {
			goldFee = goldFeePerItem(feeItem, feeTo, feeFrom, sell.vwap, convert.vwap);
			const goldPerFrom = gold.goldPerHub?.[buy.hub];
			// fee in `from` units per 1 item, divided by what 1 item costs in `from` = fee as a fraction of the stack
			if (goldPerFrom) afterFee = vwap - goldFee.total / goldPerFrom / buy.vwap;
		}
	}
	return {
		itemId, name, category,
		...(icon ? { icon } : {}),
		from: buyQ.hub, to: sellQ.hub,
		buy, sell, convert,
		profit: {
			vwap,
			conservative: (sell.worst * convert.worst) / buy.worst,
			optimistic: (sell.best * convert.best) / buy.best,
			...(afterFee !== undefined ? { afterFee } : {}),
		},
		capacityItems: Math.min(buyQ.volumeItems, sellQ.volumeItems),
		...(goldFee ? { goldFee } : {}),
	};
}

export interface NameResolver {
	(itemId: string): { name: string; category: string; icon?: string };
}

/** All loops between the two hubs, both directions. Unsorted. */
export function findLoops(book: Book, hubA: Hub, hubB: Hub, resolve: NameResolver, gold?: GoldConfig): { loops: Loop[]; skipped: number } {
	const loops: Loop[] = [];
	let skipped = 0;
	const rateAB = book.hubRates.get(`${hubA}|${hubB}`); // A per B
	const rateBA = book.hubRates.get(`${hubB}|${hubA}`); // B per A
	for (const [itemId, quotes] of book.items) {
		const qa = quotes[hubA], qb = quotes[hubB];
		if (!qa || !qb) { skipped++; continue; }
		const { name, category, icon } = resolve(itemId);
		if (rateAB) loops.push(computeLoop(itemId, name, category, qa, qb, rateAB, icon, gold)); // A→item→B→A
		if (rateBA) loops.push(computeLoop(itemId, name, category, qb, qa, rateBA, icon, gold)); // B→item→A→B
	}
	return { loops, skipped };
}

/**
 * Gold per 1 unit of each hub from a gold-per-Exalted setting, using the observed ex-per-hub VWAP for div/chaos.
 * Hubs whose ex rate is missing from the book are left out (no afterFee for loops starting there).
 */
export function goldPerHubFromEx(goldPerEx: number, hubRates: Book['hubRates']): Partial<Record<Hub, number>> {
	const out: Partial<Record<Hub, number>> = { ex: goldPerEx };
	for (const h of ['div', 'chaos'] as const) {
		const r = hubRates.get(`ex|${h}`); // ex per 1 h
		if (r) out[h] = goldPerEx * r.vwap;
	}
	return out;
}
