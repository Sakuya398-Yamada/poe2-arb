import { describe, expect, it } from 'vitest';
import { buildBook, computeLoop, findLoops, goldFeePerItem, goldPerHubFromEx, loopKey, pricePerUnit, scoreRecurrence } from '../server/arb.js';
import { HUB_IDS, type GggMarket } from '../shared/types.js';

const EX = HUB_IDS.ex, DIV = HUB_IDS.div, CH = HUB_IDS.chaos;
const VAAL = 'Metadata/Items/Currency/CurrencyCorrupt';

/** Helper mirroring GGG's shape: ratio = qty[pair[0]] / qty[pair[1]]. */
function market(pair: [string, string], lowest: [number, number], highest: [number, number], vol: [number, number], league = 'Forbidden Rites'): GggMarket {
	return {
		league,
		market_id: pair.join('|'),
		market_pair: pair,
		volume_traded: { [pair[0]]: vol[0], [pair[1]]: vol[1] },
		lowest_stock: { [pair[0]]: 0, [pair[1]]: 0 },
		highest_stock: { [pair[0]]: 0, [pair[1]]: 0 },
		lowest_ratio: { [pair[0]]: lowest[0], [pair[1]]: lowest[1] },
		highest_ratio: { [pair[0]]: highest[0], [pair[1]]: highest[1] },
	};
}

// Real records seen on 2026-09-06 (Forbidden Rites):
//   Div|Ex   lowest {div:1, ex:106} highest {div:1, ex:90}
//   Vaal|Ex  lowest {vaal:1, ex:1}  highest {vaal:4, ex:1}
//   Vaal|Div lowest {vaal:56, div:1} highest {vaal:70, div:1}
const divEx = market([DIV, EX], [1, 106], [1, 90], [34366, 3372971]);
const vaalEx = market([VAAL, EX], [1, 1], [4, 1], [16515, 5366]);
const vaalDiv = market([VAAL, DIV], [56, 1], [70, 1], [683, 11]);

describe('pricePerUnit', () => {
	it('reads ex per div from a Div|Ex market', () => {
		expect(pricePerUnit(divEx, DIV, EX)).toEqual({ lo: 90, hi: 106 });
	});
	it('reads div per ex (inverse) from the same market', () => {
		const r = pricePerUnit(divEx, EX, DIV)!;
		expect(r.lo).toBeCloseTo(1 / 106);
		expect(r.hi).toBeCloseTo(1 / 90);
	});
	it('handles the item being on either side of the pair', () => {
		expect(pricePerUnit(vaalEx, VAAL, EX)).toEqual({ lo: 0.25, hi: 1 });
		const flipped = market([EX, VAAL], [1, 1], [1, 4], [1, 1]); // ex/vaal: 1 .. 0.25
		expect(pricePerUnit(flipped, VAAL, EX)).toEqual({ lo: 0.25, hi: 1 });
	});
	it('returns null when the hour had no trades (zero ratios)', () => {
		expect(pricePerUnit(market([VAAL, EX], [0, 0], [0, 0], [0, 0]), VAAL, EX)).toBeNull();
	});
});

describe('buildBook', () => {
	it('collects hub↔hub rates in both directions and item quotes per hub', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		expect(book.hubRates.get('ex|div')?.price).toEqual({ lo: 90, hi: 106 });
		expect(book.hubRates.get('div|ex')?.price.lo).toBeCloseTo(1 / 106);
		expect(book.hubRates.get('ex|div')?.vwap).toBeCloseTo(3372971 / 34366);
		expect(book.hubRates.get('div|ex')?.vwap).toBeCloseTo(34366 / 3372971);
		const v = book.items.get(VAAL)!;
		expect(v.ex?.price).toEqual({ lo: 0.25, hi: 1 });
		expect(v.div?.price.lo).toBeCloseTo(1 / 70);
		expect(v.div?.price.hi).toBeCloseTo(1 / 56);
		expect(v.ex?.volumeItems).toBe(16515);
		expect(v.div?.volumeHub).toBe(11);
	});
	it('merges multiple hours: ranges widen, volumes add', () => {
		const h2 = market([VAAL, EX], [1, 2], [2, 1], [100, 100]); // 2 ex .. 0.5 ex
		const book = buildBook([vaalEx, h2]);
		expect(book.items.get(VAAL)!.ex).toMatchObject({ price: { lo: 0.25, hi: 2 }, volumeItems: 16615, volumeHub: 5466 });
		expect(book.items.get(VAAL)!.ex!.vwap).toBeCloseTo(5466 / 16615);
	});
	it('ignores item↔item markets', () => {
		const book = buildBook([market([VAAL, 'Metadata/Items/Currency/CurrencyGemQuality'], [1, 1], [1, 1], [1, 1])]);
		expect(book.items.size).toBe(0);
	});
});

