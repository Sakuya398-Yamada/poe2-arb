import { describe, expect, it } from 'vitest';
import { artOfImageUrl, buildIconMap, buildJaNameMap, mergeStatic, buildTradeIdMap } from '../server/trade.js';
import { makeResolver } from '../server/names.js';

// Real entry from https://www.pathofexile.com/api/trade2/data/static (2026-09-07). The base64 segment decodes to
// [25,14,{"f":"2DItems/Currency/CurrencyAddModToRare","scale":1,"realm":"poe2"}]
const EX_IMAGE = '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQ3VycmVuY3kvQ3VycmVuY3lBZGRNb2RUb1JhcmUiLCJzY2FsZSI6MSwicmVhbG0iOiJwb2UyIn1d/ad7c366789/CurrencyAddModToRare.png';
const EX_ART = 'Art/2DItems/Currency/CurrencyAddModToRare.dds';

describe('artOfImageUrl', () => {
	it('decodes the art path embedded in a signed trade-site image URL', () => {
		expect(artOfImageUrl(EX_IMAGE)).toBe(EX_ART);
	});
	it('returns undefined for URLs it cannot parse', () => {
		expect(artOfImageUrl('/image/Art/2DItems/Currency/CurrencyAddModToRare.png')).toBeUndefined();
		expect(artOfImageUrl('/gen/image/!!!/x/y.png')).toBeUndefined();
		expect(artOfImageUrl('/gen/image/' + Buffer.from('{"not":"an array"}').toString('base64') + '/x/y.png')).toBeUndefined();
	});
});

describe('buildIconMap', () => {
	it('keys absolute poecdn URLs by art path and skips entries without an image', () => {
		const map = buildIconMap({
			result: [
				{ id: 'Currency', entries: [{ id: 'exalted', text: 'Exalted Orb', image: EX_IMAGE }, { id: 'nothing', text: 'No Icon' }] },
				{ id: 'Misc', entries: [] },
			],
		});
		expect(map).toEqual({ [EX_ART]: 'https://web.poecdn.com' + EX_IMAGE });
	});
});

describe('buildJaNameMap', () => {
	// Real entries (2026-09-07): EN and JP static data share ids; only `text` differs.
	const en = { result: [{ id: 'Currency', entries: [
		{ id: 'exalted', text: 'Exalted Orb', image: EX_IMAGE },
		{ id: 'transmute', text: 'Orb of Transmutation' },
		{ id: 'greater-orb-of-transmutation', text: 'Greater Orb of Transmutation' },
		{ id: 'only-en', text: 'Only In EN' },
		{ id: 'empty', text: 'Empty In JP' },
	] }] };
	const jp = { result: [{ id: 'Currency', entries: [
		{ id: 'exalted', text: '高貴なオーブ', image: EX_IMAGE },
		{ id: 'transmute', text: '変成のオーブ' },
		{ id: 'greater-orb-of-transmutation', text: '変成のオーブ (上級)' },
		{ id: 'empty', text: '' },
	] }] };
	it('joins EN and JP entries on id and keys by the English text, skipping ids missing or empty in JP', () => {
		expect(buildJaNameMap(en, jp)).toEqual({
			'Exalted Orb': '高貴なオーブ',
			'Orb of Transmutation': '変成のオーブ',
			'Greater Orb of Transmutation': '変成のオーブ (上級)',
		});
	});
	it('keeps the first JP text when an English text repeats', () => {
		const en2 = { result: [{ id: 'A', entries: [{ id: 'x', text: 'Same' }, { id: 'y', text: 'Same' }] }] };
		const jp2 = { result: [{ id: 'A', entries: [{ id: 'x', text: '一' }, { id: 'y', text: '二' }] }] };
		expect(buildJaNameMap(en2, jp2)).toEqual({ Same: '一' });
	});
	it('returns an empty map when either side has no entries', () => {
		expect(buildJaNameMap(en, {})).toEqual({});
		expect(buildJaNameMap({}, jp)).toEqual({});
	});
});

