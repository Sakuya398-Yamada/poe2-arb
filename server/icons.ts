// Item icons. PoE2 art is only served by web.poecdn.com through signed "/gen/image/<params>/<hash>/<name>.png"
// URLs (the old "/image/Art/2DItems/….png" path 404s for PoE2-only art), so we take the signed URLs from the
// official trade site's static data, which lists most exchange-able items with their image:
//   GET https://www.pathofexile.com/api/trade2/data/static   (~180 KB, no auth)
// Each image URL embeds the art path (base64 JSON: [25,14,{"f":"2DItems/Currency/…","scale":1,"realm":"poe2"}]),
// so we key the map by RePoE's `visual_identity.dds_file` rather than by name. Cached to .cache/icons.json
// and refreshed once a day (the hash changes when GGG re-exports art; stale URLs would 404).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://www.pathofexile.com/api/trade2/data/static';
const CDN = 'https://web.poecdn.com';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'icons.json');
const TTL_MS = 24 * 3600 * 1000;

/** art path ("Art/2DItems/….dds") → absolute image URL */
export type IconMap = Record<string, string>;
interface CacheFile { fetchedAt: number; icons: IconMap }

interface StaticData { result?: { id: string; entries?: { id: string; text: string; image?: string }[] }[] }

let cached: CacheFile | null = null;
let nextRefreshAt = 0;
const RETRY_MS = 10 * 60 * 1000;

/** Art path encoded in a trade-site image URL, normalised to RePoE's dds form. Exported for tests. */
export function artOfImageUrl(image: string): string | undefined {
	const m = /\/gen\/image\/([A-Za-z0-9_-]+=*)\//.exec(image);
	if (!m) return undefined;
	try {
		const params = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as unknown;
		const f = Array.isArray(params) ? (params[2] as { f?: unknown } | undefined)?.f : undefined;
		return typeof f === 'string' && f ? `Art/${f}.dds` : undefined;
	} catch {
		return undefined;
	}
}

export function buildIconMap(data: StaticData): IconMap {
	const map: IconMap = {};
	for (const group of data.result ?? []) {
		for (const e of group.entries ?? []) {
			if (!e.image) continue;
			const art = artOfImageUrl(e.image);
			if (art && !map[art]) map[art] = e.image.startsWith('/') ? CDN + e.image : e.image;
		}
	}
	return map;
}

async function download(fetchImpl: typeof fetch): Promise<CacheFile> {
	const res = await fetchImpl(URL, { headers: { 'User-Agent': 'poe2-arb/0.1', Accept: 'application/json' } });
	if (!res.ok) throw new Error(`trade2 static: HTTP ${res.status}`);
	const file: CacheFile = { fetchedAt: Date.now(), icons: buildIconMap((await res.json()) as StaticData) };
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify(file));
	return file;
}

/**
 * Icon map, refreshed at most once per TTL. Never throws: on a failed refresh the stale cache is kept
 * (and retried after RETRY_MS, not on every request); with no cache at all an empty map is returned,
 * so the UI just shows names without icons.
 */
export async function loadIcons(fetchImpl: typeof fetch = fetch): Promise<IconMap> {
	if (Date.now() < nextRefreshAt) return cached?.icons ?? {};
	if (!cached) {
		try { cached = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile; } catch { /* no cache yet */ }
	}
	if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
		nextRefreshAt = cached.fetchedAt + TTL_MS;
		return cached.icons;
	}
	try {
		cached = await download(fetchImpl);
		nextRefreshAt = cached.fetchedAt + TTL_MS;
	} catch (e) {
		console.warn(`icons: refresh failed (${(e as Error).message}); ${cached ? 'using stale cache' : 'no icons'}`);
		nextRefreshAt = Date.now() + RETRY_MS;
	}
	return cached?.icons ?? {};
}
