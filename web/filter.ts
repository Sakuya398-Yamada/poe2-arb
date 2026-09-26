// Per-column lower/upper range filters for the loop table. Pure (no DOM) so the pass/fail rules are unit-tested.
// Bounds are kept as the raw input text ('' = no limit) and converted to the loop's own units when compiled.
import type { Loop } from '../shared/types.js';

export type FilterKey = 'buy' | 'sell' | 'vwap' | 'live' | 'cons' | 'opt' | 'fee' | 'net' | 'cap' | 'rec' | 'med';
export interface BoundInput { min: string; max: string }
export type RangeInputs = Record<FilterKey, BoundInput>;

export interface FilterCol {
	key: FilterKey;
	label: string;
	/** unit shown next to the inputs */
	unit: string;
	step: string;
	/** the loop's value in its own units; undefined when the loop has no such value */
	value: (l: Loop) => number | undefined;
	/** input number → the units `value` returns */
	toNative: (n: number) => number;
	/** only meaningful with 2+ hours in the window */
	recurrence?: true;
	/** why the value can be missing, shown in the panel */
	missing?: string;
}

const id = (n: number) => n;
/** profits are multipliers (1.05 = +5%) but typed in as % like the old 最低利益 input */
const pctToMult = (n: number) => 1 + n / 100;

export const FILTER_COLS: FilterCol[] = [
	// buy/sell stay in each row's own hub (buy in `from`, sell in `to`) — the same number the column shows
	{ key: 'buy', label: '買い', unit: 'ハブ/個', step: 'any', value: (l) => l.buy.vwap, toNative: id },
	{ key: 'sell', label: '売り', unit: 'ハブ/個', step: 'any', value: (l) => l.sell.vwap, toNative: id },
	{ key: 'vwap', label: '利益(VWAP)', unit: '%', step: '1', value: (l) => l.profit.vwap, toNative: pctToMult },
	{ key: 'live', label: '利益(換算ライブ)', unit: '%', step: '1', value: (l) => l.profit.live, toNative: pctToMult, missing: '換算ライブ未取得・約定VWAPと乖離' },
	{ key: 'cons', label: '利益(保守)', unit: '%', step: '1', value: (l) => l.profit.conservative, toNative: pctToMult },
	{ key: 'opt', label: '利益(楽観)', unit: '%', step: '1', value: (l) => l.profit.optimistic, toNative: pctToMult },
	{ key: 'fee', label: '手数料', unit: 'g', step: '100', value: (l) => l.goldFee?.total, toNative: id, missing: '手数料不明' },
	{ key: 'net', label: '利益(手数料込)', unit: '%', step: '1', value: (l) => l.profit.afterFee, toNative: pctToMult, missing: '手数料不明・POE2ARB_GOLD_PER_EX 未設定' },
	{ key: 'cap', label: '取引数', unit: '個', step: '1', value: (l) => l.capacityItems, toNative: id },
	{
		key: 'rec', label: '再現', unit: '%', step: '10', recurrence: true, missing: '再現性なし',
		value: (l) => (l.recurrence && l.recurrence.hoursTotal > 0 ? l.recurrence.hoursProfitable / l.recurrence.hoursTotal : undefined),
		toNative: (n) => n / 100,
	},
	{ key: 'med', label: '利益(中央値)', unit: '%', step: '1', recurrence: true, missing: '再現性なし', value: (l) => l.recurrence?.medianProfit ?? undefined, toNative: pctToMult },
];

/** 利益(VWAP) >= 0% and 取引数 >= 10, the defaults of the old 最低利益 / 最低取引数 inputs */
export function defaultRanges(): RangeInputs {
	const r = Object.fromEntries(FILTER_COLS.map((c) => [c.key, { min: '', max: '' }])) as RangeInputs;
	r.vwap.min = '0';
	r.cap.min = '10';
	return r;
}

/** '' / whitespace / non-numbers mean "no limit" */
export function parseBound(s: string): number | undefined {
	if (s.trim() === '') return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

export interface CompiledRange { value: (l: Loop) => number | undefined; min?: number; max?: number }

/**
 * The ranges that actually restrict something. Recurrence columns are skipped when the window has one hour,
 * because their columns are hidden then and a leftover bound would silently empty the table.
 */
export function compileRanges(inputs: RangeInputs, opts: { recurrence: boolean }): CompiledRange[] {
	const out: CompiledRange[] = [];
	for (const c of FILTER_COLS) {
		if (c.recurrence && !opts.recurrence) continue;
		const min = parseBound(inputs[c.key].min);
		const max = parseBound(inputs[c.key].max);
		if (min === undefined && max === undefined) continue;
		out.push({ value: c.value, min: min === undefined ? undefined : c.toNative(min), max: max === undefined ? undefined : c.toNative(max) });
	}
	return out;
}

/** Inclusive on both ends. A loop without a value for a restricted column is dropped (it can't be shown to satisfy it). */
export function passesRanges(l: Loop, ranges: CompiledRange[]): boolean {
	for (const r of ranges) {
		const v = r.value(l);
		if (v === undefined || !Number.isFinite(v)) return false;
		if (r.min !== undefined && v < r.min) return false;
		if (r.max !== undefined && v > r.max) return false;
	}
	return true;
}

/**
 * Ranges from the saved localStorage settings. Settings saved before the range filters had only
 * `minProfit` / `minCap`; an empty old 最低利益 meant 0% (it went through `Number('') || 0`), so it maps to '0'.
 */
export function restoreRanges(saved: unknown): RangeInputs {
	const r = defaultRanges();
	if (typeof saved !== 'object' || saved === null) return r;
	const s = saved as { ranges?: unknown; minProfit?: unknown; minCap?: unknown };
	if (typeof s.ranges === 'object' && s.ranges !== null) {
		const src = s.ranges as Partial<Record<FilterKey, Partial<BoundInput>>>;
		for (const c of FILTER_COLS) {
			const b = src[c.key];
			if (!b) continue;
			if (typeof b.min === 'string') r[c.key].min = b.min;
			if (typeof b.max === 'string') r[c.key].max = b.max;
		}
		return r;
	}
	if (s.minProfit != null) r.vwap.min = String(s.minProfit) || '0';
	if (s.minCap != null) r.cap.min = String(s.minCap) || '0';
	return r;
}

/** number of columns with a bound in effect, for the panel toggle's label */
export function activeCount(inputs: RangeInputs, opts: { recurrence: boolean }): number {
	return compileRanges(inputs, opts).length;
}
