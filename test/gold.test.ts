import { describe, expect, it } from 'vitest';
import { parseGoldFees } from '../server/gold.js';

// Markup as served by https://poe2db.tw/us/Currency_Exchange on 2026-09-07 (attributes trimmed, values real).
const HTML = `
<div class="col"><div class="d-flex border-top rounded"><div class="flex-shrink-0"><a class="item_currency StackableCurrency" href="Exalted_Orb"><img loading="lazy" src="https://cdn.poe2db.tw/image/Art/2DItems/Currency/CurrencyAddModToRare.webp" alt="CurrencyAddModToRare" class="size32 w1" /></a></div><div class="flex-grow-1 ms-2 d-flex justify-content-between align-items-center"><a class="item_currency StackableCurrency" data-hover="https://cdn.poe2db.tw/cache2/us/x" href="Exalted_Orb">Exalted Orb</a><span>120</span></div></div></div>
<div class="col"><div class="d-flex border-top rounded"><div class="flex-grow-1"><a class="item_currency StackableCurrency" href="Greater_Exalted_Orb">Greater Exalted Orb</a><span>360</span></div></div></div>
<div class="col"><a class="item_currency StackableCurrency" href="Divine_Orb">Divine Orb</a><span>800</span></div>
<div class="col"><a class="item_currency StackableCurrency" href="X">Alchemist&#39;s Essence</a><span>1</span></div>
<div class="col"><a class="whiteitem SoulCore" data-hover="https://cdn.poe2db.tw/cache2/us/y" href="Rune_of_Alacrity">Rune of Alacrity</a><span>4</span></div>
<div class="col"><a class="gem_red" href="Uncut_Skill_Gem">Uncut Skill Gem</a><span>100</span></div>
<a class="item_currency" href="Exalted_Orb">Exalted Orb</a><span>999</span>
`;

describe('parseGoldFees', () => {
	it('maps item name → gold fee for every item type, keeping the first occurrence', () => {
		const fees = parseGoldFees(HTML);
		expect(fees['Exalted Orb']).toBe(120);
		expect(fees['Greater Exalted Orb']).toBe(360);
		expect(fees['Divine Orb']).toBe(800);
		expect(fees['Rune of Alacrity']).toBe(4);
		expect(fees['Uncut Skill Gem']).toBe(100);
		expect(Object.keys(fees)).toHaveLength(6);
	});
	it('decodes HTML entities in names', () => {
		expect(parseGoldFees(HTML)["Alchemist's Essence"]).toBe(1);
	});
	it('returns an empty map for unexpected markup', () => {
		expect(parseGoldFees('<html><body>Access Denied</body></html>')).toEqual({});
	});
});
