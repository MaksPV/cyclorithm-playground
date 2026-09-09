import init, { expand_timeline } from './pkg/playground.js';

const DEFAULT_SRC = `use "libs/route_lib.cyclo";

fun rush_top(x) = x + 1;

schedule "Автобусный парк" {
  point DEPOT {
    actions = [depart, arrive];
  }

  point AIRPORT {
    actions = [arrive, depart];
  }

  cycle CITY_ROUTE
    duration = 1h20m
  {
    0m: DEPOT.depart();
    40m: AIRPORT.arrive();
    50m: AIRPORT.depart();
    -0m: DEPOT.arrive();
  }

  cycle SHUTTLE
    duration = 20m
  {
    0m: DEPOT.depart();
    20m: DEPOT.arrive();
  }

  root_cycle
    start_time = "2026-01-01T00:00:00",
    duration = 24h
  {
    6h: CITY_ROUTE();
    [hour(at) >= rush_top(MORNING) and not weekend(at)] 10h: repeat 2 SHUTTLE();
    [not weekend(at)] 14h: fill until 15h SHUTTLE();
    [commute(at) and not weekend(at)] 18h: CITY_ROUTE();
    [weekend(at)] 12h: CITY_ROUTE();
  }
}
`;

// Библиотеки для `use` (путь — как в исходнике). v1: вшиты, позже — выбор файлов.
const LIBS = JSON.stringify([
  ["libs/route_lib.cyclo", "const MORNING = 6;\n\npred commute(at) = morning(at) or evening(at);\n"],
]);

const NS = 'http://www.w3.org/2000/svg';
const src = document.getElementById('src');
const startEl = document.getElementById('start');
const endEl = document.getElementById('end');
const errEl = document.getElementById('error');
const svg = document.getElementById('timeline');
const tbody = document.getElementById('events');

src.value = DEFAULT_SRC;

function parseTime(s) {
  // Наивный ISO8601 без таймзоны — как мс epoch (движок время наивное).
  // Секунды опциональны: datetime-local отдаёт без них.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7] ? +m[7].slice(1).padEnd(3, '0') : 0);
}

function windowInput(elm) {
  // datetime-local отдаёт без секунд — движок хочет полные.
  const v = elm.value;
  return v.length === 16 ? v + ':00' : v;
}

function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function run() {
  errEl.textContent = '';
  tbody.innerHTML = '';
  svg.innerHTML = '';
  let env;
  try {
    env = JSON.parse(expand_timeline(src.value, windowInput(startEl), windowInput(endEl), LIBS));
  } catch (e) {
    errEl.textContent = 'клей WASM: ' + e;
    return;
  }
  if (!env.ok) {
    const d = env.diag;
    let text = (d.code ? d.code + ' ' : '') + d.text;
    if (d.line) {
      text += `\n(строка ${d.line}${d.col ? ', колонка ' + d.col : ''})`;
      selectLine(d.line);
    }
    errEl.textContent = text;
    return;
  }
  draw(env.result);
}

function draw(res) {
  const t0 = parseTime(windowInput(startEl));
  const t1 = parseTime(windowInput(endEl));
  if (!(t0 < t1)) {
    errEl.textContent = 'окно пустое: end должен быть позже start';
    return;
  }
  // Раскладка как в монтаже: блоки идут по старту, каждый — на первую
  // дорожку, где он не пересекается с последним блоком.
  const ends = []; // конец последнего блока на дорожке, мс
  const trackOf = new Map();
  for (const s of res.spans) {
    const st = parseTime(s.start);
    let ti = ends.findIndex((e) => e <= st);
    if (ti < 0) {
      ti = ends.length;
      ends.push(-Infinity);
    }
    ends[ti] = parseTime(s.end);
    trackOf.set(s.cycle + '|' + s.start + '|' + s.end, ti);
  }
  const ntracks = ends.length;
  const W = 1000, LABEL = 44, LANE_H = 40, PAD = 10;
  const H = Math.max(ntracks, 1) * LANE_H + PAD * 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const X = (t) => LABEL + ((t - t0) / (t1 - t0)) * (W - LABEL - PAD);
  for (let ti = 0; ti < ntracks; ti++) {
    const y = PAD + ti * LANE_H;
    const label = el('text', { x: 4, y: y + LANE_H / 2 + 4, 'font-size': 12 }, svg);
    label.textContent = 'T' + (ti + 1);
    el('line', { x1: LABEL, x2: W - PAD, y1: y + LANE_H, y2: y + LANE_H, stroke: '#ddd' }, svg);
  }
  for (const s of res.spans) {
    const ti = trackOf.get(s.cycle + '|' + s.start + '|' + s.end);
    const y = PAD + ti * LANE_H;
    const root = s.cycle === 'root_cycle';
    const r = el('rect', {
      x: Math.max(X(parseTime(s.start)), LABEL),
      y: y + 5,
      width: Math.max(X(parseTime(s.end)) - X(parseTime(s.start)), 3),
      height: LANE_H - 10,
      rx: 3,
      fill: root ? '#eee' : '#cde6ff',
      stroke: root ? '#ccc' : '#69c',
    }, svg);
    const title = el('title', {}, r);
    title.textContent = `${s.cycle} ${s.start} — ${s.end}`;
  }
  for (const e of res.events) {
    const ti = trackOf.get(e.span.cycle + '|' + e.span.start + '|' + e.span.end);
    const y = PAD + (ti === undefined ? 0 : ti) * LANE_H + LANE_H / 2;
    const c = el('circle', {
      cx: X(parseTime(e.time)), cy: y, r: 5,
      fill: e.action === 'depart' ? '#0a0' : e.action === 'arrive' ? '#06c' : '#888',
      stroke: '#fff',
    }, svg);
    const title = el('title', {}, c);
    title.textContent = `${e.time} ${e.action} ${e.point} [${e.span.cycle}]`;
    const tr = document.createElement('tr');
    for (const k of ['time', 'action', 'point']) {
      const td = document.createElement('td');
      td.textContent = e[k];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// Выделить строку с ошибкой в редакторе (v1-подсветка синтаксиса).
function selectLine(n) {
  const lines = src.value.split('\n');
  if (n < 1 || n > lines.length) return;
  let off = 0;
  for (let i = 0; i < n - 1; i++) off += lines[i].length + 1;
  src.focus();
  src.setSelectionRange(off, off + lines[n - 1].length);
}

document.getElementById('run').addEventListener('click', run);
startEl.addEventListener('change', run);
endEl.addEventListener('change', run);

await init();
run();