describe('mergeStatic', () => {
	const en = { result: [{ id: 'Currency', entries: [{ id: 'exalted', text: 'Exalted Orb', image: EX_IMAGE }] }] };
	const jp = { result: [{ id: 'Currency', entries: [{ id: 'exalted', text: '高貴なオーブ' }] }] };
	const icons = { [EX_ART]: 'https://web.poecdn.com' + EX_IMAGE };
	const tradeIds = { 'Exalted Orb': 'exalted' };
	it('builds both maps when JP succeeded', () => {
		expect(mergeStatic(en, { status: 'fulfilled', value: jp }, null)).toEqual({ icons, tradeIds, ja: { 'Exalted Orb': '高貴なオーブ' }, jaStale: false });
	});
	it('keeps the previous Japanese names, flagged stale, when JP failed', () => {
		const previous = { icons: {}, tradeIds: {}, ja: { 'Exalted Orb': '前回' }, jaStale: false };
		expect(mergeStatic(en, { status: 'rejected', reason: new Error('HTTP 503') }, previous)).toEqual({ icons, tradeIds, ja: { 'Exalted Orb': '前回' }, jaStale: true });
	});
	it('falls back to no Japanese names when JP failed and there is no previous cache', () => {
		expect(mergeStatic(en, { status: 'rejected', reason: new Error('HTTP 503') }, null)).toEqual({ icons, tradeIds, ja: {}, jaStale: true });
	});
	it('builds trade ids from the EN data regardless of the JP result', () => {
		expect(mergeStatic(en, { status: 'rejected', reason: new Error('HTTP 503') }, null).tradeIds).toEqual(tradeIds);
	});
});

describe('makeResolver + icons', () => {
	const names = {
		'Metadata/Items/Currency/CurrencyAddModToRare': { name: 'Exalted Orb', category: 'Currency', art: EX_ART },
		'Metadata/Items/Currency/NoArt': { name: 'No Art', category: 'Currency' },
	};
	it('attaches the icon when the art path is known', () => {
		const resolve = makeResolver(names, (art) => (art === EX_ART ? 'https://cdn/ex.png' : undefined));
		expect(resolve('Metadata/Items/Currency/CurrencyAddModToRare')).toEqual({ name: 'Exalted Orb', category: 'Currency', art: EX_ART, icon: 'https://cdn/ex.png' });
	});
	it('omits icon for unknown art, missing art, and unknown ids', () => {
		const resolve = makeResolver(names, () => undefined);
		expect(resolve('Metadata/Items/Currency/CurrencyAddModToRare').icon).toBeUndefined();
		expect(resolve('Metadata/Items/Currency/NoArt').icon).toBeUndefined();
		expect(resolve('Metadata/Items/Currency/Unknown')).toEqual({ name: 'Unknown', category: 'Currency' });
	});
	it('attaches the Japanese name by English name and omits it when unknown', () => {
		const resolve = makeResolver(names, () => undefined, (name) => (name === 'Exalted Orb' ? '高貴なオーブ' : undefined));
		expect(resolve('Metadata/Items/Currency/CurrencyAddModToRare')).toEqual({ name: 'Exalted Orb', category: 'Currency', art: EX_ART, ja: '高貴なオーブ' });
		expect(resolve('Metadata/Items/Currency/NoArt')).toEqual({ name: 'No Art', category: 'Currency' });
		expect(resolve('Metadata/Items/Currency/Unknown')).toEqual({ name: 'Unknown', category: 'Currency' });
	});
});

describe('buildTradeIdMap', () => {
	it('keys trade-site ids by display name and skips separators', () => {
		expect(buildTradeIdMap({ result: [{ id: 'Currency', entries: [{ id: 'exalted', text: 'Exalted Orb' }, { id: 'sep', text: '' }, { id: 'divine', text: 'Divine Orb' }] }] }))
			.toEqual({ 'Exalted Orb': 'exalted', 'Divine Orb': 'divine' });
	});
});
