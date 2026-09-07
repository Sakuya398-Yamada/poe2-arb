import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNameLoader, makeResolver, parseBaseItems } from '../server/names.js';

const EX_ID = 'Metadata/Items/Currency/CurrencyAddModToRare';
const RAW = {
	[EX_ID]: { name: 'Exalted Orb', item_class: 'StackableCurrency', visual_identity: { dds_file: 'Art/2DItems/Currency/CurrencyAddModToRare.dds' } },
	'Metadata/Items/Currency/Nameless': { item_class: 'StackableCurrency' },
};

function okResponse(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as Response;
}

async function seedFile(file: string): Promise<void> {
	await writeFile(file, 'not a directory');
}

describe('parseBaseItems', () => {
	it('keeps name/category/art and skips entries without a name', () => {
		expect(parseBaseItems(RAW)).toEqual({
			[EX_ID]: { name: 'Exalted Orb', category: 'Currency', art: 'Art/2DItems/Currency/CurrencyAddModToRare.dds' },
		});
	});
});

describe('createNameLoader', () => {
	let dir: string;
	let cacheFile: string;
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), 'poe2-arb-names-'));
		cacheFile = path.join(dir, 'names.json');
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(async () => {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
	});

	it('returns an empty map instead of throwing when there is no cache and the fetch rejects', async () => {
		const load = createNameLoader({ cacheFile });
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ENOTFOUND'));
		await expect(load(fetchImpl)).resolves.toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(makeResolver({})(EX_ID)).toEqual({ name: 'CurrencyAddModToRare', category: 'Currency' });
	});

	it('treats a non-2xx response as a failure', async () => {
		const load = createNameLoader({ cacheFile });
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ ok: false, status: 503 } as Response);
		await expect(load(fetchImpl)).resolves.toEqual({});
		expect(warn.mock.calls[0]?.[0]).toContain('HTTP 503');
	});

	it('does not hit RePoE again until RETRY_MS has passed, then recovers and writes the cache', async () => {
		let t = 1_000_000;
		const load = createNameLoader({ cacheFile, now: () => t });
		const fetchImpl = vi.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue(okResponse(RAW));

		await expect(load(fetchImpl)).resolves.toEqual({});
		t += 60 * 1000;
		await expect(load(fetchImpl)).resolves.toEqual({});
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		t += 10 * 60 * 1000;
		const names = await load(fetchImpl);
		expect(names[EX_ID]?.name).toBe('Exalted Orb');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({ v: 2, items: names });

		await load(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('keeps the downloaded names when the cache file cannot be written', async () => {
		// cacheFile under a path whose parent is a file -> mkdir/writeFile reject
		const load = createNameLoader({ cacheFile: path.join(cacheFile, 'nested', 'names.json') });
		await seedFile(cacheFile);
		const names = await load(vi.fn<typeof fetch>().mockResolvedValue(okResponse(RAW)));
		expect(names[EX_ID]?.name).toBe('Exalted Orb');
		expect(warn.mock.calls[0]?.[0]).toContain('cache write failed');
	});

	it('serves the on-disk cache without fetching', async () => {
		const seed = createNameLoader({ cacheFile });
		await seed(vi.fn<typeof fetch>().mockResolvedValue(okResponse(RAW)));

		const load = createNameLoader({ cacheFile });
		const fetchImpl = vi.fn<typeof fetch>();
		expect((await load(fetchImpl))[EX_ID]?.name).toBe('Exalted Orb');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
