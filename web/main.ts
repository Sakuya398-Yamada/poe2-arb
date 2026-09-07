import { HUB_LABEL, type Hub, type Loop, type LoopReference, type LoopsResponse, type ReferenceLeg, type ReferenceResponse } from '../shared/types.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const leagueSel = $<HTMLSelectElement>('#league');
const hubsSel = $<HTMLSelectElement>('#hubs');
const hoursSel = $<HTMLSelectElement>('#hours');
const dirSel = $<HTMLSelectElement>('#dir');
const minProfit = $<HTMLInputElement>('#minProfit');
const minCap = $<HTMLInputElement>('#minCap');
const q = $<HTMLInputElement>('#q');
const status = $<HTMLElement>('#status');
const tbody = $<HTMLTableSectionElement>('#tbl tbody');
const detail = $<HTMLElement>('#detail');
const refBtn = $<HTMLButtonElement>('#ref');
const refStatus = $<HTMLElement>('#refStatus');

type SortKey = 'name' | 'buy' | 'sell' | 'vwap' | 'cons' | 'opt' | 'cap';
let sortKey: SortKey = 'vwap';
let sortDesc = true;
let data: LoopsResponse | null = null;
let selected: string | null = null;
/** trade-site reference prices, keyed by loopKey; only the loops fetched last time */
let ref: ReferenceResponse | null = null;
const refByKey = new Map<string, LoopReference>();
const REF_LOOPS = 5;