describe('computeLoop / findLoops', () => {
	const resolve = (id: string) => ({ name: id.split('/').pop()!, category: 'Currency' });

	it('ex→vaal→div→ex, conservative uses the side that hurts at each step', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		const { loops } = findLoops(book, 'ex', 'div', resolve);
		const l = loops.find((x) => x.from === 'ex' && x.to === 'div')!;
		// buy at worst 1 ex/vaal, sell at worst 1/70 div/vaal, convert at worst 90 ex/div
		expect(l.buy.worst).toBe(1);
		expect(l.sell.worst).toBeCloseTo(1 / 70);
		expect(l.convert.worst).toBe(90);
		expect(l.profit.conservative).toBeCloseTo((1 / 70) * 90 / 1); // ≈ 1.286
		// optimistic: buy 0.25, sell 1/56, convert 106
		expect(l.profit.optimistic).toBeCloseTo((1 / 56) * 106 / 0.25);
		// vwap legs: buy 5366/16515 ex per vaal, sell 11/683 div per vaal, convert 3372971/34366 ex per div
		expect(l.buy.vwap).toBeCloseTo(5366 / 16515);
		expect(l.sell.vwap).toBeCloseTo(11 / 683);
		expect(l.convert.vwap).toBeCloseTo(3372971 / 34366);
		expect(l.profit.vwap).toBeCloseTo((11 / 683) * (3372971 / 34366) / (5366 / 16515));
		expect(l.capacityItems).toBe(683);
	});

	it('also emits the reverse loop div→vaal→ex→div using the inverse hub rate', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		const { loops } = findLoops(book, 'ex', 'div', resolve);
		const l = loops.find((x) => x.from === 'div' && x.to === 'ex')!;
		// buy vaal at worst 1/56 div each, sell at worst 0.25 ex each, convert at worst 1/106 div per ex
		expect(l.profit.conservative).toBeCloseTo(0.25 * (1 / 106) / (1 / 56));
	});

	it('passes the Japanese name and icon through to both loop directions, omitting absent keys', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		const withJa = (id: string) => ({ ...resolve(id), ja: 'ヴァールオーブ' });
		const { loops } = findLoops(book, 'ex', 'div', withJa);
		expect(loops).toHaveLength(2);
		for (const l of loops) { expect(l.ja).toBe('ヴァールオーブ'); expect('icon' in l).toBe(false); }
		expect('ja' in findLoops(book, 'ex', 'div', resolve).loops[0]).toBe(false);
	});

	it('skips items quoted in only one hub', () => {
		const book = buildBook([divEx, vaalEx]);
		const r = findLoops(book, 'ex', 'div', resolve);
		expect(r.loops).toHaveLength(0);
		expect(r.skipped).toBe(1);
	});

	it('profit is exactly 1.0 when all three legs are consistent', () => {
		const q = (hub: 'ex' | 'div', p: number) => ({ hub, price: { lo: p, hi: p }, vwap: p, volumeItems: 1, volumeHub: p });
		// item = 10 ex = 0.1 div, 1 div = 100 ex
		const l = computeLoop('x', 'x', 'c', q('ex', 10), q('div', 0.1), { price: { lo: 100, hi: 100 }, vwap: 100, volumeFrom: 100, volumeTo: 1 });
		expect(l.profit.conservative).toBeCloseTo(1);
		expect(l.profit.vwap).toBeCloseTo(1);
		expect(l.profit.optimistic).toBeCloseTo(1);
	});

	it('works with chaos as a hub too', () => {
		const chEx = market([CH, EX], [1, 5], [1, 2], [1, 1]); // 2..5 ex per chaos
		const vaalCh = market([VAAL, CH], [10, 1], [12, 1], [1, 1]);
		const book = buildBook([chEx, vaalEx, vaalCh]);
		const { loops } = findLoops(book, 'ex', 'chaos', resolve);
		expect(loops).toHaveLength(2);
	});
});

// GoldPurchaseFee per requested unit, from poe2db's Currency Exchange table (2026-09-07):
//   Exalted 120, Chaos 160, Divine 800, Vaal 160
const FEES: Record<string, number> = { [EX]: 120, [CH]: 160, [DIV]: 800, [VAAL]: 160 };
const feeOf = (id: string) => FEES[id];

