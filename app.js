import init, { expand_timeline } from './pkg/playground.js';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, Decoration } from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { tags } from '@lezer/highlight';

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

// --- подсветка cyclo (зеркало cyclo_lexer.py / grammar.pest) ---
const DECLARATION = new Set(["schedule","use","const","fun","pred","time_const","point","actions","attrs","cycle","routine","root_cycle","start_time","duration","reverse"]);
const MODIFIER = new Set(["repeat","fill","until","gaps","and","or","not","floordiv","floormod"]);
const BOOL = new Set(["true","false"]);

const cycloLanguage = StreamLanguage.define({
  token(stream, state) {
    if (state.inString) {
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '"' && !escaped) { state.inString = false; break; }
        escaped = ch === '\\' && !escaped;
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match('"')) { state.inString = true; return "string"; }
    if (stream.match(/^\d+(?:st|nd|rd|th)\b/)) return "number";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:ms|[smhdw])/)) return "number";
    if (stream.match(/^-?\d+(?:\.\d+)?\b/)) return "number";
    if (stream.match(/^\.[A-Za-z_][A-Za-z0-9_]*/)) return "variable";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const cur = stream.current();
      if (DECLARATION.has(cur) || MODIFIER.has(cur)) return "keyword";
      if (BOOL.has(cur)) return "atom";
      if (/^[A-Z_][A-Z0-9_]*$/.test(cur)) {
        const rest = stream.string.slice(stream.pos);
        if (/^\s*\(/.test(rest)) return "def";
        return "type";
      }
      const rest = stream.string.slice(stream.pos);
      if (/^\s*\(/.test(rest)) return "def";
      return "variable";
    }
    if (stream.match(/^(==|!=|<=|>=|<<|>>)/)) return "operator";
    if (stream.match(/^[-+*/%<>|&^!=]/)) return "operator";
    if (stream.match(/^[:;,.\(\)\{\}\[\]]/)) return "punctuation";
    stream.next();
    return null;
  },
  startState() { return { inString: false }; }
});

const cycloHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.comment, color: "#008000", fontStyle: "italic" },
  { tag: tags.string, color: "#a31515" },
  { tag: tags.number, color: "#098658" },
  { tag: tags.atom, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.typeName, color: "#267f99" },
  { tag: tags.definition(tags.variableName), color: "#795e26" },
  { tag: tags.variableName, color: "#001080" },
  { tag: tags.operator, color: "#000000" },
  { tag: tags.punctuation, color: "#000000" },
]);

const errorLineEffect = StateEffect.define();
const errorLineField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(errorLineEffect)) {
      if (e.value == null) return Decoration.none;
      const line = tr.state.doc.line(e.value);
      return Decoration.set([Decoration.line({ attributes: { class: "cm-errorLine" } }).range(line.from)]);
    }
    if (tr.docChanged) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f)
});

const NS = 'http://www.w3.org/2000/svg';
const startEl = document.getElementById('start');
const endEl = document.getElementById('end');
const errEl = document.getElementById('error');
const svg = document.getElementById('timeline');
const tbody = document.getElementById('events');

const editor = new EditorView({
  state: EditorState.create({
    doc: DEFAULT_SRC,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      cycloLanguage,
      syntaxHighlighting(cycloHighlight),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      errorLineField,
    ]
  }),
  parent: document.getElementById('editor')
});

function getSrc() { return editor.state.doc.toString(); }

function selectLine(n) {
  if (n < 1 || n > editor.state.doc.lines) return;
  const line = editor.state.doc.line(n);
  editor.dispatch({
    selection: { anchor: line.from, head: line.to },
    effects: errorLineEffect.of(n),
    scrollIntoView: true
  });
  editor.focus();
}

function clearErrorLine() {
  editor.dispatch({ effects: errorLineEffect.of(null) });
}

