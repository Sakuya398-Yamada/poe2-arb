import { beforeEach, describe, expect, it } from 'vitest';
import { bestOffer, fetchExchange, fetchReference, parseExchange, resetTradeState, type Offer } from '../server/trade.js';
import { buildTradeIdMap } from '../server/icons.js';

// Trimmed real response of POST /api/trade2/exchange/poe2/Forbidden%20Rites with have=[exalted], want=[divine]
// (2026-09-07). `exchange` is what the buyer pays, `item` is what the seller gives; `stock` counts `item`.
const RAW = {
	total: 3,
	result: {
		a: { id: 'a', item: null, listing: { offers: [{ exchange: { currency: 'exalted', amount: 1 }, item: { currency: 'divine', amount: 1, stock: 15 } }] } },
		b: { id: 'b', item: null, listing: { offers: [{ exchange: { currency: 'exalted', amount: 59 }, item: { currency: 'divine', amount: 1, stock: 24 } }] } },
		c: { id: 'c', item: null, listing: { offers: [{ exchange: { currency: 'exalted', amount: 70 }, item: { currency: 'divine', amount: 1, stock: 2 } }] } },
	},
};

describe('parseExchange', () => {
	it('flattens listings into buyer-view offers and detects truncation', () => {
		const r = parseExchange(RAW);
		expect(r.offers).toEqual([
			{ give: 'exalted', giveAmount: 1, get: 'divine', getAmount: 1, stock: 15 },
			{ give: 'exalted', giveAmount: 59, get: 'divine', getAmount: 1, stock: 24 },
			{ give: 'exalted', giveAmount: 70, get: 'divine', getAmount: 1, stock: 2 },
		]);
		expect(r.truncated).toBe(false);
		expect(parseExchange({ ...RAW, total: 40 }).truncated).toBe(true);
		expect(parseExchange({})).toEqual({ offers: [], total: 0, truncated: false });
	});
});

describe('bestOffer', () => {
	const exForDiv = parseExchange(RAW).offers; // pay ex, get div
	it('buy side: cheapest listing within the outlier band, price as quote per base', () => {
		// VWAP ≈ 96 ex per div → the 1 ex joke listing is outside 1/3〜3× and must be ignored
		expect(bestOffer(exForDiv, 'divine', 'exalted', 'buy', 96)).toEqual({ price: 59, stock: 24, offers: 2, listed: 3 });
	});
	it('without a VWAP nothing is filtered', () => {
		expect(bestOffer(exForDiv, 'divine', 'exalted', 'buy')).toEqual({ price: 1, stock: 15, offers: 3, listed: 3 });
	});
	it('sell side: highest price wins and stock is converted to base units', () => {
		// have=[vaal], want=[exalted]: seller gives 10 ex for 4 vaal and has 100 ex → 2.5 ex per vaal, room for 40 vaal
		const offers: Offer[] = [
			{ give: 'vaal', giveAmount: 4, get: 'exalted', getAmount: 10, stock: 100 },
			{ give: 'vaal', giveAmount: 1, get: 'exalted', getAmount: 2, stock: 9 },
		];
		expect(bestOffer(offers, 'vaal', 'exalted', 'sell', 2.4)).toEqual({ price: 2.5, stock: 40, offers: 2, listed: 2 });
	});
	it('returns null when no listing trades the pair or all are outliers', () => {
		expect(bestOffer(exForDiv, 'chaos', 'exalted', 'buy', 1)).toBeNull();
		expect(bestOffer(exForDiv, 'divine', 'exalted', 'buy', 1000)).toBeNull();
	});
});

describe('buildTradeIdMap', () => {
	it('keys trade-site ids by display name and skips separators', () => {
		expect(buildTradeIdMap({ result: [{ id: 'Currency', entries: [{ id: 'exalted', text: 'Exalted Orb' }, { id: 'sep', text: '' }, { id: 'divine', text: 'Divine Orb' }] }] }))
			.toEqual({ 'Exalted Orb': 'exalted', 'Divine Orb': 'divine' });
	});
});

