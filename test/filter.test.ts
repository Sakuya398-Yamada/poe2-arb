import { describe, expect, it } from 'vitest';
import type { Loop } from '../shared/types.js';
import { activeCount, compileRanges, defaultRanges, parseBound, passesRanges, restoreRanges, type RangeInputs } from '../web/filter.js';

function loop(over: Partial<Loop> = {}, profit: Partial<Loop['profit']> = {}): Loop {
	const step = { hub: 'ex' as const, worst: 1, best: 1, vwap: 1, volumeItems: 50, volumeHub: 50 };
	return {
		itemId: 'x', name: 'X', category: 'Currency', from: 'ex', to: 'div',
		buy: { ...step, vwap: 2 }, sell: { ...step, hub: 'div', vwap: 0.01 },
		convert: { worst: 200, best: 200, vwap: 200 },
		capacityItems: 30,
		...over,
		profit: { vwap: 1.05, conservative: 0.9, optimistic: 1.2, ...profit },
	};
}

function ranges(set: Partial<Record<keyof RangeInputs, { min?: string; max?: string }>>): RangeInputs {
	const r = defaultRanges();
	r.vwap.min = ''; r.cap.min = '';
	for (const [k, v] of Object.entries(set)) Object.assign(r[k as keyof RangeInputs], v);
	return r;
}

const pass = (l: Loop, r: RangeInputs, recurrence = true) => passesRanges(l, compileRanges(r, { recurrence }));

describe('parseBound', () => {
	it('treats blank and non-numeric input as no limit', () => {
		expect(parseBound('')).toBeUndefined();
		expect(parseBound('  ')).toBeUndefined();
		expect(parseBound('abc')).toBeUndefined();
		expect(parseBound('-5')).toBe(-5);
		expect(parseBound('0')).toBe(0);
	});
});

describe('defaults', () => {
	it('keep the old 最低利益 0% / 最低取引数 10 behaviour', () => {
		const r = defaultRanges();
		expect(pass(loop({}, { vwap: 1 }), r)).toBe(true); // exactly 0% passes (>=)
		expect(pass(loop({}, { vwap: 0.999 }), r)).toBe(false);
		expect(pass(loop({ capacityItems: 10 }), r)).toBe(true);
		expect(pass(loop({ capacityItems: 9 }), r)).toBe(false);
		expect(activeCount(r, { recurrence: true })).toBe(2);
	});
});

describe('passesRanges', () => {
	it('lets everything through when every bound is blank', () => {
		expect(pass(loop({ capacityItems: 0 }, { vwap: 0.5 }), ranges({}))).toBe(true);
	});
	it('reads profits in % and applies inclusive lower / upper bounds', () => {
		const r = ranges({ vwap: { min: '5', max: '50' } });
		expect(pass(loop({}, { vwap: 1.05 }), r)).toBe(true);
		expect(pass(loop({}, { vwap: 1.5 }), r)).toBe(true);
		expect(pass(loop({}, { vwap: 1.04 }), r)).toBe(false);
		expect(pass(loop({}, { vwap: 3.2 }), r)).toBe(false); // the thin-market outlier an upper bound is for
	});
	it('supports an upper bound alone', () => {
		const r = ranges({ opt: { max: '10' } });
		expect(pass(loop({}, { optimistic: 1.1 }), r)).toBe(true);
		expect(pass(loop({}, { optimistic: 1.11 }), r)).toBe(false);
	});
	it('compares buy / sell in the row\'s own hub units', () => {
		const r = ranges({ buy: { max: '2' }, sell: { min: '0.005' } });
		expect(pass(loop(), r)).toBe(true);
		expect(pass(loop({ buy: { ...loop().buy, vwap: 2.5 } }), r)).toBe(false);
	});
	it('filters gold fee and capacity in their plain units', () => {
		const fee = { item: 100, toHub: 800, fromHub: 120, total: 1020 };
		expect(pass(loop({ goldFee: fee }), ranges({ fee: { max: '1000' } }))).toBe(false);
		expect(pass(loop({ goldFee: fee }), ranges({ fee: { max: '1020' } }))).toBe(true);
		expect(pass(loop({ capacityItems: 30 }), ranges({ cap: { min: '10', max: '30' } }))).toBe(true);
	});
	it('reads recurrence as the % of hours the loop was profitable', () => {
		const rec = { hoursProfitable: 3, hoursTotal: 6, medianProfit: 1.02 };
		expect(pass(loop({ recurrence: rec }), ranges({ rec: { min: '50' } }))).toBe(true);
		expect(pass(loop({ recurrence: rec }), ranges({ rec: { min: '51' } }))).toBe(false);
		expect(pass(loop({ recurrence: rec }), ranges({ med: { min: '2' } }))).toBe(true);
	});
});

describe('loops missing a value', () => {
	const noFee = loop();
	const noRec = loop();
	it('are dropped only when that column has a bound', () => {
		expect(pass(noFee, ranges({}))).toBe(true);
		expect(pass(noFee, ranges({ fee: { max: '5000' } }))).toBe(false);
		expect(pass(noFee, ranges({ net: { min: '-100' } }))).toBe(false); // no POE2ARB_GOLD_PER_EX → no afterFee
		expect(pass(loop({}, { afterFee: 1.01 }), ranges({ net: { min: '0' } }))).toBe(true);
		expect(pass(noRec, ranges({ rec: { min: '0' } }))).toBe(false);
		expect(pass(loop({ recurrence: { hoursProfitable: 0, hoursTotal: 3, medianProfit: null } }), ranges({ med: { min: '-100' } }))).toBe(false);
	});
	it('are kept when the window has one hour, because recurrence bounds are ignored then', () => {
		const r = ranges({ rec: { min: '50' }, med: { min: '0' } });
		expect(pass(noRec, r, false)).toBe(true);
		expect(activeCount(r, { recurrence: false })).toBe(0);
		expect(activeCount(r, { recurrence: true })).toBe(2);
	});
});

describe('restoreRanges', () => {
	it('falls back to the defaults for missing or broken settings', () => {
		expect(restoreRanges(undefined)).toEqual(defaultRanges());
		expect(restoreRanges({})).toEqual(defaultRanges());
		expect(restoreRanges('junk')).toEqual(defaultRanges());
	});
	it('migrates the old minProfit / minCap settings', () => {
		const r = restoreRanges({ minProfit: '5', minCap: '3', hubs: 'ex,div' });
		expect(r.vwap).toEqual({ min: '5', max: '' });
		expect(r.cap).toEqual({ min: '3', max: '' });
		// an empty old 最低利益 behaved as 0%, so it must not become "no limit"
		expect(restoreRanges({ minProfit: '', minCap: '' }).vwap.min).toBe('0');
	});
	it('restores saved ranges, including a deliberately blank default column', () => {
		const r = restoreRanges({ ranges: { vwap: { min: '', max: '100' }, fee: { min: '', max: '3000' }, bogus: { min: '1' } } });
		expect(r.vwap).toEqual({ min: '', max: '100' });
		expect(r.fee).toEqual({ min: '', max: '3000' });
		expect(r.cap).toEqual({ min: '10', max: '' });
		expect(r).not.toHaveProperty('bogus');
	});
});
