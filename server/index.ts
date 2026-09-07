// Local API + static server. No framework: node:http only.
//   GET /api/loops?league=Forbidden%20Rites&hours=1&hubs=ex,div
//   GET /api/reference?league=…&hours=1&hubs=ex,div&loops=Metadata/…|ex|div,…   (≤5 loops, trade-site listings)
//   GET /api/leagues
//   everything else → dist/ (built by `vite build`)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildBook, findLoops, goldPerHubFromEx, loopKey, scoreRecurrence } from './arb.js';
import { fetchWindow } from './ggg.js';
import { loadGoldFees } from './gold.js';
import { loadTradeStatic } from './trade.js';
import { loadNames, makeResolver } from './names.js';
import { loadWikiIcons } from './wiki.js';
import { fetchReference, type LoopRequest } from './exchange.js';
import { HUB_IDS, type Hub, type LoopsResponse, type ReferenceResponse } from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 8765);
const DIST = path.resolve(process.cwd(), 'dist');
const DEFAULT_LEAGUE = process.env.POE2ARB_LEAGUE ?? 'Forbidden Rites';
/** gold you would pay for 1 Exalted Orb (unset → fees shown in gold only, no fee-adjusted profit) */
const GOLD_PER_EX = Number(process.env.POE2ARB_GOLD_PER_EX ?? 0) || 0;
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
	const [names, trade, goldFees, win] = await Promise.all([loadNames(), loadTradeStatic(), loadGoldFees(), fetchWindow(league, hours)]);
	// Items the trade site has no entry for at all fall back to the community wiki, looked up by name.
	const unlisted = new Set<string>();
	for (const m of win.markets) {
		for (const id of m.market_pair) {
			const e = names[id];
			if (e && !(e.art && trade.icons[e.art])) unlisted.add(e.name);
		}
	}
	const wiki = await loadWikiIcons([...unlisted]);
	const resolve = makeResolver(names, (art) => trade.icons[art], (name) => trade.ja[name], (name) => wiki[name]);
	const book = buildBook(win.markets);
	const goldPerHub = GOLD_PER_EX > 0 ? goldPerHubFromEx(GOLD_PER_EX, book.hubRates) : {};
	const gold = { feeOf: (id: string) => { const n = names[id]?.name; return n === undefined ? undefined : goldFees[n]; }, goldPerHub };
	const { loops, skipped } = findLoops(book, hubs[0], hubs[1], resolve, gold);
	// Recurrence: recompute loops per hour bucket (same cached data, no extra fetches) and count profitable hours.
	const hourly = win.byBucket.map((h) => findLoops(buildBook(h.markets), hubs[0], hubs[1], resolve).loops);
	const recurrence = scoreRecurrence(hourly);
	for (const l of loops) {
		l.recurrence = recurrence.get(loopKey(l)) ?? { hoursProfitable: 0, hoursTotal: hourly.length, medianProfit: null };
	}
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
		goldPerHub,
		loops,
		skipped,
	};
}

export const MAX_REFERENCE_LOOPS = 5;

/** Trade-site listing prices for loops given as `loopKey` values of the current /api/loops result. */
export async function reference(league: string, hours: number, hubs: [Hub, Hub], keys: string[]): Promise<ReferenceResponse> {
	const [names, trade, loopsRes] = await Promise.all([loadNames(), loadTradeStatic(), loops(league, hours, hubs)]);
	const tradeId = (metaId: string): string | undefined => {
		const name = names[metaId]?.name;
		return name ? trade.tradeIds[name] : undefined;
	};
	const reqs: LoopRequest[] = [];
	const errors: string[] = [];
	for (const key of keys) {
		const l = loopsRes.loops.find((x) => loopKey(x) === key);
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
				return json(res, 400, { error: `loops must list 1〜${MAX_REFERENCE_LOOPS} loop keys` });
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
