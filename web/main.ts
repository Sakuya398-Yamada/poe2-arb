import { HUB_LABEL, type Hub, type Loop, type LoopsResponse } from '../shared/types.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const leagueSel = $<HTMLSelectElement>('#league');
const hubsSel = $<HTMLSelectElement>('#hubs');
const hoursSel = $<HTMLSelectElement>('#hours');
const dirSel = $<HTMLSelectElement>('#dir');
const minProfit = $<HTMLInputElement>('#minProfit');
const minCap = $<HTMLInputElement>('#minCap');
const q = $<HTMLInputElement>('#q');
const status = $<HTMLElement>('#status');
const tbl = $<HTMLTableElement>('#tbl');
const tbody = $<HTMLTableSectionElement>('#tbl tbody');
const detail = $<HTMLElement>('#detail');

type SortKey = 'name' | 'buy' | 'sell' | 'vwap' | 'cons' | 'opt' | 'fee' | 'net' | 'cap' | 'rec' | 'med';
const RECURRENCE_KEYS: SortKey[] = ['rec', 'med'];
let sortKey: SortKey = 'vwap';
let sortDesc = true;
let data: LoopsResponse | null = null;
let selected: string | null = null;

const pct = (m: number) => `${m >= 1 ? '+' : ''}${((m - 1) * 100).toFixed(1)}%`;
const cls = (m: number) => (m > 1 ? 'pos' : m < 1 ? 'neg' : '');
const hubName = (h: Hub) => HUB_LABEL[h].ja;
const hubShort = (h: Hub) => HUB_LABEL[h].short;
const fmtTime = (unix: number) => new Date(unix * 1000).toLocaleString('ja-JP', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const gold = (g: number) => `${Math.round(g).toLocaleString('en-US')}g`;
/** fee column: total gold per item with the per-leg breakdown, or "?" when the item's fee is unknown */
const fmtFee = (l: Loop) => l.goldFee
	? `${gold(l.goldFee.total)} <span class="rng">(${gold(l.goldFee.item)}+${gold(l.goldFee.toHub)}+${gold(l.goldFee.fromHub)})</span>`
	: '<span class="rng">?</span>';
const fmtNet = (l: Loop) => l.profit.afterFee !== undefined ? `<span class="${cls(l.profit.afterFee)}">${pct(l.profit.afterFee)}</span>` : '<span class="rng">—</span>';

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

const recRatio = (l: Loop) => (l.recurrence ? l.recurrence.hoursProfitable / l.recurrence.hoursTotal : 0);
const recText = (l: Loop) => (l.recurrence ? `${l.recurrence.hoursProfitable}/${l.recurrence.hoursTotal}` : '—');
const medText = (l: Loop) => (l.recurrence?.medianProfit != null ? pct(l.recurrence.medianProfit) : '—');
const medCls = (l: Loop) => (l.recurrence?.medianProfit != null ? cls(l.recurrence.medianProfit) : '');

function setSort(k: SortKey, desc: boolean) {
	sortKey = k; sortDesc = desc;
	document.querySelectorAll('th.sorted').forEach((e) => e.classList.remove('sorted'));
	document.querySelector(`th[data-sort="${k}"]`)?.classList.add('sorted');
}

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
		// With a single hour the recurrence columns are hidden; don't keep sorting by an invisible column.
		tbl.classList.toggle('single', data.hoursUsed < 2);
		if (data.hoursUsed < 2 && RECURRENCE_KEYS.includes(sortKey)) setSort('vwap', true);
		renderStatus();
		render();
	} catch (e) {
		status.innerHTML = `<span class="err">取得失敗: ${(e as Error).message}</span>`;
	}
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
		` (片側のみ ${data.skipped}) ／ 取得 ${fmtTime(data.generatedAt)}` +
		(data.goldPerHub.ex
			? ` ／ ゴールド換算 1 ${hubShort('ex')} = <b>${gold(data.goldPerHub.ex)}</b>`
			: ' ／ <span class="rng">ゴールド換算なし (POE2ARB_GOLD_PER_EX 未設定)</span>');
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
		// unknown fee / no gold rate sort to the bottom in both directions
		fee: l.goldFee?.total ?? (sortDesc ? -Infinity : Infinity),
		net: l.profit.afterFee ?? (sortDesc ? -Infinity : Infinity),
		rec: recRatio(l), med: l.recurrence?.medianProfit ?? 0,
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
			`<td class="num">${fmtFee(l)}</td>` +
			`<td class="num"><b>${fmtNet(l)}</b></td>` +
			`<td class="num">${l.capacityItems} <span class="rng">(買${l.buy.volumeItems} / 売${l.sell.volumeItems} = ${l.sell.volumeHub} ${hubShort(l.sell.hub)})</span></td>` +
			`<td class="num rec">${recText(l)}</td>` +
			`<td class="num rec ${medCls(l)}">${medText(l)}</td>`;
		tr.addEventListener('click', () => { selected = loopKey(l); renderDetail(l); render(); });
		tbody.append(tr);
	});
	if (rows.length === 0) tbody.innerHTML = '<tr><td colspan="14" class="l">条件に合うループなし</td></tr>';
}

