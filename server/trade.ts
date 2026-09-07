// Official trade site static data: item icons and Japanese item names.
//   GET https://www.pathofexile.com/api/trade2/data/static   (EN, ~180 KB, no auth)
//   GET https://jp.pathofexile.com/api/trade2/data/static    (JP, same structure with Japanese `text`)
// Icons: PoE2 art is only served by web.poecdn.com through signed "/gen/image/<params>/<hash>/<name>.png"
// URLs (the old "/image/Art/2DItems/….png" path 404s for PoE2-only art), so we take the signed URLs from
// the EN data. Each image URL embeds the art path (base64 JSON: [25,14,{"f":"2DItems/Currency/…","scale":1,"realm":"poe2"}]),
// so we key the icon map by RePoE's `visual_identity.dds_file` rather than by name.
// Japanese names: EN and JP entries share `id`, so we join on it and key the result by the EN `text`
// (which matches RePoE's `name`). Not by art path: tiered orbs (Transmutation / Greater / Perfect) share one image.
// Both are cached to .cache/trade.json and refreshed once a day (the image hash changes when GGG re-exports art).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_EN = 'https://www.pathofexile.com/api/trade2/data/static';
const URL_JP = 'https://jp.pathofexile.com/api/trade2/data/static';
const CDN = 'https://web.poecdn.com';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'trade.json');
/** Bump when CacheFile gains fields so an old .cache/trade.json is re-downloaded. */
const CACHE_VERSION = 1;
const TTL_MS = 24 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/** art path ("Art/2DItems/….dds") → absolute image URL */
export type IconMap = Record<string, string>;
/** English item name (trade site `text`, same as RePoE `name`) → Japanese item name */
export type JaNameMap = Record<string, string>;
export interface TradeStatic {
	icons: IconMap;
	ja: JaNameMap;
	/** true when the JP download failed and `ja` is carried over from the previous cache (or empty) */
	jaStale: boolean;
}
interface CacheFile extends TradeStatic { v: number; fetchedAt: number }

interface StaticEntry { id: string; text: string; image?: string }
export interface StaticData { result?: { id: string; entries?: StaticEntry[] }[] }

let cached: CacheFile | null = null;
let nextRefreshAt = 0;

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

function* entries(data: StaticData): Generator<StaticEntry> {
	for (const group of data.result ?? []) for (const e of group.entries ?? []) yield e;
}

export function buildIconMap(data: StaticData): IconMap {
	const map: IconMap = {};
	for (const e of entries(data)) {
		if (!e.image) continue;
		const art = artOfImageUrl(e.image);
		if (art && !map[art]) map[art] = e.image.startsWith('/') ? CDN + e.image : e.image;
	}
	return map;
}

/** EN `text` → JP `text`, joined on entry `id`. First occurrence wins; entries with no JP text are skipped. */
export function buildJaNameMap(en: StaticData, jp: StaticData): JaNameMap {
	const jaById = new Map<string, string>();
	for (const e of entries(jp)) if (e.text) jaById.set(e.id, e.text);
	const map: JaNameMap = {};
	for (const e of entries(en)) {
		const ja = jaById.get(e.id);
		if (ja && e.text && !map[e.text]) map[e.text] = ja;
	}
	return map;
}

async function fetchStatic(fetchImpl: typeof fetch, url: string): Promise<StaticData> {
	const res = await fetchImpl(url, { headers: { 'User-Agent': 'poe2-arb/0.1', Accept: 'application/json' } });
	if (!res.ok) throw new Error(`trade2 static (${url}): HTTP ${res.status}`);
	return (await res.json()) as StaticData;
}

/**
 * Combine a fresh EN download with the JP result. A JP failure only costs the Japanese names, which fall back
 * to the previous cache (or none) and are flagged `jaStale` so the loader retries soon instead of after the TTL.
 * Pure; exported for tests.
 */
export function mergeStatic(en: StaticData, jp: PromiseSettledResult<StaticData>, previous: TradeStatic | null): TradeStatic {
	const icons = buildIconMap(en);
	if (jp.status === 'fulfilled') return { icons, ja: buildJaNameMap(en, jp.value), jaStale: false };
	return { icons, ja: previous?.ja ?? {}, jaStale: true };
}

/** EN data is required (icons); see mergeStatic for the JP failure case. */
async function download(fetchImpl: typeof fetch, previous: CacheFile | null): Promise<CacheFile> {
	const [en, jp] = await Promise.allSettled([fetchStatic(fetchImpl, URL_EN), fetchStatic(fetchImpl, URL_JP)]);
	if (en.status === 'rejected') throw en.reason;
	if (jp.status === 'rejected') console.warn(`trade: jp static failed (${(jp.reason as Error).message}); ${previous ? 'keeping previous Japanese names' : 'no Japanese names'}`);
	const file: CacheFile = { v: CACHE_VERSION, fetchedAt: Date.now(), ...mergeStatic(en.value, jp, previous) };
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify(file));
	return file;
}

const EMPTY: TradeStatic = { icons: {}, ja: {}, jaStale: false };

/**
 * Icon and Japanese-name maps, refreshed at most once per TTL. Never throws: on a failed refresh the stale
 * cache is kept (and retried after RETRY_MS, not on every request); with no cache at all empty maps are
 * returned, so the UI just shows English names without icons. A cache whose JP half is stale is also
 * retried after RETRY_MS rather than waiting out the TTL.
 */
export async function loadTradeStatic(fetchImpl: typeof fetch = fetch): Promise<TradeStatic> {
	if (Date.now() < nextRefreshAt) return cached ?? EMPTY;
	if (!cached) {
		try {
			const c = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile;
			if (c.v === CACHE_VERSION) cached = c;
		} catch { /* no cache yet */ }
	}
	if (cached && !cached.jaStale && Date.now() - cached.fetchedAt < TTL_MS) {
		nextRefreshAt = cached.fetchedAt + TTL_MS;
		return cached;
	}
	try {
		cached = await download(fetchImpl, cached);
		nextRefreshAt = cached.jaStale ? Date.now() + RETRY_MS : cached.fetchedAt + TTL_MS;
	} catch (e) {
		console.warn(`trade: refresh failed (${(e as Error).message}); ${cached ? 'using stale cache' : 'no icons / Japanese names'}`);
		nextRefreshAt = Date.now() + RETRY_MS;
	}
	return cached ?? EMPTY;
}