describe('gold fee', () => {
	const resolve = (id: string) => ({ name: id.split('/').pop()!, category: 'Currency' });
	it('charges fee(requested) × units received on each leg', () => {
		// 1 item sells for 0.02 div, 1 div = 100 ex: leg1 requests 1 vaal, leg2 requests 0.02 div, leg3 requests 2 ex
		const f = goldFeePerItem(160, 800, 120, 0.02, 100);
		expect(f.item).toBe(160);
		expect(f.toHub).toBeCloseTo(16);
		expect(f.fromHub).toBeCloseTo(240);
		expect(f.total).toBeCloseTo(416);
	});

	it('attaches goldFee to loops and derives afterFee from the gold→from-hub rate', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		const goldPerHub = { ex: 1000 };
		const { loops } = findLoops(book, 'ex', 'div', resolve, { feeOf, goldPerHub });
		const l = loops.find((x) => x.from === 'ex' && x.to === 'div')!;
		const expected = goldFeePerItem(160, 800, 120, l.sell.vwap, l.convert.vwap);
		expect(l.goldFee).toEqual(expected);
		// fee (in ex) per item / cost (ex) per item = fraction of the stack lost to gold
		expect(l.profit.afterFee).toBeCloseTo(l.profit.vwap - expected.total / 1000 / l.buy.vwap);
		// reverse loop starts in div, whose gold rate is not configured → fee known but no afterFee
		const r = loops.find((x) => x.from === 'div' && x.to === 'ex')!;
		expect(r.goldFee).toEqual(goldFeePerItem(160, 120, 800, r.sell.vwap, r.convert.vwap));
		expect(r.profit.afterFee).toBeUndefined();
	});

	it('omits goldFee when the item fee is unknown', () => {
		const book = buildBook([divEx, vaalEx, vaalDiv]);
		const { loops } = findLoops(book, 'ex', 'div', resolve, { feeOf: (id) => (id === VAAL ? undefined : FEES[id]) });
		expect(loops.every((l) => l.goldFee === undefined && l.profit.afterFee === undefined)).toBe(true);
	});

	it('goldPerHubFromEx scales div/chaos by the observed ex-per-hub VWAP', () => {
		const book = buildBook([divEx]);
		const g = goldPerHubFromEx(1000, book.hubRates);
		expect(g.ex).toBe(1000);
		expect(g.div).toBeCloseTo(1000 * (3372971 / 34366));
		expect(g.chaos).toBeUndefined();
	});
});

describe('scoreRecurrence', () => {
	// A synthetic loop with an exact VWAP profit multiplier: item = 10 ex, sold for 0.1*p div, 1 div = 100 ex.
	const q = (hub: 'ex' | 'div', p: number) => ({ hub, price: { lo: p, hi: p }, vwap: p, volumeItems: 1, volumeHub: p });
	const rate = { price: { lo: 100, hi: 100 }, vwap: 100, volumeFrom: 100, volumeTo: 1 };
	const loop = (itemId: string, profit: number, reverse = false) =>
		reverse
			? computeLoop(itemId, itemId, 'c', q('div', 0.1), q('ex', 10 * profit), { price: { lo: 0.01, hi: 0.01 }, vwap: 0.01, volumeFrom: 1, volumeTo: 100 })
			: computeLoop(itemId, itemId, 'c', q('ex', 10), q('div', 0.1 * profit), rate);

	it('counts profitable hours over all hours, treating a missing hour as not profitable', () => {
		const r = scoreRecurrence([[loop('a', 1.2)], [loop('a', 1.05)], []]);
		const a = r.get('a|ex|div')!;
		expect(a.hoursTotal).toBe(3);
		expect(a.hoursProfitable).toBe(2);
		expect(a.medianProfit).toBeCloseTo((1.2 + 1.05) / 2); // even count → mean of the middle two
	});

	it('takes the median over hours where the loop existed, unprofitable ones included', () => {
		const r = scoreRecurrence([[loop('a', 1.3)], [loop('a', 0.9)], [loop('a', 1.1)]]);
		const a = r.get('a|ex|div')!;
		expect(a.hoursProfitable).toBe(2);
		expect(a.medianProfit).toBeCloseTo(1.1);
	});

	it('is 1/1 for a single hour and keeps the two directions apart', () => {
		const fwd = loop('a', 1.2), rev = loop('a', 0.8, true);
		expect(loopKey(fwd)).toBe('a|ex|div');
		expect(loopKey(rev)).toBe('a|div|ex');
		const r = scoreRecurrence([[fwd, rev]]);
		expect(r.get('a|ex|div')).toEqual({ hoursProfitable: 1, hoursTotal: 1, medianProfit: fwd.profit.vwap });
		expect(r.get('a|div|ex')!.hoursProfitable).toBe(0);
	});

	it('exactly break-even (profit 1.0) does not count as profitable', () => {
		const r = scoreRecurrence([[loop('a', 1)]]);
		expect(r.get('a|ex|div')!.hoursProfitable).toBe(0);
	});
});