// Окно по умолчанию — сегодня/завтра (UTC-день: движок наивный, parseTime
// считает ввод через Date.UTC). Вшитые в HTML январские даты протухают,
// как только в редактор вставляют неянварское расписание (ноль событий
// при живом движке) — поэтому дефолт всегда динамический.
{
  const now = new Date(Date.now());
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const p = (n) => String(n).padStart(2, '0');
  const iso = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T00:00`;
  };
  startEl.value = iso(day);
  endEl.value = iso(day + 86400e3);
}

// Видимая область (зум/пан), границы стартового окна и границы
// реально посчитанных данных; обновляются при каждом run().
let tView = null;
let dataWin = null;
let fetched = null;
let lastRes = null;
let fetchTimer = null;

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
  clearErrorLine();
  tbody.innerHTML = '';
  svg.innerHTML = '';
  let env;
  try {
    env = JSON.parse(expand_timeline(getSrc(), windowInput(startEl), windowInput(endEl), LIBS));
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
  const w0 = parseTime(windowInput(startEl));
  const w1 = parseTime(windowInput(endEl));
  if (!(w0 < w1)) {
    errEl.textContent = 'окно пустое: end должен быть позже start';
    return;
  }
  dataWin = { t0: w0, t1: w1 };
  fetched = { t0: w0, t1: w1 };
  tView = { t0: w0, t1: w1 };
  draw(env.result);
}

// Докачка: если вид вылез за посчитанное — пересчитать окно
// view ± 100% запас. Вызывается с дебаунсом после жестов.
function ensureData() {
  if (!tView || !fetched || !lastRes) return;
  if (tView.t0 >= fetched.t0 && tView.t1 <= fetched.t1) return;
  const span = tView.t1 - tView.t0;
  const s = Math.floor((tView.t0 - span) / 1000) * 1000;
  const e = Math.ceil((tView.t1 + span) / 1000) * 1000;
  let env;
  try {
    env = JSON.parse(expand_timeline(getSrc(), formatTime(s), formatTime(e), LIBS));
  } catch {
    return;
  }
  if (!env.ok) return;
  fetched = { t0: s, t1: e };
  draw(env.result);
}

function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(ensureData, 300);
}

function formatTime(ms) {
  // Границы докачки — с точностью до секунд.
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// Шаг линейки: первый, при котором подписи не ближе 70px.
const STEPS = [60e3, 300e3, 900e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
function chooseStep(spanMs, pxPerMs) {
  for (const s of STEPS) {
    if (s * pxPerMs >= 70) return s;
  }
  return STEPS[STEPS.length - 1];
}

function tickLabel(ms, step) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return step >= 12 * 3600e3 ? `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${hm}` : hm;
}

function drawRuler(t0, t1, X, W, h) {
  const pxPerMs = (W - 44 - 10) / (t1 - t0);
  const step = chooseStep(t1 - t0, pxPerMs);
  el('line', { x1: 44, x2: W - 10, y1: h, y2: h, stroke: '#999' }, svg);
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = X(t);
    el('line', { x1: x, x2: x, y1: h - 8, y2: h, stroke: '#999' }, svg);
    const label = el('text', { x: x + 3, y: h - 10, 'font-size': 10, fill: '#555' }, svg);
    label.textContent = tickLabel(t, step);
  }
  const minor = step / 5;
  if (minor * pxPerMs >= 4) {
    for (let t = Math.ceil(t0 / minor) * minor; t <= t1; t += minor) {
      if (t % step === 0) continue;
      const x = X(t);
      el('line', { x1: x, x2: x, y1: h - 4, y2: h, stroke: '#bbb' }, svg);
    }
  }
  // Верхний уровень — даты: подпись на каждой полуночи UTC в виде.
  const day = 86400e3;
  for (let t = Math.ceil(t0 / day) * day; t <= t1; t += day) {
    const x = X(t);
    el('line', { x1: x, x2: x, y1: 0, y2: h, stroke: '#999' }, svg);
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    const label = el('text', { x: x + 3, y: 10, 'font-size': 10, fill: '#333' }, svg);
    label.textContent = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`;
  }
}

