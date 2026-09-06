import { describe, expect, it } from 'vitest';
import { artOfImageUrl, buildIconMap } from '../server/icons.js';
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
});
