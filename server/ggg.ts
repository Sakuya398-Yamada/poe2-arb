// Fetches GGG's public hourly Currency Exchange feed.
// Docs: https://www.pathofexile.com/developer/docs/reference  ("Currency Exchange")
// Endpoint: GET https://web.poecdn.com/api/currency-exchange/poe2/<unixHour>
// - no auth, ~5 min delay, only *completed* hours are served
// - an empty `markets` array means "that hour isn't available (yet)"
import type { GggHour, GggMarket } from '../shared/types.js';

const BASE = 'https://web.poecdn.com/api/currency-exchange/poe2';
const UA = process.env.POE2ARB_UA ?? 'poe2-arb/0.1 (personal currency-exchange viewer)';
const HOUR = 3600;

export const hourBucket = (unixSec: number) => Math.floor(unixSec / HOUR) * HOUR;

interface CacheEntry { at: number; data: GggHour }
const cache = new Map<number, CacheEntry>();
const EMPTY_TTL_MS = 60_000; // retry empty buckets after a minute (data may have just landed)

export async function fetchHour(bucket: number, fetchImpl: typeof fetch = fetch): Promise<GggHour> {
	const hit = cache.get(bucket);
	if (hit && (hit.data.markets.length > 0 || Date.now() - hit.at < EMPTY_TTL_MS)) return hit.data;

	const res = await fetchImpl(`${BASE}/${bucket}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
	if (!res.ok) throw new Error(`GGG currency-exchange ${bucket}: HTTP ${res.status}`);
	const data = (await res.json()) as GggHour;
	cache.set(bucket, { at: Date.now(), data });
	return data;
}

export interface Window {
	buckets: number[]; // ascending
	markets: GggMarket[]; // filtered to league, all hours concatenated
	/** same markets split per hour bucket (ascending, parallel to `buckets`) — for per-hour recurrence scoring */
	byBucket: { bucket: number; markets: GggMarket[] }[];
	leagues: string[]; // all leagues seen (for the league picker)
}

/**
 * Newest `hours` completed hourly buckets that have data, filtered to `league`.
 * Walks back from (now - 1h) up to `maxLookback` hours to find the newest available bucket.
 */
export async function fetchWindow(league: string, hours: number, opts: { now?: number; maxLookback?: number; fetchImpl?: typeof fetch } = {}): Promise<Window> {
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const maxLookback = opts.maxLookback ?? 8;
	const f = opts.fetchImpl ?? fetch;

	let newest = hourBucket(now) - HOUR;
	let found: GggHour | null = null;
	for (let i = 0; i < maxLookback; i++, newest -= HOUR) {
		const h = await fetchHour(newest, f);
		if (h.markets.length > 0) { found = h; break; }
	}
	if (!found) throw new Error(`No Currency Exchange data in the last ${maxLookback} hours`);

	const hoursData: { bucket: number; markets: GggMarket[] }[] = [{ bucket: newest, markets: found.markets }];
	for (let i = 1; i < hours; i++) {
		const b = newest - i * HOUR;
		const h = await fetchHour(b, f);
		if (h.markets.length === 0) continue;
		hoursData.push({ bucket: b, markets: h.markets });
	}
	hoursData.sort((a, b) => a.bucket - b.bucket);

	const all = hoursData.flatMap((h) => h.markets);
	const leagues = [...new Set(all.map((m) => m.league))].sort();
	const byBucket = hoursData.map((h) => ({ bucket: h.bucket, markets: h.markets.filter((m) => m.league === league) }));
	return { buckets: byBucket.map((h) => h.bucket), markets: byBucket.flatMap((h) => h.markets), byBucket, leagues };
}
