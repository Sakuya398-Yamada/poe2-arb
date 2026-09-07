// Shared between server and web. No runtime deps.

/** Hub currencies the loops pivot on. */
export type Hub = 'ex' | 'div' | 'chaos';

export const HUB_IDS: Record<Hub, string> = {
	ex: 'Metadata/Items/Currency/CurrencyAddModToRare',
	div: 'Metadata/Items/Currency/CurrencyModValues',
	chaos: 'Metadata/Items/Currency/CurrencyRerollRare',
};

export const HUB_LABEL: Record<Hub, { en: string; ja: string; short: string }> = {
	ex: { en: 'Exalted Orb', ja: '高貴なオーブ', short: 'ex' },
	div: { en: 'Divine Orb', ja: '神のオーブ', short: 'div' },
	chaos: { en: 'Chaos Orb', ja: 'カオスオーブ', short: 'c' },
};

/** One market as returned by GGG's hourly Currency Exchange feed. */
export interface GggMarket {
	league: string;
	market_id: string;
	market_pair: [string, string];
	volume_traded: Record<string, number>;
	lowest_stock: Record<string, number>;
	highest_stock: Record<string, number>;
	lowest_ratio: Record<string, number>;
	highest_ratio: Record<string, number>;
}

export interface GggHour {
	next_change_id: number;
	markets: GggMarket[];
}

/** A closed interval [lo, hi]. */
export interface Range {
	lo: number;
	hi: number;
}

/** Price of one unit of an item expressed in a hub currency, for one hub market. */
export interface HubQuote {
	hub: Hub;
	/** hub units per 1 item, min..max over the observed trades (outlier-prone) */
	price: Range;
	/** volume-weighted average hub units per 1 item = volumeHub / volumeItems */
	vwap: number;
	/** items traded in the window */
	volumeItems: number;
	/** hub units traded in the window */
	volumeHub: number;
}

export interface LoopStep {
	hub: Hub;
	/** hub units per item; worst = the side that hurts you, best = the side that helps you */
	worst: number;
	best: number;
	/** volume-weighted average executed price */
	vwap: number;
	volumeItems: number;
	volumeHub: number;
}

/** How consistently a loop showed up across the hour buckets of the window. */
export interface Recurrence {
	/** hours in which the loop existed with VWAP profit > 0% */
	hoursProfitable: number;
	/** hours in the window (missing hours count against the loop) */
	hoursTotal: number;
	/** median of the per-hour VWAP profit multipliers over hours where the loop could be computed; null if never */
	medianProfit: number | null;
}

export interface Loop {
	itemId: string;
	name: string;
	category: string;
	/** absolute image URL (web.poecdn.com), missing when the trade site lists no icon for the item */
	icon?: string;
	/** Japanese display name from the jp trade site's static data; missing when the item is not listed there */
	ja?: string;
	/** loop starts and ends in `from`; passes through the item and `to` */
	from: Hub;
	to: Hub;
	buy: LoopStep;
	sell: LoopStep;
	/** `from` units per 1 `to` unit (the hub→hub conversion at the end) */
	convert: { worst: number; best: number; vwap: number };
	/**
	 * multiplier on the starting stack: 1.10 = +10%
	 * vwap: every leg at its volume-weighted average executed price (best single estimate)
	 * conservative / optimistic: every leg at the extreme that hurts / helps (bounds; single odd trades widen them a lot)
	 */
	profit: {
		vwap: number; conservative: number; optimistic: number;
		/**
		 * vwap minus the gold fee converted to `from` units: vwap - goldFee.total / goldPerHub[from] / buy.vwap.
		 * Only present when the fee is known and POE2ARB_GOLD_PER_EX is set.
		 */
		afterFee?: number;
	};
	/** rough capacity: min(items traded on buy side, items traded on sell side) in the window */
	capacityItems: number;
	/** per-hour recurrence over the window; attached by the server, absent on loops computed from a single book */
	recurrence?: Recurrence;
	/** gold fee for pushing 1 item through the loop; missing when the item's fee is unknown */
	goldFee?: GoldFee;
}

/**
 * Gold fee estimate per 1 item bought. The exchange charges a fixed gold amount per unit of the *requested*
 * ("I want") item (`GoldPurchaseFee` in the game data; see README), so each leg is fee(requested) × units received.
 */
export interface GoldFee {
	/** leg 1: requesting the item — fee(item) × 1 */
	item: number;
	/** leg 2: requesting `to` — fee(to) × sell.vwap */
	toHub: number;
	/** leg 3: requesting `from` — fee(from) × sell.vwap × convert.vwap */
	fromHub: number;
	total: number;
}

export interface LoopsResponse {
	league: string;
	/** unix seconds of the first and last hour bucket included */
	windowStart: number;
	windowEnd: number;
	hoursRequested: number;
	hoursUsed: number;
	generatedAt: number;
	hubs: [Hub, Hub];
	/** from-hub per 1 to-hub, e.g. ex per div */
	hubRate: { worst: number; best: number; vwap: number } | null;
	/** icon URLs of the hub currencies (same source as Loop.icon) */
	hubIcons: Partial<Record<Hub, string>>;
	/** gold per 1 hub unit used for `profit.afterFee`; empty unless POE2ARB_GOLD_PER_EX is set (div/chaos derived via hub rates) */
	goldPerHub: Partial<Record<Hub, number>>;
	loops: Loop[];
	/** items that had a market in only one hub (no loop possible) — for transparency */
	skipped: number;
}

/**
 * Best player listing on the official trade site (Bulk Item Exchange) for one loop leg.
 * These are stash listings that need a whisper and a manual trade — not the in-game Currency Exchange book.
 */
export interface ReferenceLeg {
	/** same orientation as the matching LoopStep / Loop.convert: hub units per 1 item, or from-units per 1 to-unit */
	price: number;
	/** units of the thing you receive that this one listing can supply */
	stock: number;
	/** listings inside the VWAP band (1/3〜3×) */
	offers: number;
	/** listings returned for this pair before filtering */
	listed: number;
	/**
	 * false = every listing sits outside the band, so `price` is the best one overall and the two markets disagree.
	 * The reference profit is not computed in that case: it would mix an exchange VWAP with an unrelated price.
	 */
	inBand: boolean;
}

export interface LoopReference {
	itemId: string;
	from: Hub;
	to: Hub;
	buy: ReferenceLeg | null;
	sell: ReferenceLeg | null;
	convert: ReferenceLeg | null;
	/** multiplier like Loop.profit, from the best listing of every leg; null when any leg is missing */
	profit: number | null;
	/** why something is missing (no trade-site id, no listing in range, fetch error) */
	note?: string;
}

export interface ReferenceResponse {
	league: string;
	/** unix seconds when the (possibly cached) listings were assembled */
	fetchedAt: number;
	/** trade-site requests actually sent for this response (cache hits excluded) */
	requests: number;
	loops: LoopReference[];
	/** fetch problems that left legs empty; the VWAP table is unaffected */
	errors: string[];
}