describe('fetchExchange / fetchReference', () => {
	beforeEach(resetTradeState);
	const calls: { url: string; body: { query: { have: string[]; want: string[] } } }[] = [];
	const stub: typeof fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body)) as { query: { have: string[]; want: string[] } };
		calls.push({ url: String(url), body });
		const { have, want } = body.query;
		const offer = (give: string, giveAmount: number, get: string, getAmount: number, stock: number) =>
			({ listing: { offers: [{ exchange: { currency: give, amount: giveAmount }, item: { currency: get, amount: getAmount, stock } }] } });
		const result: Record<string, unknown> = {};
		// buy legs: pay ex, get vaal (2 ex each) / get sanctification (1000 ex each)
		if (have[0] === 'exalted' && want.includes('vaal')) { result.v = offer('exalted', 2, 'vaal', 1, 50); result.s = offer('exalted', 1000, 'sanctification', 1, 1); }
		// sell legs: give vaal, get div (1 div per 40 vaal); nobody buys sanctification
		if (want[0] === 'divine' && have.includes('vaal')) result.sv = offer('vaal', 40, 'divine', 1, 10);
		// hub conversion: pay div, get ex
		if (have[0] === 'divine' && want[0] === 'exalted') result.h = offer('divine', 1, 'exalted', 100, 500);
		return new Response(JSON.stringify({ total: Object.keys(result).length, result }), { status: 200 });
	};

	it('posts the trade-site query shape and caches per query', async () => {
		calls.length = 0;
		const r1 = await fetchExchange('Test League', ['exalted'], ['vaal'], stub);
		const r2 = await fetchExchange('Test League', ['exalted'], ['vaal'], stub);
		expect(r1).toBe(r2);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://www.pathofexile.com/api/trade2/exchange/poe2/Test%20League');
		expect(calls[0].body.query).toEqual({ status: { option: 'online' }, have: ['exalted'], want: ['vaal'] });
	});

	it('batches one hub direction into 3 requests and computes the reference profit', async () => {
		calls.length = 0;
		const base = { from: 'ex' as const, to: 'div' as const, fromId: 'exalted', toId: 'divine', convertVwap: 96 };
		const r = await fetchReference('Ref League', [
			{ ...base, itemId: 'Metadata/Items/Currency/CurrencyCorrupt', item: 'vaal', buyVwap: 2.1, sellVwap: 1 / 38 },
			{ ...base, itemId: 'Metadata/Items/Currency/Sanctification', item: 'sanctification', buyVwap: 900, sellVwap: 10 },
			{ ...base, itemId: 'Metadata/Items/Currency/Unknown', item: undefined, buyVwap: 1, sellVwap: 1 },
		], stub);
		expect(calls.map((c) => [c.body.query.have, c.body.query.want])).toEqual([
			[['exalted'], ['vaal', 'sanctification']],
			[['vaal', 'sanctification'], ['divine']],
			[['divine'], ['exalted']],
		]);
		expect(r.requests).toBe(3);
		expect(r.errors).toEqual([]);
		const [vaal, sanc, unknown] = r.loops;
		expect(vaal.buy).toEqual({ price: 2, stock: 50, offers: 1, listed: 1 });
		expect(vaal.sell).toEqual({ price: 1 / 40, stock: 400, offers: 1, listed: 1 }); // 10 div of stock buys 400 vaal
		expect(vaal.convert).toEqual({ price: 100, stock: 5, offers: 1, listed: 1 }); // 500 ex of stock takes 5 div
		expect(vaal.profit).toBeCloseTo((1 / 40) * 100 / 2); // 1.25
		expect(sanc.profit).toBeNull();
		expect(sanc.note).toBe('売りの出品なし');
		expect(unknown.note).toBe('トレードサイトに無いアイテム');
	});

	it('never throws: a failing query leaves legs empty and reports the error', async () => {
		const failing: typeof fetch = async () => new Response('nope', { status: 503 });
		const r = await fetchReference('Down League', [{ itemId: 'x', from: 'ex', to: 'div', item: 'vaal', fromId: 'exalted', toId: 'divine', buyVwap: 1, sellVwap: 1, convertVwap: 1 }], failing);
		expect(r.loops[0]).toMatchObject({ buy: null, sell: null, convert: null, profit: null });
		expect(r.errors).toEqual(['trade2 exchange: HTTP 503']);
	});
});
