import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveProfit } from '../server/arb.js';
import { resetTradeState, type Offer } from '../server/exchange.js';
import { ACTIVE_MS, MAX_AGE_MS, liveRates, nextDirection, noteView, pickLiveRate, pollOnce, resetLiveState, type HubTradeIds, type Snapshot } from '../server/live.js';
import type { Hub, LoopStep } from '../shared/types.js';

const IDS: HubTradeIds = { ex: 'exalted', div: 'divine', chaos: 'chaos' };
const step = (hub: Hub, vwap: number): LoopStep => ({ hub, worst: vwap, best: vwap, vwap, volumeItems: 1, volumeHub: 1 });
/** Seen from the buyer: pay `giveAmount` div, get `getAmount` ex (the listings for the ex→item→div→ex conversion) */
const divToEx = (giveAmount: number, getAmount: number, stock: number): Offer => ({ give: 'divine', giveAmount, get: 'exalted', getAmount, stock });

describe('liveProfit', () => {
	it('replaces only the conversion leg: sell × live / buy', () => {
		// buy 1 item for 100 ex, sell it for 0.5 div, 1 div = 400 ex → 200 ex back
		expect(liveProfit({ buy: step('ex', 100), sell: step('div', 0.5) }, 400)).toBeCloseTo(2);
		expect(liveProfit({ buy: step('ex', 100), sell: step('div', 0.5) }, 190)).toBeCloseTo(0.95);
	});
});

describe('pickLiveRate', () => {
	const now = 1_000_000_000_000;
	const snap = (offers: Offer[], ageMs = 0): Snapshot => ({ offers, at: now - ageMs, polledAt: now - ageMs });

	it('takes the best in-band listing as `from` units per 1 `to`, dropping joke listings', () => {
		const s = snap([divToEx(1, 390, 3900), divToEx(1, 400, 4000), divToEx(1, 5, 50)]);
		const r = pickLiveRate(s, 'ex', 'div', IDS, 395, now);
		expect(r).toEqual({ from: 'ex', to: 'div', price: 400, stock: 10, offers: 2, listed: 3, inBand: true, vwap: 395, fetchedAt: now / 1000 });
	});

	it('uses the tight hub band (VWAP 0.8〜1.25×): the 2026-09-27 listings far from VWAP are rejected', () => {
		// observed: exchange VWAP 490 ex/div, best trade-site listings 260 and 390 ex/div (both inside the items' 3× band)
		const r = pickLiveRate(snap([divToEx(1, 260, 2860), divToEx(1, 390, 3900)]), 'ex', 'div', IDS, 490, now);
		expect(r).toMatchObject({ price: 390, offers: 0, listed: 2, inBand: false });
		// 0.8× and 1.25× themselves are inside
		expect(pickLiveRate(snap([divToEx(1, 392, 3920)]), 'ex', 'div', IDS, 490, now)?.inBand).toBe(true);
		expect(pickLiveRate(snap([divToEx(1, 612.5, 6125)]), 'ex', 'div', IDS, 490, now)?.inBand).toBe(true);
	});

	it('marks a rate off-band when every listing is outside the band', () => {
		const r = pickLiveRate(snap([divToEx(1, 5, 50)]), 'ex', 'div', IDS, 395, now);
		expect(r?.inBand).toBe(false);
		expect(r?.price).toBe(5);
	});

	it('returns null when never fetched, too old, without listings or without trade-site ids', () => {
		const offers = [divToEx(1, 400, 4000)];
		expect(pickLiveRate(undefined, 'ex', 'div', IDS, 395, now)).toBeNull();
		expect(pickLiveRate(snap(offers, MAX_AGE_MS + 1), 'ex', 'div', IDS, 395, now)).toBeNull();
		expect(pickLiveRate(snap([]), 'ex', 'div', IDS, 395, now)).toBeNull();
		expect(pickLiveRate(snap(offers), 'ex', 'div', { ex: 'exalted' }, 395, now)).toBeNull();
		expect(pickLiveRate(snap(offers, MAX_AGE_MS), 'ex', 'div', IDS, undefined, now)?.vwap).toBeNull();
	});
});

