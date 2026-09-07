import { describe, expect, it } from 'vitest';
import { fileTitle, nameOfFileTitle, parseImageInfo } from '../server/wiki.js';
import { makeResolver } from '../server/names.js';

describe('fileTitle / nameOfFileTitle', () => {
	it('round-trips an item name through the wiki file title', () => {
		expect(fileTitle('Panther Idol')).toBe('File:Panther Idol inventory icon.png');
		expect(nameOfFileTitle('File:Panther Idol inventory icon.png')).toBe('Panther Idol');
	});
	it("keeps apostrophes and reads back the underscored form MediaWiki echoes", () => {
		expect(fileTitle("Helbrym's Hide")).toBe("File:Helbrym's Hide inventory icon.png");
		expect(nameOfFileTitle("File:Helbrym's_Hide_inventory_icon.png")).toBe("Helbrym's Hide");
	});
	it('returns undefined for titles that are not an inventory icon', () => {
		expect(nameOfFileTitle('File:Panther Idol.png')).toBeUndefined();
		expect(nameOfFileTitle('Panther Idol')).toBeUndefined();
	});
});

describe('parseImageInfo', () => {
	// Shape of https://www.poe2wiki.net/w/api.php?action=query&formatversion=2&prop=imageinfo&iiprop=url (2026-09-07)
	it('maps found pages to their URL and missing pages to null', () => {
		expect(parseImageInfo({
			query: {
				pages: [
					{ title: 'File:Panther Idol inventory icon.png', imageinfo: [{ url: 'https://www.poe2wiki.net/images/7/71/Panther_Idol_inventory_icon.png' }] },
					{ title: 'File:Not An Item inventory icon.png', missing: true },
					{ title: 'File:No Url inventory icon.png', imageinfo: [{}] },
				],
			},
		})).toEqual({
			'Panther Idol': 'https://www.poe2wiki.net/images/7/71/Panther_Idol_inventory_icon.png',
			'Not An Item': null,
			'No Url': null,
		});
	});
	it('ignores unparseable titles and an empty response', () => {
		expect(parseImageInfo({ query: { pages: [{ title: 'File:Something else.png', imageinfo: [{ url: 'x' }] }] } })).toEqual({});
		expect(parseImageInfo({})).toEqual({});
	});
});

describe('makeResolver + wiki fallback', () => {
	const ART = 'Art/2DItems/Currency/CurrencyAddModToRare.dds';
	const names = {
		'Metadata/Items/Currency/CurrencyAddModToRare': { name: 'Exalted Orb', category: 'Currency', art: ART },
		'Metadata/Items/SoulCores/IdolPanther': { name: 'Panther Idol', category: 'Soul Core', art: 'Art/2DItems/Currency/TormentedSpiritSocketables/AzmeriSocketablePanther.dds' },
	};
	const wiki = (name: string) => (name === 'Panther Idol' ? 'https://www.poe2wiki.net/images/7/71/Panther_Idol_inventory_icon.png' : undefined);

	it('uses the wiki icon when the art path is not in the trade static data', () => {
		const resolve = makeResolver(names, (art) => (art === ART ? 'https://cdn/ex.png' : undefined), wiki);
		expect(resolve('Metadata/Items/SoulCores/IdolPanther').icon).toBe('https://www.poe2wiki.net/images/7/71/Panther_Idol_inventory_icon.png');
	});
	it('prefers the trade-site icon over the wiki one', () => {
		const resolve = makeResolver(names, () => 'https://cdn/ex.png', () => 'https://wiki/other.png');
		expect(resolve('Metadata/Items/Currency/CurrencyAddModToRare').icon).toBe('https://cdn/ex.png');
	});
	it('leaves the icon unset when neither source has one', () => {
		const resolve = makeResolver(names, () => undefined, () => undefined);
		expect(resolve('Metadata/Items/SoulCores/IdolPanther').icon).toBeUndefined();
	});
});
