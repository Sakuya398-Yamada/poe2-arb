// Gold fee per exchange-able item. The game data table `CurrencyExchange` has a per-item `GoldPurchaseFee`
// (poe-tool-dev/dat-schema), but RePoE's PoE2 export does not include it, so we scrape poe2db's rendering
// of that table:  https://poe2db.tw/us/Currency_Exchange  (~570 KB HTML, one <a>name</a><span>fee</span> per item).
// Keyed by item name (unique on that page, and equal to RePoE `name`). Cached to .cache/gold.json for a week;
// the values only change with game patches. Never throws: with no data the UI just shows no fee.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://poe2db.tw/us/Currency_Exchange';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'gold.json');
const TTL_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/** item name → gold charged per 1 unit when that item is the requested ("I want") side */
export type GoldFeeMap = Record<string, number>;
interface CacheFile { fetchedAt: number; fees: GoldFeeMap }

let cached: CacheFile | null = null;
let nextRefreshAt = 0;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };

/** Exported for tests. Returns an empty map when the markup is not what we expect. */
export function parseGoldFees(html: string): GoldFeeMap {
	const fees: GoldFeeMap = {};
	// the name link's class varies by item type (item_currency / whiteitem SoulCore / gem_red …), so don't key on it
	const re = /<a class="[^"]*"[^>]*href="[^"]*">([^<]+)<\/a><span>(\d+)<\/span>/g;
	for (const m of html.matchAll(re)) {
		const name = m[1].replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e).trim();
		if (name && !(name in fees)) fees[name] = Number(m[2]);
	}
	return fees;
}

async function download(fetchImpl: typeof fetch): Promise<CacheFile> {
	const res = await fetchImpl(URL, { headers: { 'User-Agent': process.env.POE2ARB_UA ?? 'poe2-arb/0.1' } });
	if (!res.ok) throw new Error(`poe2db Currency_Exchange: HTTP ${res.status}`);
	const fees = parseGoldFees(await res.text());
	if (Object.keys(fees).length === 0) throw new Error('poe2db Currency_Exchange: no fee entries parsed (markup changed?)');
	const file: CacheFile = { fetchedAt: Date.now(), fees };
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify(file));
	return file;
}

/** Same refresh policy as trade.ts: stale cache is kept on failure, empty map when there is no cache at all. */
export async function loadGoldFees(fetchImpl: typeof fetch = fetch): Promise<GoldFeeMap> {
	if (Date.now() < nextRefreshAt) return cached?.fees ?? {};
	if (!cached) {
		try { cached = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile; } catch { /* no cache yet */ }
	}
	if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
		nextRefreshAt = cached.fetchedAt + TTL_MS;
		return cached.fees;
	}
	try {
		cached = await download(fetchImpl);
		nextRefreshAt = cached.fetchedAt + TTL_MS;
	} catch (e) {
		console.warn(`gold: refresh failed (${(e as Error).message}); ${cached ? 'using stale cache' : 'no gold fees'}`);
		nextRefreshAt = Date.now() + RETRY_MS;
	}
	return cached?.fees ?? {};
}
