// Плагин-синтезатор для плейграунда (по умолчанию выключен, грузится
// лениво через `await import('./plugins/synth.js')` при включении в меню).
//
// Контракт расписания (ядро уже отдаёт attrs как есть, см. таблицу событий;
// словари — через `:`, как в JSON):
//   point LEAD {
//     actions = [note_on, note_off];
//     attrs = {"wave": "sawtooth", "attack": 5, "release": 200, "volume": 0.8};
//   }
//   point HAT {
//     actions = [note_on, note_off];
//     attrs = {"wave": "noise", "filter": "highpass", "cutoff": 7000, "release": 20, "volume": 0.3};
//   }
//   0s: LEAD.note_on() {"freq": 440};
//   1s: LEAD.note_off();
// `action` — note_on/note_off, `point` — голос (полифония по разным `point`).
// Высота — из `action_attrs` с fallback на `point_attrs`:
// freq (Гц) → midi (69 = A4) → note ("A4").
// Тембр голоса — из `point_attrs`, читается в момент `note_on`:
// wave (sine|triangle|square|sawtooth|noise, иначе sine), attack/release (мс,
// по умолчанию 10/100), volume (0..1, по умолчанию 1, умножается на мастер).
// Шум — зацикленный буфер белого шума: высота игнорируется, но pitch обязан
// быть (нужен паре on/off); filter (lowpass|highpass) + cutoff (Гц) —
// опциональный BiquadFilter, действует только на шум.
//
// Расписание бесконечно (`root_cycle` повторяется вечно), поэтому звук —
// поток: плагин тянет события батчами через `nextEvents` (WASM `next_steps`)
// и играет строго в realtime (1 мс шкалы = 1 мс аудио), пока не нажали Stop.
// Парность note_on/note_off сквозная через батчи; висячий on тянется до off.
//
// Использование (app.js):
//   const { initSynth } = await import('./plugins/synth.js');
//   const synth = initSynth({
//     parseTime,
//     nextEvents: (from, withinMs, n) =>
//       JSON.parse(next_steps(getSrc(), from, withinMs, n, libsJson())),
//     startFrom: () => windowInput(startEl),
//   });
//   // в конце draw(): synth.update(inView, { t0, t1 });  // только статус
//
// Чистые функции pairNotes/pitchToFreq/noteNameToFreq/voiceParams
// экспортированы для тестов.