describe('nextDirection', () => {
	it('starts with the pair on screen, then takes the direction attempted longest ago', () => {
		const snaps = new Map<string, Snapshot>();
		expect(nextDirection(snaps, 'L', ['ex', 'div'], IDS)).toEqual(['ex', 'div']);
		expect(nextDirection(snaps, 'L', ['div', 'chaos'], IDS)).toEqual(['div', 'chaos']);
		snaps.set('L|div|chaos', { offers: [], at: 5, polledAt: 5 });
		expect(nextDirection(snaps, 'L', ['div', 'chaos'], IDS)).toEqual(['chaos', 'div']);
		for (const [i, k] of ['ex|div', 'ex|chaos', 'div|ex', 'chaos|ex', 'chaos|div'].entries()) snaps.set(`L|${k}`, { offers: [], at: 10 + i, polledAt: 10 + i });
		expect(nextDirection(snaps, 'L', ['div', 'chaos'], IDS)).toEqual(['div', 'chaos']);
	});

	it('skips hubs without a trade-site id', () => {
		expect(nextDirection(new Map(), 'L', ['ex', 'div'], { ex: 'exalted', chaos: 'chaos' })).toEqual(['ex', 'chaos']);
		expect(nextDirection(new Map(), 'L', ['ex', 'div'], {})).toBeNull();
	});
});

describe('poller', () => {
	beforeEach(() => { resetTradeState({ pacing: false }); resetLiveState(); });
	afterEach(() => resetLiveState());
	const queries: { have: string[]; want: string[] }[] = [];
	const stub: typeof fetch = async (_url, init) => {
		const { have, want } = (JSON.parse(String(init?.body)) as { query: { have: string[]; want: string[] } }).query;
		queries.push({ have, want });
		const listing = (give: string, giveAmount: number, get: string, getAmount: number, stock: number) =>
			({ listing: { offers: [{ exchange: { currency: give, amount: giveAmount }, item: { currency: get, amount: getAmount, stock } }] } });
		const result: Record<string, unknown> = {};
		if (have[0] === 'divine' && want[0] === 'exalted') result.a = listing('divine', 1, 'exalted', 400, 4000);
		if (have[0] === 'exalted' && want[0] === 'divine') result.b = listing('exalted', 410, 'divine', 1, 20);
		return new Response(JSON.stringify({ total: Object.keys(result).length, result }), { status: 200 });
	};
	const vwap = (from: Hub, to: Hub) => (from === 'ex' && to === 'div' ? 395 : from === 'div' && to === 'ex' ? 1 / 395 : undefined);

	it('polls one direction at a time, starting with the pair on screen, and serves both directions', async () => {
		queries.length = 0;
		noteView('L', ['ex', 'div'], IDS, stub);
		await vi.waitFor(() => expect(liveRates('L', ['ex', 'div'], IDS, vwap).rates).toHaveLength(1));
		// ex→item→div→ex converts div back to ex: pay div (have), get ex (want)
		expect(queries[0]).toEqual({ have: ['divine'], want: ['exalted'] });
		expect(await pollOnce(stub)).toBe(true);
		expect(queries[1]).toEqual({ have: ['exalted'], want: ['divine'] });

		const { rates, error } = liveRates('L', ['ex', 'div'], IDS, vwap);
		expect(error).toBeUndefined();
		expect(rates.map((r) => [r.from, r.to, r.price, r.inBand])).toEqual([['ex', 'div', 400, true], ['div', 'ex', 1 / 410, true]]);
		expect(liveRates('Other', ['ex', 'div'], IDS, vwap).rates).toEqual([]);
	});

	it('stops when nobody has loaded the table for ACTIVE_MS', async () => {
		queries.length = 0;
		noteView('L', ['ex', 'div'], IDS, stub);
		await vi.waitFor(() => expect(liveRates('L', ['ex', 'div'], IDS, vwap).rates).toHaveLength(1));
		expect(await pollOnce(stub, Date.now() + ACTIVE_MS + 1)).toBe(false);
		expect(queries).toHaveLength(1);
	});

	it('keeps going without throwing when the trade site fails, and reports the error', async () => {
		const failing: typeof fetch = async () => new Response('', { status: 503 });
		noteView('L', ['ex', 'div'], IDS, failing);
		await vi.waitFor(() => expect(liveRates('L', ['ex', 'div'], IDS, vwap).error).toBe('trade2 exchange: HTTP 503'));
		expect(liveRates('L', ['ex', 'div'], IDS, vwap).rates).toEqual([]);
		// the failed direction counts as attempted, so the next poll moves on to the reverse direction
		queries.length = 0;
		expect(await pollOnce(stub)).toBe(true);
		expect(queries[0]).toEqual({ have: ['exalted'], want: ['divine'] });
		expect(liveRates('L', ['ex', 'div'], IDS, vwap).error).toBeUndefined();
	});
});
