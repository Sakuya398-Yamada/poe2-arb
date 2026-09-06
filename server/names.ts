// Resolves "Metadata/Items/..." ids to display names using RePoE (PoE2 fork).
// https://repoe-fork.github.io/poe2/base_items.json  (~8 MB, cached to .cache/ after first download)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL = 'https://repoe-fork.github.io/poe2/base_items.json';
const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'names.json');
/** Bump when NameEntry gains fields so an old .cache/names.json is re-downloaded. */
const CACHE_VERSION = 2;

export interface NameEntry {
	name: string;
	category: string;
	/** RePoE `visual_identity.dds_file`, e.g. "Art/2DItems/Currency/CurrencyAddModToRare.dds". Used to look up the icon. */
	art?: string;
}
type NameMap = Record<string, NameEntry>;
interface CacheFile { v: number; items: NameMap }

let loaded: NameMap | null = null;

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

export async function loadNames(fetchImpl: typeof fetch = fetch): Promise<NameMap> {
	if (loaded) return loaded;
	try {
		const c = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile;
		if (c.v === CACHE_VERSION && c.items) { loaded = c.items; return loaded; }
	} catch { /* no cache yet */ }

	const res = await fetchImpl(URL, { headers: { 'User-Agent': 'poe2-arb/0.1' } });
	if (!res.ok) throw new Error(`RePoE base_items: HTTP ${res.status}`);
	const raw = (await res.json()) as Record<string, { name?: string; item_class?: string; visual_identity?: { dds_file?: string } }>;
	const map: NameMap = {};
	for (const [id, v] of Object.entries(raw)) {
		if (!v?.name) continue;
		const e: NameEntry = { name: v.name, category: categoryOf(id, v.item_class ?? '') };
		if (v.visual_identity?.dds_file) e.art = v.visual_identity.dds_file;
		map[id] = e;
	}
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, items: map } satisfies CacheFile));
	loaded = map;
	return map;
}

export function makeResolver(map: NameMap, iconFor: (art: string) => string | undefined = () => undefined) {
	return (id: string): NameEntry & { icon?: string } => {
		const e = map[id] ?? { name: id.split('/').pop() ?? id, category: categoryOf(id, '') };
		const icon = e.art ? iconFor(e.art) : undefined;
		return icon ? { ...e, icon } : { ...e };
	};
}
