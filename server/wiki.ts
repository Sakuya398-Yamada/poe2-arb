// Fallback icons for items the official trade static data doesn't list (2026-09-07: the two Triskelion
// expedition keys, Raven's Reflection, the Panther/Hawk/Stoat idols and two lineage support gems).
// Those have no trade-site entry at all, and the legacy web.poecdn.com/image/Art/… path 404s for them,
// so the signed URL is unobtainable. The community wiki hosts its own copy of every inventory icon under
// the fixed page title "File:<item name> inventory icon.png", which one MediaWiki imageinfo query
// resolves to a real image URL. Keyed by display name (RePoE metadata ids disagree with the wiki's for
// some items). Cached to .cache/wiki-icons.json, misses included so a name isn't re-queried every hour.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.poe2wiki.net/w/api.php';
const UA = process.env.POE2ARB_UA ?? 'poe2-arb/0.1 (personal currency-exchange viewer)';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'wiki-icons.json');
/** Bump when the cache shape changes so an old .cache/wiki-icons.json is discarded. */
const CACHE_VERSION = 1;
const BATCH = 50; // MediaWiki caps `titles` at 50 per request for anonymous callers
const MISS_TTL_MS = 7 * 24 * 3600 * 1000; // re-ask for a name the wiki didn't have, but only weekly
const RETRY_MS = 10 * 60 * 1000;

/** Wiki page holding an item's inventory icon. */
export function fileTitle(name: string): string {
	return `File:${name} inventory icon.png`;
}

/** Inverse of fileTitle. MediaWiki echoes titles with "_" for spaces; no PoE2 item name contains "_". */
export function nameOfFileTitle(title: string): string | undefined {
	const m = /^File:(.+) inventory icon\.png$/.exec(title.replace(/_/g, ' '));
	return m ? m[1] : undefined;
}

interface ImageInfoResponse {
	query?: { pages?: { title?: string; missing?: boolean; imageinfo?: { url?: string }[] }[] };
}

/** name → image URL, or null when the wiki has no icon under the expected title. Exported for tests. */
export function parseImageInfo(body: ImageInfoResponse): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const p of body.query?.pages ?? []) {
		const name = p.title ? nameOfFileTitle(p.title) : undefined;
		if (!name) continue;
		const url = p.missing ? undefined : p.imageinfo?.[0]?.url;
		out[name] = url ?? null;
	}
	return out;
}

interface Entry { url: string | null; at: number }
interface CacheFile { v: number; icons: Record<string, Entry> }

let cached: CacheFile | null = null;
let nextRetryAt = 0;

async function queryBatch(names: string[], fetchImpl: typeof fetch): Promise<Record<string, string | null>> {
	const titles = encodeURIComponent(names.map(fileTitle).join('|'));
	const url = `${API}?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url&titles=${titles}`;
	const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
	if (!res.ok) throw new Error(`poe2wiki imageinfo: HTTP ${res.status}`);
	return parseImageInfo((await res.json()) as ImageInfoResponse);
}

/**
 * Icon URLs for `names`, looking up only the ones not already cached. Never throws: on a failed lookup
 * the affected items just stay without an icon (and the wiki isn't re-asked for RETRY_MS).
 */
export async function loadWikiIcons(names: string[], fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
	if (!cached) {
		try {
			const c = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile;
			cached = c.v === CACHE_VERSION && c.icons ? c : { v: CACHE_VERSION, icons: {} };
		} catch { cached = { v: CACHE_VERSION, icons: {} }; }
	}
	const store = cached;
	const now = Date.now();
	const want = [...new Set(names)].filter((n) => n.length > 0);
	const missing = want.filter((n) => {
		const e = store.icons[n];
		return !e || (e.url === null && now - e.at > MISS_TTL_MS);
	});

	if (missing.length > 0 && now >= nextRetryAt) {
		try {
			for (let i = 0; i < missing.length; i += BATCH) {
				const batch = missing.slice(i, i + BATCH);
				const found = await queryBatch(batch, fetchImpl);
				for (const n of batch) store.icons[n] = { url: found[n] ?? null, at: now };
			}
			await mkdir(CACHE_DIR, { recursive: true });
			await writeFile(CACHE_FILE, JSON.stringify(store));
		} catch (e) {
			console.warn(`wiki icons: lookup failed (${(e as Error).message}); those items stay without an icon`);
			nextRetryAt = now + RETRY_MS;
		}
	}

	const out: Record<string, string> = {};
	for (const n of want) {
		const url = store.icons[n]?.url;
		if (url) out[n] = url;
	}
	return out;
}
