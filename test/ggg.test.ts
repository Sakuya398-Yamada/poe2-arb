import { describe, expect, it } from 'vitest';
import { fetchWindow } from '../server/ggg.js';
import type { GggMarket } from '../shared/types.js';

const HOUR = 3600;
// Far-future base so the module-level bucket cache never collides with other tests.
const NOW = 4_000_000_000;

function market(id: string, league = 'Forbidden Rites'): GggMarket {
	return {
		league, market_id: id, market_pair: ['a', 'b'],
		volume_traded: {}, lowest_stock: {}, highest_stock: {}, lowest_ratio: {}, highest_ratio: {},
	};
}

/** Stub of the GGG endpoint: `markets` per bucket; unknown buckets are empty. Counts requests. */
function stub(byBucket: Record<number, GggMarket[]>) {
	const calls: number[] = [];
	const fetchImpl = (async (url: string | URL | Request) => {
		const bucket = Number(String(url).split('/').pop());
		calls.push(bucket);
		return new Response(JSON.stringify({ next_change_id: 0, markets: byBucket[bucket] ?? [] }), { status: 200 });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe('fetchWindow', () => {
	it('splits markets per hour bucket and fetches each bucket exactly once', async () => {
		const newest = Math.floor(NOW / HOUR) * HOUR - HOUR;
		const { fetchImpl, calls } = stub({
			[newest]: [market('m1'), market('other', 'Standard')],
			[newest - HOUR]: [market('m2')],
			[newest - 2 * HOUR]: [market('m3')],
		});
		const win = await fetchWindow('Forbidden Rites', 3, { now: NOW, fetchImpl });

		expect(calls).toHaveLength(3);
		expect(win.buckets).toEqual([newest - 2 * HOUR, newest - HOUR, newest]);
		expect(win.byBucket.map((h) => h.bucket)).toEqual(win.buckets);
		expect(win.byBucket.map((h) => h.markets.map((m) => m.market_id))).toEqual([['m3'], ['m2'], ['m1']]);
		expect(win.markets.map((m) => m.market_id)).toEqual(['m3', 'm2', 'm1']); // league-filtered, concatenated
		expect(win.leagues).toEqual(['Forbidden Rites', 'Standard']);
	});

	it('skips empty buckets so hoursUsed can be smaller than requested', async () => {
		const newest = Math.floor(NOW / HOUR) * HOUR - 20 * HOUR; // distinct buckets from the test above
		const { fetchImpl } = stub({ [newest]: [market('m1')], [newest - 2 * HOUR]: [market('m3')] });
		const win = await fetchWindow('Forbidden Rites', 3, { now: NOW - 19 * HOUR, fetchImpl });
		expect(win.buckets).toEqual([newest - 2 * HOUR, newest]);
		expect(win.byBucket).toHaveLength(2);
	});
});