const SEMI = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const TICK_MS = 200;            // период планировщика
const LOOKAHEAD_SEC = 2;        // запас аудио, который стараемся держать
const N_EVENTS = 512;           // событий за один запрос к движку
const MAX_BATCHES_PER_TICK = 6; // запросов за тик (защита от вечного цикла)
const MIN_WITHIN_MS = 1000;
const MAX_WITHIN_MS = 366 * 86400000;
const IDLE_STOP_MS = 15000;     // пусто и тихо столько — прекращаем поток

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// "A4" → частота. Возвращает null если не разобралось.
export function noteNameToFreq(name) {
  if (typeof name !== 'string') return null;
  const m = name.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const key = m[1].toUpperCase() + m[2];
  if (!(key in SEMI)) return null;
  const midi = (Number(m[3]) + 1) * 12 + SEMI[key];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// attrs пары + point_attrs → { freq, key }. key — для пейринга on/off.
export function pitchToFreq(actionAttrs, pointAttrs) {
  const a = actionAttrs && typeof actionAttrs === 'object' ? actionAttrs : {};
  const p = pointAttrs && typeof pointAttrs === 'object' ? pointAttrs : {};
  const f = num(a.freq ?? p.freq);
  if (f !== null && f > 0) return { freq: f, key: `f:${f}` };
  const m = num(a.midi ?? p.midi);
  if (m !== null) {
    const freq = 440 * Math.pow(2, (m - 69) / 12);
    if (freq > 0) return { freq, key: `m:${m}` };
  }
  const n = a.note ?? p.note;
  const nf = noteNameToFreq(n);
  if (nf !== null) return { freq: nf, key: `n:${String(n).trim()}` };
  return null;
}

// Тембр голоса из point_attrs (читается в момент note_on):
// wave — sine|triangle|square|sawtooth|noise (иначе sine);
// attack/release — миллисекунды (по умолчанию 10/100), volume — 0..1;
// filter — lowpass|highpass (иначе без фильтра), cutoff — Гц (>0).
// Шум: высота игнорируется звуком, но pitch остаётся обязательным
// для пары on/off. Фильтр действует только на шум.
export function voiceParams(pointAttrs) {
  const p = pointAttrs && typeof pointAttrs === 'object' ? pointAttrs : {};
  const w = typeof p.wave === 'string' ? p.wave : 'sine';
  const wave = w === 'sine' || w === 'triangle' || w === 'square' || w === 'sawtooth' || w === 'noise'
    ? w
    : 'sine';
  const atk = num(p.attack);
  const rel = num(p.release);
  const vol = num(p.volume);
  const f = typeof p.filter === 'string' ? p.filter : null;
  const cut = num(p.cutoff);
  return {
    wave,
    attack: atk !== null && atk >= 0 ? atk / 1000 : 0.01,
    release: rel !== null && rel >= 0 ? rel / 1000 : 0.1,
    volume: vol !== null ? Math.min(1, Math.max(0, vol)) : 1,
    filter: wave === 'noise' && (f === 'lowpass' || f === 'highpass') ? f : null,
    cutoff: wave === 'noise' && cut !== null && cut > 0 ? cut : null,
  };
}

// События движка → ноты { point, freq, t0, t1 } (мс).
// view = { t0, t1 } — границы вида; висячий note_on закрывается
// концом вида (кап maxDurMs). Возвращает { notes, danglingOn, orphanOff, noPitch }.
// Чистая функция; потоковый режим использует сквозной пейринг ниже.
export function pairNotes(events, parseTime, view, maxDurMs = 5000) {
  const sorted = [...events].sort((x, y) => parseTime(x.time) - parseTime(y.time));
  const open = new Map(); // point → стек открытых
  const notes = [];
  let danglingOn = 0;
  let orphanOff = 0;
  let noPitch = 0;
  for (const e of sorted) {
    if (e.action !== 'note_on' && e.action !== 'note_off') continue;
    const t = parseTime(e.time);
    if (!Number.isFinite(t)) continue;
    const stack = open.get(e.point) ?? [];
    open.set(e.point, stack);
    if (e.action === 'note_on') {
      const pitch = pitchToFreq(e.action_attrs, e.point_attrs);
      if (!pitch) {
        noPitch++;
        continue;
      }
      stack.push({ key: pitch.key, freq: pitch.freq, t0: t, point: e.point });
    } else {
      if (stack.length === 0) {
        orphanOff++;
        continue;
      }
      const pitch = pitchToFreq(e.action_attrs, e.point_attrs);
      let idx;
      if (pitch) idx = stack.map((o) => o.key).lastIndexOf(pitch.key);
      else idx = stack.length - 1;
      if (idx < 0) {
        orphanOff++;
        continue;
      }
      const [o] = stack.splice(idx, 1);
      if (t > o.t0) notes.push({ point: o.point, freq: o.freq, t0: o.t0, t1: t });
    }
  }
  const endCap = view && Number.isFinite(view.t1) ? view.t1 : null;
  for (const stack of open.values()) {
    for (const o of stack) {
      danglingOn++;
      const cap = Math.min(endCap ?? o.t0 + maxDurMs, o.t0 + maxDurMs);
      if (cap > o.t0) notes.push({ point: o.point, freq: o.freq, t0: o.t0, t1: cap });
    }
  }
  notes.sort((a, b) => a.t0 - b.t0);
  return { notes, danglingOn, orphanOff, noPitch };
}

export function initSynth({ parseTime, nextEvents, startFrom }) {
  const $ = (id) => document.getElementById(id);
  const playBtn = $('synth-play');
  // Панели нет (напр. тесты) — тихая заглушка, чтобы app.js не падал.
  if (!playBtn) return { update() {}, play() {}, stop() {} };

  const stopBtn = $('synth-stop');
  const volEl = $('synth-vol');
  const statusEl = $('synth-status');

  let ctx = null;
  let master = null;
  let current = { notes: [], danglingOn: 0, orphanOff: 0, noPitch: 0 };

  // Поток.
  let playing = false;
  let cursor = null;        // ISO-курсор следующего запроса
  let axisBase = null;      // мс шкалы, от которых считается аудио
  let audioBase = 0;        // ctx.currentTime, соответствующий axisBase
  const rate = 0.001;       // realtime: 1 мс шкалы = 1 мс аудио
  let frontier = null;      // мс шкалы последнего полученного события
  let lastEventWall = 0;    // Date.now() последнего события (для idle-стопа)
  const openByPoint = new Map(); // point → стек { key, freq, t0, voice }
  const live = new Set();        // { osc, gain }
  let tickTimer = null;
  let stat = { notes: 0, orphanOff: 0, noPitch: 0 };

  function setStatus(extra = '') {
    if (!playing) {
      const bits = [`в зоне нот: ${current.notes.length}`];
      if (current.danglingOn) bits.push(`висячих on: ${current.danglingOn}`);
      if (extra) bits.push(extra);
      statusEl.textContent = bits.join(' · ');
      return;
    }
    const bits = [`▶ играет, нот: ${stat.notes}`];
    if (openByPoint.size) bits.push(`открытых голосов: ${openByPoint.size}`);
    if (stat.orphanOff) bits.push(`off без пары: ${stat.orphanOff}`);
    if (stat.noPitch) bits.push(`on без pitch: ${stat.noPitch}`);
    if (extra) bits.push(extra);
    statusEl.textContent = bits.join(' · ');
  }

  function update(events, v) {
    current = pairNotes(events, parseTime, v ?? null);
    if (!playing) setStatus();
  }

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    const v = Math.min(100, Math.max(0, Number(volEl.value ?? 70))) / 100;
    master.gain.setTargetAtTime(v * v, ctx.currentTime, 0.02);
    return ctx;
  }

  const audioOf = (axisMs) => audioBase + (axisMs - axisBase) * rate;

  let noiseBuf = null; // общий буфер белого шума (2 с, loop)

  function getNoiseBuf() {
    if (!noiseBuf) {
      const len = Math.max(1, Math.floor(ctx.sampleRate * 2));
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  // Голос стартует по note_on: атака в момент t0, дальше sustain до релиза.
  // Тембр — из point_attrs ноты (voiceParams), пик огибающей — volume голоса
  // (мастер применяется отдельно на master). Шум — зацикленный буфер через
  // опциональный фильтр; поле голоса всё равно `osc`, чтобы releaseVoice
  // и stop() работали без ветвлений (у сорса те же stop/disconnect).
  function makeVoice(freq, t0Axis, vp) {
    const start = Math.max(ctx.currentTime + 0.005, audioOf(t0Axis));
    const atk = Math.max(0, vp.attack);
    const g = ctx.createGain();
    g.gain.value = 0;
    let osc;
    if (vp.wave === 'noise') {
      osc = ctx.createBufferSource();
      osc.buffer = getNoiseBuf();
      osc.loop = true;
      let head = osc;
      if (vp.filter && vp.cutoff) {
        const flt = ctx.createBiquadFilter();
        flt.type = vp.filter;
        flt.frequency.value = vp.cutoff;
        flt.Q.value = 0.7;
        osc.connect(flt);
        head = flt;
      }
      head.connect(g);
    } else {
      osc = ctx.createOscillator();
      osc.type = vp.wave;
      osc.frequency.value = freq;
      osc.connect(g);
    }
    g.connect(master);
    if (atk > 0) {
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vp.volume, start + atk);
    } else {
      g.gain.setValueAtTime(vp.volume, start);
    }
    osc.start(start);
    const v = { osc, gain: g, release: Math.max(0.02, vp.release) };
    live.add(v);
    return v;
  }

  function releaseVoice(v, atSec) {
    const at = Math.max(ctx.currentTime + 0.005, atSec);
    const rel = v.release;
    try {
      if (typeof v.gain.gain.cancelAndHoldAtTime === 'function') {
        v.gain.gain.cancelAndHoldAtTime(at);
      } else {
        v.gain.gain.cancelScheduledValues(at);
      }
      v.gain.gain.linearRampToValueAtTime(0, at + rel);
      v.osc.stop(at + rel + 0.05);
    } catch {
      // Уже остановлен — неважно.
    }
    live.delete(v);
    setTimeout(() => {
      try {
        v.osc.disconnect();
        v.gain.disconnect();
      } catch {
        // Не подключён — неважно.
      }
    }, Math.max(0, (at + rel + 0.2 - ctx.currentTime) * 1000));
  }

  // Сквозной пейринг: on открывает голос, off его закрывает (через батчи).
  function consume(events) {
    for (const e of events) {
      if (e.action !== 'note_on' && e.action !== 'note_off') continue;
      const t = parseTime(e.time);
      if (!Number.isFinite(t)) continue;
      if (axisBase === null) {
        axisBase = t;
        audioBase = ctx.currentTime + 0.08;
      }
      if (frontier === null || t > frontier) frontier = t;
      lastEventWall = Date.now();
      const stack = openByPoint.get(e.point) ?? [];
      openByPoint.set(e.point, stack);
      if (e.action === 'note_on') {
        const pitch = pitchToFreq(e.action_attrs, e.point_attrs);
        if (!pitch) {
          stat.noPitch++;
          continue;
        }
        const vp = voiceParams(e.point_attrs);
        stack.push({ key: pitch.key, freq: pitch.freq, t0: t, voice: makeVoice(pitch.freq, t, vp) });
      } else {
        if (stack.length === 0) {
          stat.orphanOff++;
          continue;
        }
        const pitch = pitchToFreq(e.action_attrs, e.point_attrs);
        let idx;
        if (pitch) idx = stack.map((o) => o.key).lastIndexOf(pitch.key);
        else idx = stack.length - 1;
        if (idx < 0) {
          stat.orphanOff++;
          continue;
        }
        const [o] = stack.splice(idx, 1);
        releaseVoice(o.voice, audioOf(t));
        stat.notes++;
      }
    }
  }

  function fetchBatch() {
    const within = Math.min(
      MAX_WITHIN_MS,
      Math.max(MIN_WITHIN_MS, Math.round(LOOKAHEAD_SEC / rate)),
    );
    const res = nextEvents(cursor, within, N_EVENTS);
    if (!res || !res.ok) {
      const d = res && res.diag;
      setStatus('движок: ' + (d ? (d.code ? d.code + ' ' : '') + d.text : 'ошибка'));
      stop();
      return false;
    }
    const events = res.result.events || [];
    consume(events);
    cursor = res.result.next || cursor;
    if (events.length === 0 && live.size === 0 && Date.now() - lastEventWall > IDLE_STOP_MS) {
      setStatus('нет событий note_on/note_off');
      stop();
      return false;
    }
    return true;
  }

  function tick() {
    if (!playing) return;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      if (frontier !== null && audioOf(frontier) >= ctx.currentTime + LOOKAHEAD_SEC) break;
      if (!fetchBatch()) return;
    }
    setStatus();
  }

  function play() {
    if (!nextEvents || !startFrom) {
      setStatus('плагин не подключён к движку');
      return;
    }
    stop(true);
    const ac = ensureCtx();
    playing = true;
    cursor = startFrom();
    axisBase = null;
    audioBase = ac.currentTime + 0.08;
    frontier = null;
    lastEventWall = Date.now();
    stat = { notes: 0, orphanOff: 0, noPitch: 0 };
    openByPoint.clear();
    setStatus();
    tickTimer = setInterval(tick, TICK_MS);
    tick();
  }

  function stop(silent = false) {
    playing = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    for (const v of live) {
      try {
        v.gain.gain.cancelScheduledValues(0);
        v.gain.gain.setTargetAtTime(0, ctx ? ctx.currentTime : 0, 0.01);
        v.osc.stop((ctx ? ctx.currentTime : 0) + 0.05);
      } catch {
        // Уже остановлен — неважно.
      }
      try {
        v.osc.disconnect();
        v.gain.disconnect();
      } catch {
        // Не подключён — неважно.
      }
    }
    live.clear();
    openByPoint.clear();
    cursor = null;
    if (!silent) setStatus();
  }

  playBtn.addEventListener('click', play);
  stopBtn.addEventListener('click', () => stop());
  volEl.addEventListener('input', () => {
    if (ctx && master) {
      const v = Math.min(100, Math.max(0, Number(volEl.value))) / 100;
      master.gain.setTargetAtTime(v * v, ctx.currentTime, 0.02);
    }
  });

  setStatus('нажми Развернуть, затем Play');
  return { update, play, stop };
}