function draw(res) {
  lastRes = res;
  // Очистка здесь, а не только в run(): redraw при зуме/пане тоже идёт сюда.
  svg.innerHTML = '';
  tbody.innerHTML = '';
  const { t0, t1 } = tView;
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
  const W = 1000, LABEL = 44, LANE_H = 40, PAD = 10, RULER_H = 30;
  const H = RULER_H + PAD + Math.max(ntracks, 1) * LANE_H + PAD;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const X = (t) => LABEL + ((t - t0) / (t1 - t0)) * (W - LABEL - PAD);
  const Y = (ti) => RULER_H + PAD + ti * LANE_H;
  drawRuler(t0, t1, X, W, RULER_H);
  for (let ti = 0; ti < ntracks; ti++) {
    const y = Y(ti);
    const label = el('text', { x: 4, y: y + LANE_H / 2 + 4, 'font-size': 12 }, svg);
    label.textContent = 'T' + (ti + 1);
    el('line', { x1: LABEL, x2: W - PAD, y1: y + LANE_H, y2: y + LANE_H, stroke: '#ddd' }, svg);
  }
  const clipX = (t) => Math.min(Math.max(X(t), LABEL), W - PAD);
  for (const s of res.spans) {
    const ti = trackOf.get(s.cycle + '|' + s.start + '|' + s.end);
    const y = Y(ti);
    const root = s.cycle === 'root_cycle';
    const x0 = clipX(parseTime(s.start)), x1 = clipX(parseTime(s.end));
    if (x1 <= LABEL || x0 >= W - PAD) continue;
    const r = el('rect', {
      x: x0,
      y: y + 5,
      width: Math.max(x1 - x0, 3),
      height: LANE_H - 10,
      rx: 3,
      fill: root ? '#eee' : '#cde6ff',
      stroke: root ? '#ccc' : '#69c',
    }, svg);
    const title = el('title', {}, r);
    title.textContent = `${s.cycle} ${s.start} — ${s.end}`;
    // Подпись цикла — только если блок достаточно широк (мелкий шрифт).
    if (x1 - x0 >= s.cycle.length * 6 + 8) {
      const name = el('text', { x: x0 + 4, y: y + LANE_H / 2 + 3, 'font-size': 10, fill: '#333' }, svg);
      name.textContent = s.cycle;
    }
  }
  // Подписи действий у точек — только если не слипаются с соседом.
  let lastLabelX = -Infinity;
  // Таблица — только видимые события (данные могут быть шире вида).
  const inView = res.events.filter((e) => {
    const t = parseTime(e.time);
    return t >= t0 && t < t1;
  });
  for (const e of inView) {
    const ti = trackOf.get(e.span.cycle + '|' + e.span.start + '|' + e.span.end);
    const x = X(parseTime(e.time));
    if (x < LABEL || x > W - PAD) continue;
    const y = Y(ti === undefined ? 0 : ti) + LANE_H / 2;
    const c = el('circle', {
      cx: X(parseTime(e.time)), cy: y, r: 5,
      fill: e.action === 'depart' ? '#0a0' : e.action === 'arrive' ? '#06c' : '#888',
      stroke: '#fff',
    }, svg);
    const title = el('title', {}, c);
    const attrsText = [e.point_attrs, e.action_attrs]
      .map((a) => JSON.stringify(a))
      .filter((s) => s !== '{}')
      .join(' ');
    title.textContent = `${e.time} ${e.action} ${e.point} [${e.span.cycle}]` +
      (attrsText ? ` ${attrsText}` : '');
    if (x - lastLabelX >= 55) {
      const lab = el('text', { x: x + 7, y: y + 3, 'font-size': 9, fill: '#333' }, svg);
      lab.textContent = e.action;
      lastLabelX = x;
    }
    const tr = document.createElement('tr');
    for (const k of ['time', 'action', 'point']) {
      const td = document.createElement('td');
      td.textContent = e[k];
      tr.appendChild(td);
    }
    for (const k of ['point_attrs', 'action_attrs']) {
      const td = document.createElement('td');
      td.textContent = JSON.stringify(e[k]);
      td.style.fontSize = '11px';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// Навигация: колесо — зум к курсору, shift+колесо — скролл,
// drag — пан, двойной клик — сброс к окну. Вид бесконечный, данные
// докачиваются дебаунсом после жеста. Единственный предел —
// минимальный масштаб (минута).
const MIN_SPAN = 60e3;
function normView() {
  const c = (tView.t0 + tView.t1) / 2;
  const s = Math.max(tView.t1 - tView.t0, MIN_SPAN);
  tView = { t0: c - s / 2, t1: c + s / 2 };
}

// Применить жест: мгновенная трансформация + отложенная докачка.
function navigate(mut) {
  if (!tView || !lastRes) return;
  mut();
  normView();
  redraw();
  scheduleFetch();
}

function redraw() {
  if (lastRes) draw(lastRes);
}

function svgMs(clientX) {
  const rect = svg.getBoundingClientRect();
  const W = 1000;
  const x = (clientX - rect.left) * (W / rect.width);
  return tView.t0 + ((x - 44) / (W - 44 - 10)) * (tView.t1 - tView.t0);
}

function zoomAt(clientX, dir) {
  const anchor = svgMs(clientX);
  const f = dir > 0 ? 1.25 : 1 / 1.25;
  navigate(() => {
    const span = (tView.t1 - tView.t0) * f;
    const k = (anchor - tView.t0) / (tView.t1 - tView.t0);
    tView = { t0: anchor - span * k, t1: anchor + span * (1 - k) };
  });
}

function initNav() {
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (!tView || !lastRes) return;
    if (ev.shiftKey) {
      const dx = ev.deltaY * ((tView.t1 - tView.t0) / 500);
      navigate(() => {
        tView = { t0: tView.t0 + dx, t1: tView.t1 + dx };
      });
    } else {
      zoomAt(ev.clientX, ev.deltaY);
    }
  }, { passive: false });
  let x0 = null;
  svg.addEventListener('mousedown', (ev) => { ev.preventDefault(); x0 = ev.clientX; });
  svg.addEventListener('mousemove', (ev) => {
    if (x0 === null || !tView || !lastRes) return;
    const rect = svg.getBoundingClientRect();
    const dx = (ev.clientX - x0) * ((tView.t1 - tView.t0) / rect.width);
    x0 = ev.clientX;
    navigate(() => {
      tView = { t0: tView.t0 - dx, t1: tView.t1 - dx };
    });
  });
  svg.addEventListener('mouseup', () => { x0 = null; });
  svg.addEventListener('mouseleave', () => { x0 = null; });
  svg.addEventListener('dblclick', () => {
    navigate(() => {
      tView = { t0: dataWin.t0, t1: dataWin.t1 };
    });
  });
  document.getElementById('zoom-in').addEventListener('click', () => {
    navigate(() => {
      const c = (tView.t0 + tView.t1) / 2;
      tView = { t0: c - (c - tView.t0) / 1.5, t1: c + (tView.t1 - c) / 1.5 };
    });
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    navigate(() => {
      const c = (tView.t0 + tView.t1) / 2;
      tView = { t0: c - (c - tView.t0) * 1.5, t1: c + (tView.t1 - c) * 1.5 };
    });
  });
  document.getElementById('zoom-reset').addEventListener('click', () => {
    navigate(() => {
      tView = { t0: dataWin.t0, t1: dataWin.t1 };
    });
  });
}

document.getElementById('run').addEventListener('click', run);
startEl.addEventListener('change', run);
endEl.addEventListener('change', run);
initNav();

await init();
run();
