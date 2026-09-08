import init, { expand_it } from './pkg/playground.js';

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

const src = document.getElementById('src');
const startEl = document.getElementById('start');
const endEl = document.getElementById('end');
const errEl = document.getElementById('error');
const svg = document.getElementById('timeline');
const tbody = document.getElementById('events');

src.value = DEFAULT_SRC;

function parseTime(s) {
  // Наивный ISO8601 без таймзоны — как мс epoch (движок время наивное).
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7].slice(1).padEnd(3, '0') : 0);
}

function run() {
  errEl.textContent = '';
  tbody.innerHTML = '';
  svg.innerHTML = '';
  let env;
  try {
    env = JSON.parse(expand_it(src.value, startEl.value, endEl.value, LIBS));
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
  const events = env.result.events;
  const t0 = parseTime(startEl.value);
  const t1 = parseTime(endEl.value);
  const W = 1000, H = 90;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  axis.setAttribute('x1', 10); axis.setAttribute('x2', W - 10);
  axis.setAttribute('y1', H / 2); axis.setAttribute('y2', H / 2);
  axis.setAttribute('stroke', '#999');
  svg.appendChild(axis);
  for (const e of events) {
    const t = parseTime(e.time);
    const x = 10 + ((t - t0) / (t1 - t0)) * (W - 20);
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', H / 2); c.setAttribute('r', 5);
    c.setAttribute('fill', e.action === 'depart' ? '#0a0' : e.action === 'arrive' ? '#06c' : '#888');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${e.time} ${e.action} ${e.point}`;
    c.appendChild(title);
    svg.appendChild(c);
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

await init();
run();