/** Gold fee paragraph for the detail panel, scaled to the illustrative stack. */
function feeDetail(l: Loop, items: number): string {
	if (!l.goldFee) return `<p class="k">ゴールド手数料: 不明 (このアイテムの手数料がデータ源に無い)</p>`;
	const f = l.goldFee;
	const total = f.total * items;
	const net = l.profit.afterFee !== undefined
		? `<br>手数料込み: <b class="${cls(l.profit.afterFee)}">${pct(l.profit.afterFee)}</b> <span class="k">(1 ${hubShort(l.from)} = ${gold(data?.goldPerHub[l.from] ?? 0)} で換算)</span>`
		: `<br><span class="k">手数料込み利益は POE2ARB_GOLD_PER_EX を設定すると出る</span>`;
	return `<p><span class="k">ゴールド手数料の見積り (${trim(items)} 個分):</span> <b>${gold(total)}</b><br>` +
		`<span class="k">内訳/個:</span> ${esc(l.name)} ${gold(f.item)} + ${hubShort(l.to)} ${gold(f.toHub)} + ${hubShort(l.from)} ${gold(f.fromHub)} = ${gold(f.total)}` +
		net + `</p>`;
}

function renderDetail(l: Loop) {
	const from = hubName(l.from), to = hubName(l.to);
	const start = 100; // illustrative starting stack
	const items = start / l.buy.vwap;
	const got = items * l.sell.vwap;
	const back = got * l.convert.vwap;
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
		feeDetail(l, items) +
		(l.recurrence && l.recurrence.hoursTotal >= 2
			? `<p class="k">再現性: ${l.recurrence.hoursTotal} 時間中 <b>${l.recurrence.hoursProfitable}</b> 時間で利益あり ／ 各時間の VWAP 利益の中央値 <b class="${medCls(l)}">${medText(l)}</b></p>`
			: '') +
		`<p class="k">※ 完了した直近1時間の「約定」の集計であって、今の板ではない。VWAPは約定量で加重した平均、幅(保守/楽観)は1件の変な約定でも大きく振れる。実行前にゲーム内でAltキーを押して競合注文を確認。<br>※ 手数料は「要求側のアイテム1個あたり固定ゴールド × 個数」(poe2db の GoldPurchaseFee)として見積もった値で、実機では未検証。</p>`;
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
		setSort(k, k === sortKey ? !sortDesc : k !== 'name');
		render();
	});
}
for (const el of [leagueSel, hubsSel, hoursSel]) el.addEventListener('change', load);
for (const el of [dirSel, minProfit, minCap, q]) el.addEventListener('input', () => { persist(); render(); });
$('#refresh').addEventListener('click', load);

// Data only changes once an hour (plus ~5 min delay). Poll every 5 minutes.
setInterval(load, 5 * 60 * 1000);

(async () => {
	try { await loadLeagues(); } catch (e) { status.innerHTML = `<span class="err">リーグ一覧の取得失敗: ${(e as Error).message}</span>`; }
	restore();
	await load();
})();