const pct = (m: number) => `${m >= 1 ? '+' : ''}${((m - 1) * 100).toFixed(1)}%`;
const cls = (m: number) => (m > 1 ? 'pos' : m < 1 ? 'neg' : '');
const hubName = (h: Hub) => HUB_LABEL[h].ja;
const hubShort = (h: Hub) => HUB_LABEL[h].short;
const fmtTime = (unix: number) => new Date(unix * 1000).toLocaleString('ja-JP', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Show "hub per item" as a readable ratio: 0.0143 div → "70 : 1 div" style, or "12.5 ex". */
function fmtPrice(hubPerItem: number, hub: Hub): string {
	if (hubPerItem >= 0.5) return `${trim(hubPerItem)} ${hubShort(hub)}`;
	return `1/${trim(1 / hubPerItem)} ${hubShort(hub)}`;
}
function trim(n: number): string {
	if (n >= 100) return n.toFixed(0);
	if (n >= 10) return n.toFixed(1);
	return n.toFixed(2).replace(/\.?0+$/, '');
}

function loopKey(l: Loop) { return `${l.from}>${l.itemId}>${l.to}`; }

/**
 * Item / hub icon. Images come straight from web.poecdn.com (signed URLs the server got from the trade site);
 * a missing or broken image degrades to an empty box so rows stay aligned.
 */
function icon(url: string | undefined, title: string, size: 'sm' | 'lg' = 'sm'): string {
	if (!url) return `<span class="icon ${size} none" title="${esc(title)}"></span>`;
	return `<img class="icon ${size}" src="${esc(url)}" alt="" title="${esc(title)}" loading="lazy" decoding="async" onerror="this.classList.add('none');this.removeAttribute('src')">`;
}
const hubIcon = (h: Hub) => icon(data?.hubIcons[h], HUB_LABEL[h].en);
/** "ex → item → div → ex" with icons */
function route(l: Loop): string {
	const hub = (h: Hub) => `<span class="hub">${hubIcon(h)}${hubShort(h)}</span>`;
	return `${hub(l.from)} → <span class="hub">${icon(l.icon, l.name)}item</span> → ${hub(l.to)} → ${hub(l.from)}`;
}

function restore() {
	try {
		const s = JSON.parse(localStorage.getItem('poe2arb') ?? '{}');
		if (s.hubs) hubsSel.value = s.hubs;
		if (s.hours) hoursSel.value = s.hours;
		if (s.dir) dirSel.value = s.dir;
		if (s.minProfit != null) minProfit.value = s.minProfit;
		if (s.minCap != null) minCap.value = s.minCap;
		if (s.league) leagueSel.value = s.league;
	} catch { /* ignore */ }
}
function persist() {
	try {
		localStorage.setItem('poe2arb', JSON.stringify({
			hubs: hubsSel.value, hours: hoursSel.value, dir: dirSel.value,
			minProfit: minProfit.value, minCap: minCap.value, league: leagueSel.value,
		}));
	} catch { /* ignore */ }
}

async function loadLeagues() {
	const r = await fetch('/api/leagues');
	const j = (await r.json()) as { leagues: string[]; default: string };
	leagueSel.innerHTML = '';
	for (const l of j.leagues) {
		const o = document.createElement('option');
		o.value = l; o.textContent = l;
		leagueSel.append(o);
	}
	leagueSel.value = j.default;
}

async function load() {
	persist();
	status.innerHTML = '読み込み中…';
	const p = new URLSearchParams({ league: leagueSel.value, hours: hoursSel.value, hubs: hubsSel.value });
	try {
		const r = await fetch(`/api/loops?${p}`);
		const j = await r.json();
		if (!r.ok) throw new Error(j.error ?? r.statusText);
		data = j as LoopsResponse;
		renderStatus();
		render();
	} catch (e) {
		status.innerHTML = `<span class="err">取得失敗: ${(e as Error).message}</span>`;
	}
}

/** Trade-site listings for the top rows of the current table. One button press = one fetch (server caches 5 min). */
async function loadRef() {
	if (!data) return;
	const keys = filtered().slice(0, REF_LOOPS).map(loopKey);
	if (keys.length === 0) { refStatus.textContent = '表示中のループなし'; return; }
	refBtn.disabled = true;
	refStatus.textContent = '出品相場を取得中…（レート制限に合わせて送るので最大2分ほど）';
	try {
		const p = new URLSearchParams({ league: leagueSel.value, hours: hoursSel.value, hubs: hubsSel.value, loops: keys.join(',') });
		const res = await fetch(`/api/reference?${p}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${((await res.json()) as { error?: string }).error ?? ''}`);
		ref = (await res.json()) as ReferenceResponse;
		refByKey.clear();
		for (const r of ref.loops) refByKey.set(`${r.from}>${r.itemId}>${r.to}`, r);
		const err = ref.errors.length ? ` <span class="err">${esc(ref.errors.join(' / '))}</span>` : '';
		refStatus.innerHTML = `出品相場 ${fmtTime(ref.fetchedAt)} 取得 (${ref.loops.length} ループ, ${ref.requests} リクエスト)${err}`;
	} catch (e) {
		refStatus.innerHTML = `<span class="err">出品相場の取得失敗: ${esc((e as Error).message)}</span>`;
	} finally {
		refBtn.disabled = false;
	}
	render();
	if (selected) { const l = data.loops.find((x) => loopKey(x) === selected); if (l) renderDetail(l); }
}

/** "出品相場" cell: reference profit for fetched loops, a note when a leg is missing, blank otherwise */
function refCell(l: Loop): string {
	const r = refByKey.get(loopKey(l));
	if (!r) return '<td class="num ref"></td>';
	if (r.profit === null) return `<td class="num ref"><span class="k">${esc(r.note ?? '—')}</span></td>`;
	return `<td class="num ref ${cls(r.profit)}"><b>${pct(r.profit)}</b> <span class="rng">在庫 ${Math.min(r.buy!.stock, r.sell!.stock)} 個</span></td>`;
}

function refLeg(leg: ReferenceLeg | null, fmt: (price: number) => string): string {
	if (!leg) return '<span class="k">出品なし</span>';
	if (!leg.inBand) return `<code class="neg">${fmt(leg.price)}</code> <span class="k">(出品 ${leg.listed} 件すべて VWAP の 1/3〜3倍の外。約定VWAPと乖離)</span>`;
	return `<code>${fmt(leg.price)}</code> <span class="k">(在庫 ${leg.stock}, 出品 ${leg.offers}${leg.listed > leg.offers ? ` / 外れ値 ${leg.listed - leg.offers} 除外` : ''})</span>`;
}

function renderStatus() {
	if (!data) return;
	const [a, b] = data.hubs;
	const rate = data.hubRate
		? `1 ${hubIcon(b)}${hubShort(b)} = <b>${trim(data.hubRate.vwap)} ${hubIcon(a)}${hubShort(a)}</b> <span class="rng">(${trim(data.hubRate.worst)}〜${trim(data.hubRate.best)})</span>`
		: `${hubShort(a)}/${hubShort(b)} の約定なし`;
	status.innerHTML =
		`<b>${data.league}</b> ／ 集計窓 <b>${fmtTime(data.windowStart)} 〜 ${fmtTime(data.windowEnd)}</b>` +
		` (${data.hoursUsed}h) ／ ${rate} ／ ループ候補 <b>${data.loops.length / 2 | 0}</b> アイテム` +
		` (片側のみ ${data.skipped}) ／ 取得 ${fmtTime(data.generatedAt)}`;
}

function filtered(): Loop[] {
	if (!data) return [];
	const [a, b] = data.hubs;
	const dir = dirSel.value;
	const mp = 1 + (Number(minProfit.value) || 0) / 100;
	const mc = Number(minCap.value) || 0;
	const s = q.value.trim().toLowerCase();
	let rows = data.loops.filter((l) =>
		(dir === 'both' || (dir === 'ab' ? l.from === a && l.to === b : l.from === b && l.to === a)) &&
		l.profit.vwap >= mp &&
		l.capacityItems >= mc &&
		(!s || l.name.toLowerCase().includes(s) || l.category.toLowerCase().includes(s)),
	);
	const key = (l: Loop): number | string => ({
		name: l.name, buy: l.buy.vwap, sell: l.sell.vwap,
		vwap: l.profit.vwap, cons: l.profit.conservative, opt: l.profit.optimistic, cap: l.capacityItems,
	})[sortKey];
	rows = rows.sort((x, y) => {
		const kx = key(x), ky = key(y);
		const c = typeof kx === 'string' ? kx.localeCompare(ky as string) : kx - (ky as number);
		return sortDesc ? -c : c;
	});
	return rows;
}

function render() {
	const rows = filtered();
	tbody.innerHTML = '';
	rows.forEach((l, i) => {
		const tr = document.createElement('tr');
		tr.className = 'row' + (loopKey(l) === selected ? ' sel' : '');
		tr.innerHTML =
			`<td class="num">${i + 1}</td>` +
			`<td class="l"><span class="item">${icon(l.icon, l.name)}${esc(l.name)}</span><span class="cat">${esc(l.category)}</span></td>` +
			`<td class="l route">${route(l)}</td>` +
			`<td class="num">${fmtPrice(l.buy.vwap, l.buy.hub)} <span class="rng">(${fmtPrice(l.buy.worst, l.buy.hub)}〜${fmtPrice(l.buy.best, l.buy.hub)})</span></td>` +
			`<td class="num">${fmtPrice(l.sell.vwap, l.sell.hub)} <span class="rng">(${fmtPrice(l.sell.worst, l.sell.hub)}〜${fmtPrice(l.sell.best, l.sell.hub)})</span></td>` +
			`<td class="num">${trim(l.convert.vwap)} <span class="rng">(${trim(l.convert.worst)}〜${trim(l.convert.best)})</span></td>` +
			`<td class="num ${cls(l.profit.vwap)}"><b>${pct(l.profit.vwap)}</b></td>` +
			`<td class="num ${cls(l.profit.conservative)}">${pct(l.profit.conservative)}</td>` +
			`<td class="num ${cls(l.profit.optimistic)}">${pct(l.profit.optimistic)}</td>` +
			refCell(l) +
			`<td class="num">${l.capacityItems} <span class="rng">(買${l.buy.volumeItems} / 売${l.sell.volumeItems} = ${l.sell.volumeHub} ${hubShort(l.sell.hub)})</span></td>`;
		tr.addEventListener('click', () => { selected = loopKey(l); renderDetail(l); render(); });
		tbody.append(tr);
	});
	if (rows.length === 0) tbody.innerHTML = '<tr><td colspan="11" class="l">条件に合うループなし</td></tr>';
}

function renderDetail(l: Loop) {
	const from = hubName(l.from), to = hubName(l.to);
	const start = 100; // illustrative starting stack
	const items = start / l.buy.vwap;
	const got = items * l.sell.vwap;
	const back = got * l.convert.vwap;
	const r = refByKey.get(loopKey(l));
	const refHtml = !r
		? `<p class="k ref">出品相場: 未取得（「出品相場を取得」で上位 ${REF_LOOPS} ループ分を取得）</p>`
		: `<h3>出品相場 <span class="k">(トレードサイトのプレイヤー出品・手渡し取引)</span></h3>` +
			`<ol class="ref">` +
			`<li>${hubShort(l.from)} で買う: ${refLeg(r.buy, (p) => fmtPrice(p, l.buy.hub) + ' / 個')}</li>` +
			`<li>${hubShort(l.to)} で売る: ${refLeg(r.sell, (p) => fmtPrice(p, l.sell.hub) + ' / 個')}</li>` +
			`<li>${hubShort(l.to)} → ${hubShort(l.from)}: ${refLeg(r.convert, (p) => `1 ${hubShort(l.to)} = ${trim(p)} ${hubShort(l.from)}`)}</li>` +
			`</ol>` +
			(r.profit !== null
				? `<p>最良出品で回した場合: <b class="${cls(r.profit)}">${pct(r.profit)}</b> <span class="k">(在庫の上限 ${Math.min(r.buy!.stock, r.sell!.stock)} 個)</span></p>`
				: `<p class="k">${esc(r.note ?? '出品なし')}</p>`) +
			`<p class="k">※ ゲーム内取引所の板ではない。VWAP の 1/3〜3倍から外れた出品は冗談出品として除外。${ref ? fmtTime(ref.fetchedAt) + ' 取得' : ''}</p>`;
	detail.hidden = false;
	detail.innerHTML =
		`<button class="close" id="closeDetail" title="閉じる">×</button>` +
		`<h2>${icon(l.icon, l.name, 'lg')}<span>${esc(l.name)}</span></h2>` +
		`<div class="k">${esc(l.category)} ／ ${esc(l.itemId)}</div>` +
		`<div class="route k">${route(l)}</div>` +
		`<ol>` +
		`<li><b>${hubIcon(l.from)}${from}</b> で <b>${icon(l.icon, l.name)}${esc(l.name)}</b> を買う<br><span class="k">平均約定:</span> <code>${fmtPrice(l.buy.vwap, l.buy.hub)}</code> / 個 <span class="k">(幅 ${fmtPrice(l.buy.worst, l.buy.hub)} 〜 ${fmtPrice(l.buy.best, l.buy.hub)})</span><br><span class="k">この窓の約定:</span> ${l.buy.volumeItems} 個 (${l.buy.volumeHub} ${hubShort(l.buy.hub)})</li>` +
		`<li><b>${icon(l.icon, l.name)}${esc(l.name)}</b> を <b>${hubIcon(l.to)}${to}</b> で売る<br><span class="k">平均約定:</span> <code>${fmtPrice(l.sell.vwap, l.sell.hub)}</code> / 個 <span class="k">(幅 ${fmtPrice(l.sell.worst, l.sell.hub)} 〜 ${fmtPrice(l.sell.best, l.sell.hub)})</span><br><span class="k">この窓の約定:</span> ${l.sell.volumeItems} 個 (${l.sell.volumeHub} ${hubShort(l.sell.hub)})</li>` +
		`<li><b>${hubIcon(l.to)}${to}</b> を <b>${hubIcon(l.from)}${from}</b> に戻す<br><span class="k">平均レート:</span> 1 ${hubShort(l.to)} = <code>${trim(l.convert.vwap)}</code> ${hubShort(l.from)} <span class="k">(幅 ${trim(l.convert.worst)} 〜 ${trim(l.convert.best)})</span></li>` +
		`</ol>` +
		`<p><span class="k">VWAPでの試算 (${start} ${hubShort(l.from)} 開始):</span><br>` +
		`${start} ${hubShort(l.from)} → ${trim(items)} 個 → ${trim(got)} ${hubShort(l.to)} → <b class="${cls(l.profit.vwap)}">${trim(back)} ${hubShort(l.from)}</b> (${pct(l.profit.vwap)})</p>` +
		`<p class="k">保守(極端値) ${pct(l.profit.conservative)} ／ 楽観(極端値) ${pct(l.profit.optimistic)}<br>取引数の目安: ${l.capacityItems} 個/窓</p>` +
		`<p class="k">※ 完了した直近1時間の「約定」の集計であって、今の板ではない。VWAPは約定量で加重した平均、幅(保守/楽観)は1件の変な約定でも大きく振れる。実行前にゲーム内でAltキーを押して競合注文を確認。</p>` +
		refHtml;
}

detail.addEventListener('click', (e) => {
	if ((e.target as HTMLElement).id === 'closeDetail') { detail.hidden = true; selected = null; render(); }
});

function esc(s: string) {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// --- wiring ---
for (const th of document.querySelectorAll<HTMLTableCellElement>('th[data-sort]')) {
	th.addEventListener('click', () => {
		const k = th.dataset.sort as SortKey;
		if (k === sortKey) sortDesc = !sortDesc; else { sortKey = k; sortDesc = k !== 'name'; }
		document.querySelectorAll('th.sorted').forEach((e) => e.classList.remove('sorted'));
		th.classList.add('sorted');
		render();
	});
}
for (const el of [leagueSel, hubsSel, hoursSel]) el.addEventListener('change', load);
for (const el of [dirSel, minProfit, minCap, q]) el.addEventListener('input', () => { persist(); render(); });
$('#refresh').addEventListener('click', load);
refBtn.addEventListener('click', loadRef);

// Data only changes once an hour (plus ~5 min delay). Poll every 5 minutes.
setInterval(load, 5 * 60 * 1000);

(async () => {
	try { await loadLeagues(); } catch (e) { status.innerHTML = `<span class="err">リーグ一覧の取得失敗: ${(e as Error).message}</span>`; }
	restore();
	await load();
})();
