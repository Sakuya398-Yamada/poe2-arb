// Background polling of the hub↔hub conversion leg on the trade site's Bulk Item Exchange (#19). Hub pairs are
// liquid enough that their listings track the in-game rate, unlike item listings (lots of bait prices), so only
// these 6 directions are polled: one query every POLL_MS, and only while /api/loops was called in the last ACTIVE_MS.
// Queries go through exchange.ts, sharing its cache, rate-limit pacing and 429 back-off with the 出品相場 button.
import { bestOffer, fetchListings, type Offer } from './exchange.js';
import type { Hub, LiveHubRate } from '../shared/types.js';

/** 1 request / 60 s = 5 per 300 s, leaving 25 of the 30/300 s budget to the button */
export const POLL_MS = 60 * 1000;
/** stop polling when nobody has loaded the table for this long */
export const ACTIVE_MS = 10 * 60 * 1000;
/**
 * Outlier band for hub listings: vwap/1.25〜vwap×1.25, much tighter than the items' 3×. Hub pairs are liquid, so a
 * listing far from the exchange VWAP is bait, not the market. Observed 2026-09-27 (VWAP 490 ex/div): the best
 * in-3×-band listings were 260 ex/div (selling div) and 390 ex/div (buying div) — both rejected by this band.
 */
export const LIVE_BAND = 1.25;
/** older listings are not used (polling was paused); a full cycle over the 6 directions takes 6 min */
export const MAX_AGE_MS = 15 * 60 * 1000;

const HUBS: Hub[] = ['ex', 'div', 'chaos'];
/** [from, to]: the loop converts `to` back into `from`, i.e. pays `to` and receives `from` */
export const DIRECTIONS: [Hub, Hub][] = HUBS.flatMap((f) => HUBS.filter((t) => t !== f).map((t): [Hub, Hub] => [f, t]));

/** Listings of one direction as last fetched. `at` = when the trade site answered, `polledAt` = our last attempt. */
export interface Snapshot { offers: Offer[]; at: number; polledAt: number }
/** trade-site ids of the hubs ("exalted"); missing when the static data could not be loaded */
export type HubTradeIds = Partial<Record<Hub, string>>;

/**
 * Usable live rate for from→to (from units per 1 to), or null when never fetched, older than MAX_AGE_MS or with no
 * listing at all. `vwap` is the GGG exchange rate of the same direction, used for the outlier band.
 */
export function pickLiveRate(snap: Snapshot | undefined, from: Hub, to: Hub, ids: HubTradeIds, vwap: number | undefined, now: number): LiveHubRate | null {
	const fromId = ids[from], toId = ids[to];
	if (!snap || !fromId || !toId || now - snap.at > MAX_AGE_MS) return null;
	const leg = bestOffer(snap.offers, toId, fromId, 'sell', vwap, LIVE_BAND);
	if (!leg) return null;
	return { from, to, ...leg, vwap: vwap ?? null, fetchedAt: Math.floor(snap.at / 1000) };
}

/**
 * Next direction to poll: the one attempted longest ago (never = first), preferring the pair on screen on ties,
 * so the visible rates come in first after the poller (re)starts.
 */
export function nextDirection(snaps: ReadonlyMap<string, Snapshot>, league: string, hubs: [Hub, Hub], ids: HubTradeIds): [Hub, Hub] | null {
	const onScreen = (d: [Hub, Hub]) => hubs.includes(d[0]) && hubs.includes(d[1]);
	let best: [Hub, Hub] | null = null, bestAt = Infinity;
	for (const d of DIRECTIONS) {
		if (!ids[d[0]] || !ids[d[1]]) continue;
		const at = snaps.get(`${league}|${d[0]}|${d[1]}`)?.polledAt ?? -Infinity;
		if (at < bestAt || (at === bestAt && best && onScreen(d) && !onScreen(best))) { best = d; bestAt = at; }
	}
	return best;
}

// --- poller state ---
const snaps = new Map<string, Snapshot>();
let view: { league: string; hubs: [Hub, Hub]; ids: HubTradeIds; at: number } | null = null;
let lastError: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

/** For tests. */
export function resetLiveState(): void {
	snaps.clear();
	view = null;
	lastError = undefined;
	if (timer) clearInterval(timer);
	timer = undefined;
	busy = false;
}

/** Fetches one direction if someone is looking. Returns whether a query was attempted. Never throws. */
export async function pollOnce(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
	if (busy || !view) return false;
	if (now - view.at > ACTIVE_MS) {
		if (timer) clearInterval(timer);
		timer = undefined;
		return false;
	}
	const { league, hubs, ids } = view;
	const d = nextDirection(snaps, league, hubs, ids);
	if (!d) { lastError = 'ハブ通貨のトレードサイトIDが未解決'; return false; }
	const [from, to] = d;
	const key = `${league}|${from}|${to}`;
	busy = true;
	try {
		const { data, at } = await fetchListings(league, [ids[to]!], [ids[from]!], fetchImpl);
		snaps.set(key, { offers: data.offers, at, polledAt: now });
		lastError = undefined;
	} catch (e) {
		// keep the previous listings (they age out via MAX_AGE_MS) but move on to the next direction
		const prev = snaps.get(key);
		snaps.set(key, { offers: prev?.offers ?? [], at: prev?.at ?? -Infinity, polledAt: now });
		lastError = (e as Error).message;
	} finally {
		busy = false;
	}
	return true;
}

/** Called for every /api/loops request: remembers what is on screen and starts the poller if it is stopped. */
export function noteView(league: string, hubs: [Hub, Hub], ids: HubTradeIds, fetchImpl: typeof fetch = fetch): void {
	view = { league, hubs, ids, at: Date.now() };
	if (timer) return;
	timer = setInterval(() => void pollOnce(fetchImpl), POLL_MS);
	timer.unref?.();
	void pollOnce(fetchImpl);
}

/** Live rates for both directions of the pair on screen, with the VWAP of the current window for the band. */
export function liveRates(league: string, hubs: [Hub, Hub], ids: HubTradeIds, vwapOf: (from: Hub, to: Hub) => number | undefined, now = Date.now()): { rates: LiveHubRate[]; error?: string } {
	const rates: LiveHubRate[] = [];
	for (const [from, to] of [hubs, [hubs[1], hubs[0]]] as [Hub, Hub][]) {
		const r = pickLiveRate(snaps.get(`${league}|${from}|${to}`), from, to, ids, vwapOf(from, to), now);
		if (r) rates.push(r);
	}
	return { rates, ...(lastError ? { error: lastError } : {}) };
}
