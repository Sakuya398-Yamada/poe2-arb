// Resolves "Metadata/Items/..." ids to display names using RePoE (PoE2 fork).
// https://repoe-fork.github.io/poe2/base_items.json  (~8 MB, cached to .cache/ after first download)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://repoe-fork.github.io/poe2/base_items.json';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
/** Bump when NameEntry gains fields so an old .cache/names.json is re-downloaded. */
const CACHE_VERSION = 2;

export interface NameEntry {
	name: string;
	category: string;
	/** RePoE `visual_identity.dds_file`, e.g. "Art/2DItems/Currency/CurrencyAddModToRare.dds". Used to look up the icon. */
	art?: string;
}
export type NameMap = Record<string, NameEntry>;
interface CacheFile { v: number; items: NameMap }
type RawBaseItems = Record<string, { name?: string; item_class?: string; visual_identity?: { dds_file?: string } }>;

const RETRY_MS = 10 * 60 * 1000;

/** Human-ish category from the metadata path + RePoE item_class. */
function categoryOf(id: string, itemClass: string): string {
	const seg = id.split('/');
	if (seg[2] === 'Currency') {
		if (seg[3] === 'Abyss' || seg[3] === 'Breach') return seg[3];
		if (/Essence/.test(seg[3])) return 'Essence';
		return 'Currency';
	}
	if (seg[2] === 'SoulCores') return /Rune/.test(seg[3]) ? 'Rune' : 'Soul Core';
	if (seg[2] === 'Gems') return /Uncut/.test(seg[3]) ? 'Uncut Gem' : 'Lineage Gem';
	if (seg[2] === 'MapFragments' || seg[2] === 'Fragments') return 'Fragment';
	if (seg[2] === 'Expedition') return 'Expedition';
	if (seg[2] === 'Idols') return 'Idol';
	return itemClass || seg[2] || 'Other';
}

/** RePoE base_items.json → NameMap (only the fields we display). Exported for tests. */
export function parseBaseItems(raw: RawBaseItems): NameMap {
	const map: NameMap = {};
	for (const [id, v] of Object.entries(raw)) {
		if (!v?.name) continue;
		const e: NameEntry = { name: v.name, category: categoryOf(id, v.item_class ?? '') };
		if (v.visual_identity?.dds_file) e.art = v.visual_identity.dds_file;
		map[id] = e;
	}
	return map;
}

export interface NameLoaderOptions {
	/** Defaults to .cache/names.json under cwd. Tests point this at a temp dir. */
	cacheFile?: string;
	/** Clock, injectable so tests can move past RETRY_MS. */
	now?: () => number;
}

/**
 * Builds a name loader with its own cache state. The returned function never throws: when the cache is
 * missing and RePoE cannot be fetched it warns, returns an empty map (so makeResolver falls back to the
 * id's last path segment) and retries after RETRY_MS, not on every request — same policy as loadTradeStatic.
 */
export function createNameLoader(opts: NameLoaderOptions = {}) {
	const cacheFile = opts.cacheFile ?? path.join(CACHE_DIR, 'names.json');
	const now = opts.now ?? Date.now;
	let loaded: NameMap | null = null;
	let nextRetryAt = 0;

	async function download(fetchImpl: typeof fetch): Promise<NameMap> {
		const res = await fetchImpl(URL, { headers: { 'User-Agent': 'poe2-arb/0.1' } });
		if (!res.ok) throw new Error(`RePoE base_items: HTTP ${res.status}`);
		const map = parseBaseItems((await res.json()) as RawBaseItems);
		// A failed cache write only costs the next start-up a re-download; keep the names we already have.
		try {
			await mkdir(path.dirname(cacheFile), { recursive: true });
			await writeFile(cacheFile, JSON.stringify({ v: CACHE_VERSION, items: map } satisfies CacheFile));
		} catch (e) {
			console.warn(`names: cache write failed (${(e as Error).message}); continuing without cache`);
		}
		return map;
	}

	return async function loadNames(fetchImpl: typeof fetch = fetch): Promise<NameMap> {
		if (loaded) return loaded;
		try {
			const c = JSON.parse(await readFile(cacheFile, 'utf8')) as CacheFile;
			if (c.v === CACHE_VERSION && c.items) { loaded = c.items; return loaded; }
		} catch { /* no cache yet */ }

		if (now() < nextRetryAt) return {};
		try {
			loaded = await download(fetchImpl);
			return loaded;
		} catch (e) {
			console.warn(`names: RePoE fetch failed (${(e as Error).message}); showing ids until retry`);
			nextRetryAt = now() + RETRY_MS;
			return {};
		}
	};
}

export const loadNames = createNameLoader();

/** `jaFor` is keyed by the English name (RePoE `name` == trade-site EN `text`), see trade.ts for why not by art. */
export function makeResolver(
	map: NameMap,
	iconFor: (art: string) => string | undefined = () => undefined,
	jaFor: (name: string) => string | undefined = () => undefined,
) {
	return (id: string): NameEntry & { icon?: string; ja?: string } => {
		const e = map[id] ?? { name: id.split('/').pop() ?? id, category: categoryOf(id, '') };
		const icon = e.art ? iconFor(e.art) : undefined;
		const ja = jaFor(e.name);
		return { ...e, ...(icon ? { icon } : {}), ...(ja ? { ja } : {}) };
	};
}
