// Local API + static server. No framework: node:http only.
//   GET /api/loops?league=Forbidden%20Rites&hours=1&hubs=ex,div
//   GET /api/reference?league=…&hours=1&hubs=ex,div&loops=ex>Metadata/…>div,…   (≤5 loops, trade-site listings)
//   GET /api/leagues
//   everything else → dist/ (built by `vite build`)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildBook, findLoops } from './arb.js';
import { fetchWindow } from './ggg.js';
import { loadIcons, loadStatic } from './icons.js';
import { loadNames, makeResolver } from './names.js';
import { fetchReference, type LoopRequest } from './exchange.js';
import { HUB_IDS, type Hub, type LoopsResponse, type ReferenceResponse } from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 8765);
const DIST = path.resolve(process.cwd(), 'dist');
const DEFAULT_LEAGUE = process.env.POE2ARB_LEAGUE ?? 'Forbidden Rites';
const HUBS: Hub[] = ['ex', 'div', 'chaos'];

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(res: http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(body));
}

export async function loops(league: string, hours: number, hubs: [Hub, Hub]): Promise<LoopsResponse> {
	const [names, icons, win] = await Promise.all([loadNames(), loadIcons(), fetchWindow(league, hours)]);
	const resolve = makeResolver(names, (art) => icons[art]);
	const book = buildBook(win.markets);
	const { loops, skipped } = findLoops(book, hubs[0], hubs[1], resolve);
	const hubIcons: LoopsResponse['hubIcons'] = {};
	for (const h of HUBS) { const icon = resolve(HUB_IDS[h]).icon; if (icon) hubIcons[h] = icon; }
	loops.sort((a, b) => b.profit.vwap - a.profit.vwap);
	const r = book.hubRates.get(`${hubs[0]}|${hubs[1]}`);
	return {
		league,
		windowStart: win.buckets[0],
		windowEnd: win.buckets[win.buckets.length - 1] + 3600,
		hoursRequested: hours,
		hoursUsed: win.buckets.length,
		generatedAt: Math.floor(Date.now() / 1000),
		hubs,
		hubRate: r ? { worst: r.price.lo, best: r.price.hi, vwap: r.vwap } : null,
		hubIcons,
		loops,
		skipped,
	};
}

export const MAX_REFERENCE_LOOPS = 5;

/** Trade-site reference prices for loops given as "from>itemId>to" keys of the current /api/loops result. */
export async function reference(league: string, hours: number, hubs: [Hub, Hub], keys: string[]): Promise<ReferenceResponse> {
	const [names, statics, loopsRes] = await Promise.all([loadNames(), loadStatic(), loops(league, hours, hubs)]);
	const tradeId = (metaId: string): string | undefined => {
		const name = names[metaId]?.name;
		return name ? statics.tradeIds[name] : undefined;
	};
	const reqs: LoopRequest[] = [];
	const errors: string[] = [];
	for (const key of keys) {
		const l = loopsRes.loops.find((x) => `${x.from}>${x.itemId}>${x.to}` === key);
		if (!l) { errors.push(`unknown loop: ${key}`); continue; }
		reqs.push({
			itemId: l.itemId, from: l.from, to: l.to,
			item: tradeId(l.itemId), fromId: tradeId(HUB_IDS[l.from]), toId: tradeId(HUB_IDS[l.to]),
			buyVwap: l.buy.vwap, sellVwap: l.sell.vwap, convertVwap: l.convert.vwap,
		});
	}
	const r = await fetchReference(league, reqs);
	return { league, fetchedAt: Math.floor(Date.now() / 1000), requests: r.requests, loops: r.loops, errors: [...errors, ...r.errors] };
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
	const url = new URL(req.url ?? '/', 'http://x');
	let file = path.join(DIST, decodeURIComponent(url.pathname));
	if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
	try {
		if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
	} catch {
		file = path.join(DIST, 'index.html'); // SPA fallback
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('dist/ not found — run `npm run build` first (or use `npm run dev`).');
	}
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	try {
		if (url.pathname === '/api/loops' || url.pathname === '/api/reference') {
			const league = url.searchParams.get('league') ?? DEFAULT_LEAGUE;
			const hours = Math.min(24, Math.max(1, Number(url.searchParams.get('hours') ?? 1) || 1));
			const hubs = (url.searchParams.get('hubs') ?? 'ex,div').split(',') as Hub[];
			if (hubs.length !== 2 || !hubs.every((h) => HUBS.includes(h)) || hubs[0] === hubs[1]) {
				return json(res, 400, { error: 'hubs must be two distinct of ex,div,chaos' });
			}
			if (url.pathname === '/api/loops') return json(res, 200, await loops(league, hours, hubs as [Hub, Hub]));
			const keys = (url.searchParams.get('loops') ?? '').split(',').filter(Boolean);
			if (keys.length === 0 || keys.length > MAX_REFERENCE_LOOPS) {
				return json(res, 400, { error: `loops must list 1〜${MAX_REFERENCE_LOOPS} "from>itemId>to" keys` });
			}
			return json(res, 200, await reference(league, hours, hubs as [Hub, Hub], keys));
		}
		if (url.pathname === '/api/leagues') {
			const win = await fetchWindow(DEFAULT_LEAGUE, 1);
			return json(res, 200, { leagues: win.leagues, default: DEFAULT_LEAGUE });
		}
		if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
		await serveStatic(req, res);
	} catch (e) {
		console.error(e);
		json(res, 502, { error: (e as Error).message });
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`poe2-arb listening on http://localhost:${PORT}  (league: ${DEFAULT_LEAGUE})`);
});
