'use strict';
/* Sai PVC Doors Billing — vanilla JS, IndexedDB, works offline. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view'), titleEl = $('#title'), backBtn = $('#backBtn');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt2 = n => r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = n => String(Number(Number(n).toFixed(2)));
const p2 = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const fmtDate = iso => (iso ? iso.split('-').reverse().join('-') : '');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sai-pvc-billing', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('bills')) d.createObjectStore('bills', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const allBills = () => rq(db.transaction('bills').objectStore('bills').getAll());
const getBill = id => rq(db.transaction('bills').objectStore('bills').get(id));
async function putBill(b) { const tx = db.transaction('bills', 'readwrite'); tx.objectStore('bills').put(b); return txDone(tx); }
async function getMeta(key, def) { const r = await rq(db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : def; }
async function setMeta(key, value) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); return txDone(tx); }
async function getSettings() { return Object.assign({ rate: 100, autoExcel: true }, await getMeta('settings', {})); }

// ---------- bill maths ----------
const paidOf = b => r2((b.payments || []).reduce((s, p) => s + p.amount, 0));
const balanceOf = b => (b.carriedTo ? 0 : Math.max(0, r2(b.grandTotal - paidOf(b))));
const statusOf = b => (b.carriedTo ? 'Carried' : balanceOf(b) <= 0 ? 'Paid' : paidOf(b) > 0 ? 'Partial' : 'Pending');

function calc(doors, rate, prev) {
  const areas = doors.map(d => (d.l * d.w) / 144);
  const totalArea = areas.reduce((a, b) => a + b, 0);
  const amount = r2(totalArea * rate);
  return { areas, totalArea, amount, grand: r2(amount + (prev || 0)) };
}

function sameCustomer(b, name, mobile) {
  if (mobile && b.mobile && b.mobile === mobile) return true;
  if (norm(b.name) !== norm(name)) return false;
  return !mobile || !b.mobile || b.mobile === mobile;
}

// Pending of a customer = balance of their bills that were NOT yet carried into a newer bill.
// Each new bill carries the old balance once and marks old bills as "carried", so it is never counted twice.
function outstanding(bills, name, mobile) {
  const mine = bills.filter(b => sameCustomer(b, name, mobile));
  const open = mine.filter(b => !b.carriedTo && balanceOf(b) > 0);
  return { known: mine.length > 0, open, amount: r2(open.reduce((s, b) => s + balanceOf(b), 0)) };
}

function groupCustomers(bills) {
  const groups = [];
  [...bills].sort((a, b) => a.seq - b.seq).forEach(b => {
    let g = groups.find(x => sameCustomer(b, x.name, x.mobile));
    if (!g) { g = { name: b.name, mobile: '', bills: [], firstId: b.id }; groups.push(g); }
    g.bills.push(b);
    g.name = b.name;
    if (!g.mobile && b.mobile) g.mobile = b.mobile;
  });
  groups.forEach(g => { g.pending = r2(g.bills.reduce((s, b) => s + balanceOf(b), 0)); });
  return groups;
}

async function createBill(f) {
  const tx = db.transaction(['bills', 'meta'], 'readwrite');
  const bs = tx.objectStore('bills'), ms = tx.objectStore('meta');
  const bills = await rq(bs.getAll());
  const counter = (await rq(ms.get('counter')))?.value || 0;
  const seq = Math.max(counter, ...bills.map(b => b.seq || 0)) + 1;
  const id = 'SPD-' + String(seq).padStart(4, '0');
  const o = outstanding(bills, f.name, f.mobile);
  const prev = o.known ? o.amount : r2(Math.max(0, f.prev || 0));
  const c = calc(f.doors, f.rate, prev);
  const bill = {
    id, seq, date: f.date, name: f.name, mobile: f.mobile, rate: f.rate, doors: f.doors,
    totalArea: c.totalArea, amount: c.amount, prevPending: prev, grandTotal: c.grand,
    payments: [], carriedTo: null, createdAt: new Date().toISOString()
  };
  for (const b of o.open) { b.carriedAmount = balanceOf(b); b.carriedTo = id; bs.put(b); }
  bs.put(bill);
  ms.put({ key: 'counter', value: seq });
  await txDone(tx);
  return bill;
}

async function deleteBill(id) {
  const tx = db.transaction('bills', 'readwrite');
  const bs = tx.objectStore('bills');
  const bills = await rq(bs.getAll());
  for (const b of bills) if (b.carriedTo === id) { b.carriedTo = null; delete b.carriedAmount; bs.put(b); }
  bs.delete(id);
  return txDone(tx);
}

// ---------- Excel ----------
async function excelBlob() {
  const bills = (await allBills()).sort((a, b) => a.seq - b.seq);
  const rows = [['Bill ID', 'Date', 'Customer', 'Mobile', 'Door Count', 'Bill Amount', 'Paid', 'Balance', 'Status']];
  bills.forEach(b => {
    const st = statusOf(b);
    rows.push([b.id, fmtDate(b.date), b.name, b.mobile || '', b.doors.length, b.grandTotal, paidOf(b), balanceOf(b),
      st === 'Carried' ? 'Carried forward' : st]);
  });
  return makeXlsx('Bills', rows, [12, 12, 24, 14, 11, 13, 12, 12, 16]);
}
async function downloadExcel() { download(await excelBlob(), 'SaiPVC_Bills.xlsx'); }

// ---------- Bill image (canvas, drawn onto the supplied template layout) ----------
const FONT = '"Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", Arial, sans-serif';
const BR = '#4a3022', GR = '#7a756e', LN = '#d8d0c5';
const imgCache = {};
function loadImage(src) {
  if (!imgCache[src]) {
    imgCache[src] = new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => { delete imgCache[src]; rej(new Error('Could not load ' + src)); };
      i.src = src;
    });
  }
  return imgCache[src];
}
function rrect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function line(g, x1, y1, x2, y2, color, w) {
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokeStyle = color; g.lineWidth = w; g.stroke();
}
function text(g, t, x, y, o = {}) {
  let size = o.size || 28; const weight = o.weight || 'normal';
  g.font = `${weight} ${size}px ${FONT}`;
  if (o.maxW) while (g.measureText(t).width > o.maxW && size > 12) { size -= 1; g.font = `${weight} ${size}px ${FONT}`; }
  g.fillStyle = o.color || BR; g.textAlign = o.align || 'left'; g.textBaseline = 'middle';
  if ('letterSpacing' in g) g.letterSpacing = (o.spacing || 0) + 'px';
  g.fillText(t, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}

async function renderBillPNG(b) {
  const [logo, qr] = await Promise.all([loadImage(window.ASSETS.logo), loadImage(window.ASSETS.qr)]);
  if (document.fonts && document.fonts.ready) await document.fonts.ready;

  const W = 1080, RH = 69, TOP = 563, n = b.doors.length, shown = Math.max(n, 5);
  const tb = TOP + RH * shown;           // table bottom
  const H = tb + 416;
  const scale = Math.min(1, Math.sqrt(14e6 / (W * H)), 30000 / H);  // keeps very long bills inside canvas limits
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';

  // page + frame
  g.fillStyle = '#f7f3ea'; g.fillRect(0, 0, W, H);
  rrect(g, 25, 25, 1030, H - 50, 28); g.fillStyle = '#fffefb'; g.fill(); g.strokeStyle = BR; g.lineWidth = 3; g.stroke();
  g.lineWidth = 5; g.strokeStyle = BR; g.lineCap = 'butt';
  [[76, 47, 47, 47, 47, 76], [1005, 47, 1035, 47, 1035, 76], [47, H - 76, 47, H - 47, 76, H - 47], [1035, H - 76, 1035, H - 47, 1005, H - 47]]
    .forEach(p => { g.beginPath(); g.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]); g.stroke(); });

  // header: logo + provider
  g.drawImage(logo, 80, 62, 230, 170);
  line(g, 476, 65, 476, 245, LN, 3);
  text(g, 'PROVIDED BY', 526, 104, { size: 20, color: GR, spacing: 1 });
  text(g, 'Pravin Shirke', 526, 152, { size: 34 });
  text(g, '9423265288', 526, 201, { size: 28, color: GR, spacing: 2 });

  // BILL banner
  line(g, 70, 286, 1010, 286, BR, 2);
  rrect(g, 420, 260, 241, 53, 22); g.fillStyle = BR; g.fill();
  text(g, 'BILL', 540.5, 287, { size: 28, weight: 'bold', color: '#fff', align: 'center', spacing: 1 });

  // customer fields
  text(g, 'Customer:', 76, 361, { weight: 'bold' });
  line(g, 245, 383, 651, 383, BR, 1.5);
  text(g, b.name, 252, 366, { size: 28, maxW: 392 });
  text(g, 'Date:', 711, 361, { weight: 'bold' });
  line(g, 800, 383, 1005, 383, BR, 1.5);
  text(g, fmtDate(b.date), 806, 366, { size: 26, maxW: 195 });
  text(g, 'Bill No.:', 76, 426, { weight: 'bold' });
  line(g, 205, 448, 490, 448, BR, 1.5);
  text(g, b.id, 212, 431, { size: 26, maxW: 270 });
  text(g, 'Mobile:', 711, 426, { weight: 'bold' });
  line(g, 830, 448, 1005, 448, BR, 1.5);
  text(g, b.mobile || '', 836, 431, { size: 26, maxW: 165 });

  // table header
  g.beginPath(); g.moveTo(70, 563); g.lineTo(70, 502); g.arcTo(70, 490, 82, 490, 12); g.lineTo(998, 490);
  g.arcTo(1010, 490, 1010, 502, 12); g.lineTo(1010, 563); g.closePath(); g.fillStyle = '#eee8de'; g.fill();
  line(g, 221, 490, 221, TOP, LN, 2); line(g, 691, 490, 691, TOP, LN, 2);
  text(g, 'No.', 146, 527, { weight: 'bold', align: 'center' });
  text(g, 'Measurement', 456, 527, { weight: 'bold', align: 'center' });
  text(g, 'Area (sq.ft)', 850, 527, { weight: 'bold', align: 'center' });

  // table body
  for (let i = 1; i < shown; i++) line(g, 70, TOP + RH * i, 1010, TOP + RH * i, LN, 2);
  line(g, 221, TOP, 221, tb, LN, 2); line(g, 691, TOP, 691, tb, LN, 2);
  g.strokeStyle = BR; g.lineWidth = 2; g.strokeRect(70, TOP, 940, tb - TOP);
  b.doors.forEach((d, i) => {
    const y = TOP + RH * i + RH / 2;
    text(g, String(i + 1), 146, y, { color: GR, align: 'center' });
    text(g, `${num(d.l)} \u00d7 ${num(d.w)}`, 456, y, { align: 'center', maxW: 450 });
    text(g, fmt2((d.l * d.w) / 144), 850, y, { align: 'center', maxW: 320 });
  });

  // footer: QR + totals
  line(g, 70, tb + 6, 1010, tb + 6, '#e6dfd4', 2);
  g.drawImage(qr, 70, tb + 26, 362, 337);
  line(g, 466, tb + 26, 466, tb + 361, LN, 2);
  const rows = [
    ['Total Area', `${fmt2(b.totalArea)} sq.ft`, 58, 28],
    ['Rate', `\u20b9${num(b.rate)} / sq.ft`, 122, 28],
    ['Current Amount', `\u20b9 ${fmt2(b.amount)}`, 187, 28],
    ['Previous Pending', `\u20b9 ${fmt2(b.prevPending)}`, 249, 24]
  ];
  rows.forEach(([l, v, dy, sz]) => {
    text(g, l, 500, tb + dy, { size: sz, color: GR });
    text(g, v, 1000, tb + dy, { size: 28, weight: 'bold', align: 'right', maxW: 300 });
    line(g, 500, tb + dy + 28 + (dy === 249 ? 4 : 0), 1000, tb + dy + 28 + (dy === 249 ? 4 : 0), LN, 1.5);
  });
  rrect(g, 490, tb + 316, 521, 70, 18); g.fillStyle = BR; g.fill();
  text(g, 'GRAND TOTAL', 516, tb + 351, { size: 28, weight: 'bold', color: '#fff', spacing: 1 });
  text(g, `\u20b9 ${fmt2(b.grandTotal)}`, 985, tb + 351, { size: 34, weight: 'bold', color: '#fff', align: 'right', maxW: 270 });

  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Browser could not create the PNG');
  return blob;
}

// ---------- router ----------
const routes = {};
async function render() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = h.split('/');
  backBtn.hidden = name === 'home';
  titleEl.textContent = 'Sai PVC Doors';
  window.scrollTo(0, 0);
  try { await (routes[name] || routes.home)(decodeURIComponent(rest.join('/'))); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
backBtn.onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/home'));
const goto = h => { location.hash = '#/' + h; };

let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!location.hash || location.hash === '#/home') render(); });
window.addEventListener('appinstalled', () => { installEvt = null; });

// ---------- Home ----------
routes.home = async () => {
  const bills = await allBills();
  const pend = bills.filter(b => balanceOf(b) > 0);
  const total = r2(pend.reduce((s, b) => s + balanceOf(b), 0));
  const last = await getMeta('lastBackup', null);
  const stale = bills.length && (!last || (Date.now() - new Date(last)) > 7 * 864e5);
  view.innerHTML = `
    <div class="card"><div class="muted">Total pending</div><div style="font-size:26px;font-weight:700">&#8377; ${fmt2(total)}</div></div>
    <div class="grid">
      <div class="tile" data-go="new">+ Create Bill</div>
      <div class="tile" data-go="bills">All Bills<small>${bills.length}</small></div>
      <div class="tile" data-go="pending">Pending Bills<small>${pend.length}</small></div>
      <div class="tile" data-go="customers">Customers<small>${groupCustomers(bills).length}</small></div>
      <div class="tile" data-go="backup" style="grid-column:span 2">Backup / Restore / Excel</div>
    </div>
    ${stale ? `<div class="card" style="margin-top:12px"><b>Backup due.</b><div class="note">${last ? 'Last backup was more than a week ago.' : 'You have not taken a backup yet.'}</div><button class="btn alt small" data-go="backup">Open Backup</button></div>` : ''}
    ${installEvt ? '<button class="btn alt" id="inst">Install app on this phone</button>' : ''}`;
  view.querySelectorAll('[data-go]').forEach(t => t.onclick = () => goto(t.dataset.go));
  const inst = $('#inst');
  if (inst) inst.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); };
};

// ---------- New bill ----------
routes.new = async arg => {
  titleEl.textContent = 'New Bill';
  const [bills, settings] = await Promise.all([allBills(), getSettings()]);
  let pre = { name: '', mobile: '' };
  if (arg) { const g = groupCustomers(bills).find(x => x.firstId === arg); if (g) pre = { name: g.name, mobile: g.mobile }; }
  const names = [...new Set(bills.map(b => b.name))];
  view.innerHTML = `
    <div class="card">
      <label>Customer name</label>
      <input id="cName" list="names" autocomplete="off" value="${esc(pre.name)}">
      <datalist id="names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="row2">
        <div><label>Mobile</label><input id="cMob" type="tel" inputmode="numeric" maxlength="12" value="${esc(pre.mobile)}"></div>
        <div><label>Date</label><input id="cDate" type="date" value="${today()}"></div>
      </div>
      <label>Rate (&#8377; per sq.ft)</label>
      <input id="rate" type="number" inputmode="decimal" step="any" value="${settings.rate}">
    </div>
    <div class="card">
      <h2 style="margin-top:0">Doors (inches)</h2>
      <div class="heads"><span>No.</span><span>Length</span><span>Width</span><span style="text-align:right">Sq.ft</span><span></span></div>
      <div id="doors"></div>
      <button class="btn alt" id="addDoor" type="button">+ Add Door</button>
    </div>
    <div class="card sum">
      <div><span>Doors</span><b id="sCount">0</b></div>
      <div><span>Total Area</span><b id="sArea">0.00 sq.ft</b></div>
      <div><span>Current Amount</span><b id="sAmt">&#8377; 0.00</b></div>
      <div><span>Previous Pending</span><span style="width:45%"><input id="prev" type="number" inputmode="decimal" step="any" min="0" value="0"></span></div>
      <div class="note" id="prevNote" style="border:0"></div>
      <div class="g"><span>Grand Total</span><span id="sGrand">&#8377; 0.00</span></div>
    </div>
    <button class="btn" id="save">Save &amp; Generate Bill</button>`;

  const doorsEl = $('#doors'), prevEl = $('#prev');
  const readDoors = () => [...doorsEl.children].map(r => ({ l: parseFloat($('.l', r).value), w: parseFloat($('.w', r).value), row: r }));

  function update() {
    const rows = readDoors();
    rows.forEach((d, i) => {
      $('.n', d.row).textContent = i + 1;
      $('.x', d.row).style.visibility = rows.length > 1 ? 'visible' : 'hidden';
      $('.area', d.row).textContent = d.l > 0 && d.w > 0 ? fmt2(d.l * d.w / 144) : '0.00';
    });
    const valid = rows.filter(d => d.l > 0 && d.w > 0);
    const rate = parseFloat($('#rate').value) || 0;
    const prev = Math.max(0, parseFloat(prevEl.value) || 0);
    const c = calc(valid, rate, prev);
    $('#sCount').textContent = valid.length;
    $('#sArea').textContent = fmt2(c.totalArea) + ' sq.ft';
    $('#sAmt').textContent = '\u20b9 ' + fmt2(c.amount);
    $('#sGrand').textContent = '\u20b9 ' + fmt2(c.grand);
  }

  function addDoor(focus) {
    const r = document.createElement('div');
    r.className = 'door';
    r.innerHTML = `<span class="n"></span>
      <input class="l" type="number" inputmode="decimal" step="any" min="0" placeholder="26">
      <input class="w" type="number" inputmode="decimal" step="any" min="0" placeholder="81">
      <span class="area">0.00</span><button class="x" type="button" aria-label="Remove">&times;</button>`;
    doorsEl.appendChild(r);
    $('.x', r).onclick = () => { if (doorsEl.children.length > 1) { r.remove(); update(); } };
    $('.l', r).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('.w', r).focus(); } });
    $('.w', r).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = r.nextElementSibling;
      if (next) $('.l', next).focus(); else addDoor(true);
    });
    r.addEventListener('input', update);
    update();
    if (focus) $('.l', r).focus();
  }
  addDoor(false);
  $('#addDoor').onclick = () => addDoor(true);
  $('#rate').addEventListener('input', update);
  prevEl.addEventListener('input', update);

  let locked = false;
  function refreshPrev() {
    const name = $('#cName').value, mobile = cleanMobile($('#cMob').value);
    const o = name.trim() ? outstanding(bills, name, mobile) : { known: false, open: [], amount: 0 };
    if (o.known) {
      prevEl.value = o.amount; prevEl.readOnly = true; locked = true;
      $('#prevNote').textContent = o.amount > 0
        ? `Carried from ${o.open.map(b => b.id).join(', ')}. It is added only once; the old bill is marked as carried.`
        : 'No pending from earlier bills.';
    } else {
      if (locked) prevEl.value = 0;
      prevEl.readOnly = false; locked = false;
      $('#prevNote').textContent = name.trim() ? 'New customer. Enter an old balance here only if there is one.' : '';
    }
    update();
  }
  $('#cName').addEventListener('input', () => {
    if (!$('#cMob').value) {
      const g = groupCustomers(bills).find(x => norm(x.name) === norm($('#cName').value));
      if (g && g.mobile) $('#cMob').value = g.mobile;
    }
    refreshPrev();
  });
  $('#cMob').addEventListener('input', refreshPrev);
  refreshPrev();

  let saving = false;
  $('#save').onclick = async () => {
    if (saving) return;
    const name = $('#cName').value.trim().replace(/\s+/g, ' ');
    const mobile = cleanMobile($('#cMob').value);
    if (!name) return toast('Enter customer name');
    if (mobile && mobile.length !== 10) return toast('Mobile number must be 10 digits');
    const rate = parseFloat($('#rate').value);
    if (!(rate > 0)) return toast('Enter a valid rate');
    const doors = [];
    for (const d of readDoors()) {
      const emptyL = isNaN(d.l), emptyW = isNaN(d.w);
      if (emptyL && emptyW) continue;
      if (!(d.l > 0 && d.w > 0)) { (emptyL || !(d.l > 0) ? $('.l', d.row) : $('.w', d.row)).focus(); return toast('Enter both length and width for each door'); }
      doors.push({ l: d.l, w: d.w });
    }
    if (!doors.length) return toast('Add at least one door');
    saving = true; $('#save').disabled = true;
    try {
      const bill = await createBill({ name, mobile, date: $('#cDate').value || today(), rate, doors, prev: parseFloat(prevEl.value) || 0 });
      const s = await getSettings();
      if (s.autoExcel) { try { await downloadExcel(); } catch (e) { console.error(e); } }
      location.replace('#/bill/' + bill.id);
    } catch (e) {
      console.error(e); toast('Could not save: ' + e.message);
      saving = false; $('#save').disabled = false;
    }
  };
};
function cleanMobile(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d;
}

// ---------- Bill detail ----------
let pvUrl = null;
routes.bill = async id => {
  titleEl.textContent = id;
  const b = await getBill(id);
  if (!b) { view.innerHTML = '<div class="empty">Bill not found</div>'; return; }
  const st = statusOf(b), paid = paidOf(b), bal = balanceOf(b);
  const canShare = !!(navigator.canShare && navigator.share);
  let payHtml;
  if (b.carriedTo) {
    payHtml = `<p class="muted">Balance of &#8377; ${fmt2(b.carriedAmount || 0)} was carried forward to bill
      <a href="#/bill/${esc(b.carriedTo)}">${esc(b.carriedTo)}</a>. Record further payments there.</p>`;
  } else if (bal > 0) {
    payHtml = `<button class="btn small" id="markPaid">Mark Paid (&#8377; ${fmt2(bal)})</button>
      ${paid > 0 ? '<button class="btn danger small" id="markPending">Mark Pending</button>' : ''}
      <label>Partial payment amount (&#8377;)</label>
      <input id="partial" type="number" inputmode="decimal" step="any" min="0" placeholder="Enter amount received">
      <button class="btn alt" id="addPartial">Add Partial Payment</button>`;
  } else {
    payHtml = `<p class="muted">Fully paid.</p><button class="btn danger small" id="markPending">Mark Pending (reset payments)</button>`;
  }
  const hist = (b.payments || []).length
    ? `<table class="pay"><tbody>${b.payments.map(p => `<tr><td>${fmtDate(p.date)}</td><td>&#8377; ${fmt2(p.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="note">No payments recorded.</div>';

  view.innerHTML = `
    <div class="card">
      <div class="item" style="border:0;padding:0;margin:0;cursor:default"><div class="top">
        <div><b>${esc(b.name)}</b><div class="sub">${esc(b.mobile || 'No mobile')} &middot; ${fmtDate(b.date)}</div></div>
        <span class="tag ${st}">${st === 'Carried' ? 'Carried forward' : st}</span></div></div>
      <div class="sum" style="margin-top:8px">
        <div><span>Doors</span><span>${b.doors.length}</span></div>
        <div><span>Total Area</span><span>${fmt2(b.totalArea)} sq.ft</span></div>
        <div><span>Rate</span><span>&#8377;${num(b.rate)} / sq.ft</span></div>
        <div><span>Current Amount</span><span>&#8377; ${fmt2(b.amount)}</span></div>
        <div><span>Previous Pending</span><span>&#8377; ${fmt2(b.prevPending)}</span></div>
        <div><span>Grand Total</span><b>&#8377; ${fmt2(b.grandTotal)}</b></div>
        <div><span>Paid</span><span>&#8377; ${fmt2(paid)}</span></div>
        <div><span>Balance</span><b>&#8377; ${fmt2(bal)}</b></div>
      </div>
    </div>
    <div class="card"><h2 style="margin-top:0">Bill image</h2>
      <div id="pvBox" class="muted">Preparing bill image...</div>
      <button class="btn" id="dlPng">Download PNG</button>
      ${canShare ? '<button class="btn alt" id="shPng">Share (WhatsApp etc.)</button>' : ''}
      <button class="btn alt" id="dlXls">Download Excel</button>
    </div>
    <div class="card"><h2 style="margin-top:0">Payment</h2>${payHtml}<h2>History</h2>${hist}</div>
    ${b.carriedTo ? '' : '<button class="btn danger" id="del">Delete this bill</button>'}`;

  // image
  let pngP = renderBillPNG(b);
  const fileName = `${b.id}_${b.name.replace(/[^\w\-]+/g, '_')}.png`;
  const showPreview = () => pngP.then(blob => {
    if (pvUrl) URL.revokeObjectURL(pvUrl);
    pvUrl = URL.createObjectURL(blob);
    const box = $('#pvBox'); if (box) box.innerHTML = `<img class="preview" alt="Bill ${esc(b.id)}" src="${pvUrl}">`;
    return blob;
  }).catch(e => {
    console.error(e);
    const box = $('#pvBox');
    if (box) box.innerHTML = `Could not draw the bill image: ${esc(e.message)}<br><button class="btn alt small" id="retry">Retry</button>`;
    const r = $('#retry'); if (r) r.onclick = () => { $('#pvBox').textContent = 'Preparing bill image...'; pngP = renderBillPNG(b); showPreview(); };
    throw e;
  });
  showPreview().catch(() => {});
  $('#dlPng').onclick = async () => { try { download(await pngP, fileName); } catch (e) { toast('Image not ready: ' + e.message); } };
  const sh = $('#shPng');
  if (sh) sh.onclick = async () => {
    try {
      const file = new File([await pngP], fileName, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Bill ' + b.id });
      else download(file, fileName);
    } catch (e) { if (e.name !== 'AbortError') toast('Could not share: ' + e.message); }
  };
  $('#dlXls').onclick = () => downloadExcel().catch(e => toast('Excel failed: ' + e.message));

  // payments
  const addPayment = async amount => {
    const fresh = await getBill(b.id);
    fresh.payments = fresh.payments || [];
    fresh.payments.push({ date: today(), amount: r2(amount) });
    await putBill(fresh);
    toast('Payment saved'); render();
  };
  const mp = $('#markPaid'); if (mp) mp.onclick = () => addPayment(bal);
  const ap = $('#addPartial');
  if (ap) ap.onclick = () => {
    const a = parseFloat($('#partial').value);
    if (!(a > 0)) return toast('Enter the amount received');
    if (r2(a) > bal) return toast(`Amount is more than the balance (\u20b9 ${fmt2(bal)})`);
    addPayment(a);
  };
  const mpd = $('#markPending');
  if (mpd) mpd.onclick = async () => {
    if (!confirm('Remove all payments recorded on this bill?')) return;
    const fresh = await getBill(b.id); fresh.payments = []; await putBill(fresh); toast('Marked pending'); render();
  };
  const del = $('#del');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete bill ${b.id}? Any older balance carried into it goes back to the older bill.`)) return;
    await deleteBill(b.id); toast('Bill deleted'); location.replace('#/home');
  };
};

// ---------- Lists ----------
function billItem(b) {
  const st = statusOf(b), bal = balanceOf(b);
  return `<div class="item" data-id="${esc(b.id)}"><div class="top"><div><b>${esc(b.name)}</b>
    <div class="sub">${esc(b.id)} &middot; ${fmtDate(b.date)}${b.mobile ? ' &middot; ' + esc(b.mobile) : ''}</div></div>
    <span class="tag ${st}">${st === 'Carried' ? 'Carried' : st}</span></div>
    <div class="sub">Total &#8377; ${fmt2(b.grandTotal)}${bal > 0 ? ` &middot; Balance <b>&#8377; ${fmt2(bal)}</b>` : ''}</div></div>`;
}
function listView(mode) {
  return async () => {
    titleEl.textContent = mode === 'pending' ? 'Pending Bills' : 'All Bills';
    const all = (await allBills()).sort((a, b) => b.seq - a.seq);
    const base = mode === 'pending' ? all.filter(b => balanceOf(b) > 0) : all;
    view.innerHTML = `<input id="q" placeholder="Search Bill ID, customer or mobile" autocomplete="off">
      ${mode === 'pending' ? `<p class="muted" id="ptot"></p>` : ''}<div id="list" style="margin-top:12px"></div>`;
    const draw = () => {
      const q = norm($('#q').value);
      const items = base.filter(b => !q || norm(b.id).includes(q) || norm(b.name).includes(q) || (b.mobile || '').includes(q));
      $('#list').innerHTML = items.length ? items.map(billItem).join('') : '<div class="empty">No bills found</div>';
      $('#list').querySelectorAll('.item').forEach(i => i.onclick = () => goto('bill/' + i.dataset.id));
      if (mode === 'pending') $('#ptot').innerHTML = `Pending total: <b>&#8377; ${fmt2(items.reduce((s, b) => s + balanceOf(b), 0))}</b>`;
    };
    $('#q').addEventListener('input', draw);
    draw();
  };
}
routes.bills = listView('all');
routes.pending = listView('pending');

routes.customers = async () => {
  titleEl.textContent = 'Customers';
  const groups = groupCustomers(await allBills()).sort((a, b) => b.pending - a.pending || norm(a.name).localeCompare(norm(b.name)));
  view.innerHTML = `<input id="q" placeholder="Search customer or mobile" autocomplete="off"><div id="list" style="margin-top:12px"></div>`;
  const draw = () => {
    const q = norm($('#q').value);
    const items = groups.filter(g => !q || norm(g.name).includes(q) || g.mobile.includes(q));
    $('#list').innerHTML = items.length ? items.map(g => `<div class="item" data-id="${esc(g.firstId)}"><div class="top"><div><b>${esc(g.name)}</b>
      <div class="sub">${esc(g.mobile || 'No mobile')} &middot; ${g.bills.length} bill${g.bills.length > 1 ? 's' : ''}</div></div>
      ${g.pending > 0 ? `<span class="tag Pending">&#8377; ${fmt2(g.pending)}</span>` : '<span class="tag Paid">Clear</span>'}</div></div>`).join('')
      : '<div class="empty">No customers yet</div>';
    $('#list').querySelectorAll('.item').forEach(i => i.onclick = () => goto('customer/' + i.dataset.id));
  };
  $('#q').addEventListener('input', draw);
  draw();
};

routes.customer = async firstId => {
  const g = groupCustomers(await allBills()).find(x => x.firstId === firstId);
  if (!g) { view.innerHTML = '<div class="empty">Customer not found</div>'; return; }
  titleEl.textContent = g.name;
  view.innerHTML = `<div class="card"><b>${esc(g.name)}</b><div class="sub muted">${esc(g.mobile || 'No mobile')}</div>
    <div class="sum" style="margin-top:6px"><div><span>Bills</span><span>${g.bills.length}</span></div>
    <div><span>Pending</span><b>&#8377; ${fmt2(g.pending)}</b></div></div>
    <button class="btn" id="nb">+ New Bill for this customer</button></div>
    ${[...g.bills].sort((a, b) => b.seq - a.seq).map(billItem).join('')}`;
  $('#nb').onclick = () => goto('new/' + g.firstId);
  view.querySelectorAll('.item').forEach(i => i.onclick = () => goto('bill/' + i.dataset.id));
};

// ---------- Backup / restore / settings ----------
routes.backup = async () => {
  titleEl.textContent = 'Backup / Restore';
  const s = await getSettings();
  const last = await getMeta('lastBackup', null);
  view.innerHTML = `
    <div class="card"><h2 style="margin-top:0">Excel</h2>
      <p class="muted">One sheet &ldquo;Bills&rdquo; with every bill. It is rebuilt from your saved data each time, so it is always up to date.</p>
      <button class="btn" id="xls">Download Excel (SaiPVC_Bills.xlsx)</button>
      <label style="display:flex;gap:8px;align-items:center;color:var(--brown)"><input type="checkbox" id="auto" ${s.autoExcel ? 'checked' : ''}> Download Excel automatically after each new bill</label>
    </div>
    <div class="card"><h2 style="margin-top:0">Default rate</h2>
      <label>&#8377; per sq.ft (used when starting a new bill)</label>
      <input id="dRate" type="number" inputmode="decimal" step="any" value="${s.rate}">
      <button class="btn alt" id="saveSet">Save settings</button>
    </div>
    <div class="card"><h2 style="margin-top:0">Backup</h2>
      <p class="muted">${last ? 'Last backup: ' + new Date(last).toLocaleString('en-IN') : 'No backup taken yet.'}</p>
      <button class="btn" id="bk">Download JSON Backup</button></div>
    <div class="card"><h2 style="margin-top:0">Restore</h2>
      <input type="file" id="file" accept=".json,application/json"><div id="rinfo"></div></div>`;

  $('#xls').onclick = () => downloadExcel().then(() => toast('Excel downloaded')).catch(e => toast('Excel failed: ' + e.message));
  $('#saveSet').onclick = async () => {
    const rate = parseFloat($('#dRate').value);
    if (!(rate > 0)) return toast('Enter a valid rate');
    await setMeta('settings', { rate, autoExcel: $('#auto').checked }); toast('Settings saved');
  };
  $('#auto').onchange = async () => { const cur = await getSettings(); await setMeta('settings', { ...cur, autoExcel: $('#auto').checked }); toast('Saved'); };
  $('#bk').onclick = async () => {
    const data = { app: 'sai-pvc-billing', version: 1, exportedAt: new Date().toISOString(),
      settings: await getSettings(), counter: await getMeta('counter', 0), bills: await allBills() };
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `SaiPVC_Backup_${today()}.json`);
    await setMeta('lastBackup', new Date().toISOString());
    toast('Backup downloaded'); render();
  };
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('This is not a valid backup file'); }
    const bills = (data && data.app === 'sai-pvc-billing' && Array.isArray(data.bills)) ? data.bills.filter(validBill) : null;
    if (!bills) return toast('This is not a Sai PVC backup file');
    $('#rinfo').innerHTML = `<p class="muted">File has ${bills.length} bill(s).</p>
      <button class="btn" id="rMerge">Restore &amp; keep existing (add missing bills)</button>
      <button class="btn danger" id="rReplace">Replace everything with this backup</button>`;
    $('#rMerge').onclick = () => restore(bills, data, false);
    $('#rReplace').onclick = () => { if (confirm('This deletes all bills currently on this phone and uses the backup instead. Continue?')) restore(bills, data, true); };
  };
};
function validBill(b) {
  return b && typeof b.id === 'string' && typeof b.name === 'string' && Array.isArray(b.doors) &&
    typeof b.grandTotal === 'number' && typeof b.amount === 'number' && typeof b.totalArea === 'number';
}
async function restore(bills, data, replace) {
  try {
    bills.forEach(b => {
      b.seq = b.seq || parseInt(String(b.id).replace(/\D/g, ''), 10) || 0;
      b.payments = Array.isArray(b.payments) ? b.payments : [];
      b.prevPending = b.prevPending || 0; b.mobile = b.mobile || ''; b.carriedTo = b.carriedTo || null;
    });
    const tx = db.transaction(['bills', 'meta'], 'readwrite');
    const bs = tx.objectStore('bills'), ms = tx.objectStore('meta');
    const existing = await rq(bs.getAll());
    const have = new Set(replace ? [] : existing.map(b => b.id));
    if (replace) bs.clear();
    let added = 0;
    bills.forEach(b => { if (!have.has(b.id)) { bs.put(b); added++; } });
    const maxSeq = Math.max(0, data.counter || 0, ...bills.map(b => b.seq), ...(replace ? [] : existing.map(b => b.seq || 0)));
    const cur = (await rq(ms.get('counter')))?.value || 0;
    ms.put({ key: 'counter', value: replace ? maxSeq : Math.max(maxSeq, cur) });
    if (replace && data.settings) ms.put({ key: 'settings', value: Object.assign({ rate: 100, autoExcel: true }, data.settings) });
    await txDone(tx);
    toast(`Restored ${added} bill(s)`); render();
  } catch (e) { console.error(e); toast('Restore failed: ' + e.message); }
}

// ---------- start ----------
(async function init() {
  try {
    db = await openDB();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
    if (!location.hash) history.replaceState(null, '', '#/home');
    render();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card">Storage could not start: ${esc(e.message)}.<br>Private/incognito mode can block it.</div>`;
  }
})();
