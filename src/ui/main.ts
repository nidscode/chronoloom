import './style.css';
import {
  analyze,
  Cursor,
  LoomRuntimeError,
  LoomSyntaxError,
  Multiverse,
  tryEvaluate,
  type Diagnostic,
  type Timeline,
  type VMState,
} from '../core';
import { EXAMPLES, findExample } from '../examples';
import { ChartPanel } from './chart';
import { DataPanel } from './data';
import { h, toast } from './dom';
import { createEditor } from './editor';
import { FlameChart } from './flame';
import { HELP_HTML } from './help';
import { inlineHints, StackPanel, VariablesPanel, type InspectContext } from './inspect';
import { MultiversePanel } from './multiverse';
import { OutputPanel } from './output';
import { BreakpointsPanel, ConsolePanel, ProfilePanel, WatchPanel } from './panels';

// ------------------------------------------------------------------ state

interface App {
  mv: Multiverse | null;
  cursor: Cursor | null;
  frameIndex: number | null; // null = follow the top frame
  chartVar: string | null;
  selectedLine: number | null;
  highlightFn: number | null;
  playing: boolean;
  dirty: boolean;
  compileError: { message: string; line: number } | null;
  find: { expr: string; tl: Timeline; matches: number[] } | null;
}

const app: App = {
  mv: null,
  cursor: null,
  frameIndex: null,
  chartVar: null,
  selectedLine: null,
  highlightFn: null,
  playing: false,
  dirty: false,
  compileError: null,
  find: null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const STORAGE_KEY = 'chronoloom:code';
const storage = {
  get(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(v: string) {
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* storage unavailable: fine */
    }
  },
};

// ---------------------------------------------------------- share links

function encodeCode(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCode(s: string): string | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function initialCode(): { code: string; example: string | null; step: number | null } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const stepParam = hash.get('step');
  const step = stepParam !== null && /^\d+$/.test(stepParam) ? Number(stepParam) : null;
  const shared = hash.get('code');
  if (shared) {
    const code = decodeCode(shared);
    if (code !== null) return { code, example: null, step };
  }
  const ex = hash.get('example');
  if (ex && findExample(ex)) return { code: findExample(ex)!.code, example: ex, step };
  const saved = storage.get();
  if (saved && saved.trim()) return { code: saved, example: null, step: null };
  return { code: EXAMPLES[0].code, example: EXAMPLES[0].id, step: null };
}

// ------------------------------------------------------- static analysis

let diagCache: { code: string; diags: Diagnostic[] } = { code: '\0', diags: [] };
function diagnostics(code: string): Diagnostic[] {
  if (diagCache.code !== code) diagCache = { code, diags: analyze(code) };
  return diagCache.diags;
}

// ------------------------------------------------------------- widgets

const start = initialCode();

const editor = createEditor($('editor'), start.code, {
  onChange: onCodeChange,
  onRun: () => runProgram({ keepPos: false }),
  onHeatClick: jumpToLine,
  onBreakpointsChange: () => {
    renderBreakpoints();
  },
  diagnostics: (code) => {
    const d = diagnostics(code);
    queueMicrotask(renderStatus);
    return d;
  },
  hover: (expr) => {
    const c = app.cursor;
    const mv = app.mv;
    if (!c || !mv || app.dirty) return null;
    const r = tryEvaluate(mv.vm, c.state, currentFrame(), expr);
    if (!('value' in r)) return null;
    const text = mv.vm.format(c.state, r.value, true);
    return text.length > 400 ? text.slice(0, 399) + '…' : text;
  },
});

const flame = new FlameChart($<HTMLCanvasElement>('flame'), $('flame-tip'), (p) => seek(p));

const vars = new VariablesPanel($('vars'), $('banner'), {
  prevChange(name, envId, value) {
    const c = app.cursor!;
    const w = c.tl.previousChange(c.pos, name, envId, value);
    if (!w) return toast(`No earlier change to ${name}`);
    seek(w.pos, { flash: true });
    toast(w.kind === 'fork' ? `${name} was set here by a fork` : `${name} changes on line ${c.tl.lineAt(w.pos)}`);
  },
  nextChange(name, envId, value) {
    const c = app.cursor!;
    const w = c.tl.nextChange(c.pos, name, envId, value);
    if (!w) return toast(`No later change to ${name}`);
    seek(w.pos, { flash: true });
    toast(`${name} changes on line ${c.tl.lineAt(w.pos)}`);
  },
  chart(name) {
    app.chartVar = app.chartVar === name ? null : name;
    if (app.chartVar) activateTab('bottom', 'history');
    render();
  },
  fork(name, source) {
    const c = app.cursor!;
    const mv = app.mv!;
    try {
      const tl = mv.fork(c.tl, c.pos, currentFrame(), name, source);
      app.cursor!.seek(c.pos, tl);
      app.frameIndex = null;
      vars.cancelEdit();
      refreshFind();
      render();
      const div = tl.divergence();
      toast(`Created timeline #${tl.id} (${tl.label}). ${div === null ? 'Output is unchanged.' : `Output differs from line ${div + 1}.`}`);
      return null;
    } catch (e) {
      if (e instanceof LoomSyntaxError || e instanceof LoomRuntimeError || e instanceof Error) return e.message;
      return String(e);
    }
  },
});

const watch = new WatchPanel($('watch'), (expr) => {
  ($('find-input') as HTMLInputElement).value = expr;
  runFind(1);
});
const stack = new StackPanel($('stack'), (i) => {
  app.frameIndex = i;
  render();
});
const data = new DataPanel($('data'));
const output = new OutputPanel($('output'), $('output-count'), (p) => seek(p, { flash: true }));
const multiverse = new MultiversePanel($('multiverse'), (tl) => {
  const c = app.cursor!;
  const p = Math.min(c.pos, tl.endPos);
  stopPlaying();
  c.seek(p, tl);
  app.frameIndex = null;
  refreshFind();
  render();
});
const chart = new ChartPanel($('chart'), $('chart-title'), (p) => seek(p));
const profile = new ProfilePanel($('profile'), (row) => {
  const c = app.cursor;
  if (!c) return;
  app.highlightFn = app.highlightFn === row.fn ? null : row.fn;
  const first = c.tl.calls.find((x) => x.fn === row.fn);
  if (app.highlightFn !== null && first) seek(first.s);
  else render();
});
const breakpointsPanel = new BreakpointsPanel($('breakpoints'), () => editor);
const consolePanel = new ConsolePanel(
  $('console'),
  () => (app.cursor && app.mv && !app.dirty ? { mv: app.mv, tl: app.cursor.tl, pos: app.cursor.pos, frameIndex: currentFrame() } : null),
  (tlId, pos) => {
    const tl = app.mv?.timelines[tlId];
    if (!tl || !app.cursor) return;
    app.cursor.seek(pos, tl);
    app.frameIndex = null;
    render();
  },
);

function currentFrame(): number {
  const c = app.cursor;
  if (!c) return 0;
  const top = c.state.frames.length - 1;
  return app.frameIndex !== null && app.frameIndex <= top ? app.frameIndex : top;
}

// ------------------------------------------------------------- running

function runProgram(opts: { keepPos: boolean }) {
  stopPlaying();
  const code = editor.getCode();
  storage.set(code);
  const prevPos = app.cursor?.pos ?? 0;
  data.setSource(code);
  try {
    const mv = new Multiverse(code, { maxEvents: 100_000 });
    app.mv = mv;
    app.cursor = new Cursor(mv, mv.root);
    app.compileError = null;
    app.dirty = false;
    app.frameIndex = null;
    app.selectedLine = null;
    app.highlightFn = null;
    output.reset();
    const target = opts.keepPos ? Math.min(prevPos, mv.root.endPos) : mv.root.endPos;
    app.cursor.seek(target);
    if (app.chartVar && mv.root.numericSeries(app.chartVar).length === 0) app.chartVar = null;
    refreshFind();
  } catch (e) {
    if (e instanceof LoomSyntaxError) {
      app.mv = null;
      app.cursor = null;
      app.find = null;
      app.compileError = { message: e.message, line: e.line };
      app.dirty = false;
      output.reset();
    } else {
      throw e;
    }
  }
  $('run-btn').classList.remove('pulse');
  render();
  renderBreakpoints();
}

let autoRunTimer: number | undefined;
let programmaticEdit = false;

/** Replace the editor contents without triggering live re-recording. */
function loadCode(code: string) {
  programmaticEdit = true;
  editor.setCode(code);
  programmaticEdit = false;
}

function onCodeChange() {
  if (programmaticEdit) return;
  app.dirty = true;
  stopPlaying();
  clearTimeout(autoRunTimer);
  const hasForks = (app.mv?.timelines.length ?? 0) > 1;
  if (hasForks) {
    $('run-btn').classList.add('pulse');
  } else {
    // live mode: re-record shortly after typing stops, staying at the same moment
    autoRunTimer = window.setTimeout(() => runProgram({ keepPos: true }), 650);
  }
  renderStatus();
}

// ------------------------------------------------------------ navigation

function seek(pos: number, opts: { flash?: boolean } = {}) {
  const c = app.cursor;
  if (!c) return;
  if (vars.isEditing()) vars.cancelEdit();
  c.seek(pos);
  app.frameIndex = null;
  render();
  if (opts.flash) editor.flash(c.tl.lineAt(c.pos));
}

function continueTo(dir: 1 | -1) {
  const c = app.cursor;
  const mv = app.mv;
  if (!c || !mv) return;
  const bps = editor.breakpoints().filter((b) => b.enabled);
  if (!bps.length) {
    toast('No breakpoints. Click left of a line number to add one.');
    return;
  }
  const r = mv.findBreakpoint(c.tl, c.pos, dir, bps);
  if (r === null) toast(dir === 1 ? 'No more breakpoint hits after this step' : 'No breakpoint hits before this step');
  else if ('error' in r) toast(r.error);
  else seek(r.pos, { flash: true });
}

function act(name: string) {
  const c = app.cursor;
  if (!c) return;
  const tl = c.tl;
  const p = c.pos;
  switch (name) {
    case 'start':
      return seek(0);
    case 'end':
      return seek(tl.endPos);
    case 'back':
      return seek(p - 1);
    case 'fwd':
      return seek(p + 1);
    case 'over':
      return seek(tl.stepOver(p));
    case 'overBack':
      return seek(tl.stepOverBack(p));
    case 'out':
      return seek(tl.stepOut(p));
    case 'outBack':
      return seek(tl.stepOutBack(p));
    case 'cont':
      return continueTo(1);
    case 'contBack':
      return continueTo(-1);
    case 'play':
      return app.playing ? stopPlaying() : startPlaying();
  }
}

function jumpToLine(line: number, backwards: boolean) {
  const c = app.cursor;
  if (!c) return;
  const tl = c.tl;
  if (!tl.lineHits().get(line)) return;
  app.selectedLine = line;
  let target = backwards ? tl.prevHitOfLine(c.pos, line) : tl.nextHitOfLine(c.pos, line);
  if (target === null) {
    target = backwards ? tl.prevHitOfLine(tl.endPos, line) : tl.nextHitOfLine(-1, line);
    toast(`Wrapped to the ${backwards ? 'last' : 'first'} run of line ${line}`);
  }
  if (target !== null) seek(target);
}

// ------------------------------------------------------------------ find

function refreshFind() {
  const expr = ($('find-input') as HTMLInputElement).value.trim();
  if (!expr || !app.mv || !app.cursor) {
    app.find = null;
    renderFindStatus();
    return;
  }
  const tl = app.cursor.tl;
  if (app.find && app.find.expr === expr && app.find.tl === tl) return;
  const r = app.mv.query(tl, expr);
  app.find = { expr, tl, matches: r.matches };
  renderFindStatus(r.error);
}

function runFind(dir: 1 | -1) {
  refreshFind();
  const c = app.cursor;
  const f = app.find;
  if (!c || !f || !f.matches.length) {
    render();
    return;
  }
  const m = f.matches;
  let target: number | undefined;
  if (dir === 1) target = m.find((p) => p > c.pos) ?? m[0];
  else target = [...m].reverse().find((p) => p < c.pos) ?? m[m.length - 1];
  seek(target, { flash: true });
}

function renderFindStatus(error: string | null = null) {
  const el = $('find-status');
  el.className = 'find-status';
  el.title = '';
  if (error) {
    el.classList.add('err');
    el.textContent = error;
    el.title = error;
    return;
  }
  const f = app.find;
  if (!f) {
    el.textContent = '';
    return;
  }
  if (!f.matches.length) {
    el.textContent = 'no matches';
    return;
  }
  const pos = app.cursor?.pos ?? -1;
  const idx = f.matches.indexOf(pos);
  const n = f.matches.length;
  el.textContent = idx >= 0 ? `${idx + 1} of ${n.toLocaleString()}` : `${n.toLocaleString()} match${n === 1 ? '' : 'es'}`;
}

// --------------------------------------------------------------- playback

const SPEEDS = [2, 4, 8, 15, 30, 60, 120, 250, 600, 1500]; // statements per second
let playRaf = 0;
let playAcc = 0;
let playLast = 0;

function startPlaying() {
  const c = app.cursor;
  if (!c) return;
  if (c.pos >= c.tl.endPos) c.seek(0);
  app.playing = true;
  playLast = performance.now();
  playAcc = 0;
  const tick = (now: number) => {
    if (!app.playing || !app.cursor) return;
    const speed = SPEEDS[Number(($('speed') as HTMLInputElement).value) - 1] ?? 30;
    playAcc += ((now - playLast) / 1000) * speed;
    playLast = now;
    const steps = Math.floor(playAcc);
    if (steps > 0) {
      playAcc -= steps;
      const cur = app.cursor;
      const target = Math.min(cur.tl.endPos, cur.pos + steps);
      cur.seek(target);
      app.frameIndex = null;
      render();
      if (target >= cur.tl.endPos) {
        stopPlaying();
        return;
      }
    }
    playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
  renderTransport();
}

function stopPlaying() {
  if (!app.playing) return;
  app.playing = false;
  cancelAnimationFrame(playRaf);
  renderTransport();
}

// ---------------------------------------------------------------- render

function renderStatus() {
  const st = $('status');
  if (app.compileError) {
    st.className = 'status err';
    st.textContent = `Syntax error on line ${app.compileError.line}`;
    st.title = st.textContent;
    return;
  }
  if (app.dirty) {
    st.className = 'status dirty';
    const forks = (app.mv?.timelines.length ?? 0) > 1;
    st.textContent = forks ? 'Modified. Press Run (Ctrl+Enter) to re-run; this clears other timelines.' : 'Modified, re-running…';
    return;
  }
  if (app.mv) {
    const root = app.mv.root;
    st.className = 'status ok';
    const ms = root.recordMs < 1 ? '<1' : Math.round(root.recordMs);
    const d = diagnostics(editor.getCode());
    const errors = d.filter((x) => x.severity === 'error').length;
    const warnings = d.filter((x) => x.severity === 'warning').length;
    const problems = [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    st.textContent = `${problems ? problems + ' · ' : ''}${root.endPos.toLocaleString()} steps · ${root.calls.length.toLocaleString()} calls · ${ms} ms`;
    st.className = errors ? 'status err' : warnings ? 'status dirty' : 'status ok';
    st.title = 'Problems found by the linter, statements executed, function calls, and recording time';
  }
}

function renderTransport() {
  const tr = document.querySelector('.transport')!;
  tr.classList.toggle('playing', app.playing);
  const c = app.cursor;
  const buttons = tr.querySelectorAll<HTMLButtonElement>('button[data-act]');
  buttons.forEach((b) => {
    const a = b.dataset.act!;
    if (!c) b.disabled = true;
    else if (['start', 'back', 'overBack', 'outBack', 'contBack'].includes(a)) b.disabled = c.pos <= 0;
    else if (['end', 'fwd', 'over', 'out', 'cont'].includes(a)) b.disabled = c.pos >= c.tl.endPos;
    else b.disabled = false;
  });
}

function renderBreakpoints() {
  const n = editor.breakpoints().length;
  $('bp-count').textContent = n ? String(n) : '';
  breakpointsPanel.render(app.cursor?.tl ?? null);
}

let lastRendered: { tl: Timeline | null; pos: number } = { tl: null, pos: -1 };

function render() {
  renderStatus();
  renderTransport();
  const c = app.cursor;
  const mv = app.mv;

  if (!c || !mv) {
    const err = app.compileError;
    editor.setMarks({ current: null, frame: null, error: err?.line ?? null, inline: err ? { line: err.line, text: err.message, error: true } : null });
    editor.setHeat(new Map(), null);
    $('banner').replaceChildren(err ? h('div', { class: 'banner error' }, 'Syntax error on line ', h('b', null, String(err.line)), ': ', err.message) : '');
    $('vars').replaceChildren(h('div', { class: 'empty' }, 'Fix the syntax error to run the program.'));
    watch.render(null, null, 0);
    $('stack').replaceChildren();
    $('data').replaceChildren();
    $('multiverse').replaceChildren();
    $('profile').replaceChildren();
    $('pos-label').textContent = '';
    chart.render(null, 0, null);
    consolePanel.updateWhere(null, '');
    renderFindStatus();
    return;
  }

  const tl = c.tl;
  const state: VMState = c.state;
  const top = state.frames.length - 1;
  const frameIndex = currentFrame();
  const highlight = lastRendered.tl === tl && lastRendered.pos !== c.pos && Math.abs(lastRendered.pos - c.pos) <= 50;
  lastRendered = { tl, pos: c.pos };
  const ctx: InspectContext = { mv, tl, pos: c.pos, state, frameIndex, chartVar: app.chartVar, highlight };
  const atEnd = c.pos >= tl.endPos;

  // editor
  const curLine = tl.lineAt(c.pos);
  const errLine = atEnd && tl.end.kind === 'error' ? tl.end.error.line : null;
  const doc = editor.view.state.doc;
  let inline: { line: number; text: string; error?: boolean } | null = null;
  if (errLine !== null && tl.end.kind === 'error') {
    inline = { line: errLine, text: tl.end.error.message, error: true };
  } else if (curLine >= 1 && curLine <= doc.lines) {
    const text = inlineHints(ctx, doc.line(curLine).text);
    if (text) inline = { line: curLine, text };
  }
  const frameLine = frameIndex !== top ? mv.vm.frameLine(state, frameIndex) : null;
  editor.setMarks({
    current: atEnd && tl.end.kind === 'done' ? null : curLine,
    frame: frameLine || null,
    error: errLine,
    inline,
  });
  editor.setHeat(tl.lineHits(), app.selectedLine);
  editor.revealLine(frameLine || curLine);

  // position label
  $('pos-label').replaceChildren(
    atEnd ? h('b', null, 'end') : h('span', null, 'step ', h('b', null, c.pos.toLocaleString())),
    ` / ${tl.endPos.toLocaleString()}`,
    atEnd ? '' : ` · line ${curLine}`,
    mv.timelines.length > 1 ? ` · timeline #${tl.id}` : '',
  );

  // flame chart
  flame.setModel({
    tl,
    pos: c.pos,
    protos: mv.vm.program.protos,
    selectedLine: app.selectedLine,
    forkPoints: mv.timelines.filter((t) => t.parent === tl).map((t) => t.forkPos),
    matches: app.find && app.find.tl === tl ? app.find.matches : [],
    highlightFn: app.highlightFn,
  });
  $('zoom-reset').hidden = !flame.zoomed;

  // panels
  watch.render(mv, state, frameIndex);
  vars.render(ctx);
  stack.render(ctx);
  data.render(ctx);
  output.render(tl, c.pos);
  multiverse.render(mv, tl, c.pos);
  chart.render(tl, c.pos, app.chartVar);
  profile.render(mv, tl, app.highlightFn);
  const fname = mv.vm.program.protos[state.frames[frameIndex].f].name;
  consolePanel.updateWhere(c.pos, fname === '<main>' ? 'main' : fname);
  renderFindStatus();
}

// ------------------------------------------------------------ chrome & keys

function activateTab(group: string, name: string) {
  const panel = document.querySelector<HTMLElement>(`[data-tabs="${group}"]`);
  if (!panel) return;
  panel.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  panel.querySelectorAll<HTMLElement>('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== name));
  if (name === 'history') chart.render(app.cursor?.tl ?? null, app.cursor?.pos ?? 0, app.chartVar);
  if (name === 'console') consolePanel.focus();
}

function setupChrome() {
  const select = $<HTMLSelectElement>('example-select');
  select.append(h('option', { value: '', disabled: true, selected: !start.example }, 'Examples…'));
  for (const ex of EXAMPLES) {
    select.append(h('option', { value: ex.id, selected: ex.id === start.example }, ex.title));
  }
  select.addEventListener('change', () => {
    const ex = findExample(select.value);
    // give the keyboard back to time travel (arrow keys would otherwise cycle examples)
    select.blur();
    if (!ex) return;
    clearTimeout(autoRunTimer);
    loadCode(ex.code);
    app.chartVar = null;
    ($('find-input') as HTMLInputElement).value = '';
    runProgram({ keepPos: false });
    editor.view.scrollDOM.scrollTop = 0;
    history.replaceState(null, '', `#example=${ex.id}`);
  });

  document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((panel) => {
    panel.querySelectorAll<HTMLElement>('.tab').forEach((t) =>
      t.addEventListener('click', () => activateTab(panel.dataset.tabs!, t.dataset.tab!)),
    );
  });

  $('run-btn').addEventListener('click', () => {
    clearTimeout(autoRunTimer);
    runProgram({ keepPos: false });
  });

  $('share-btn').addEventListener('click', async () => {
    const step = (app.cursor ? `&step=${app.cursor.pos}` : '') + (app.chartVar ? `&chart=${app.chartVar}` : '');
    const url = `${location.origin}${location.pathname}#code=${encodeCode(editor.getCode())}${step}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Could not copy. The link is in the address bar.');
    }
  });

  // find bar
  const findInput = $<HTMLInputElement>('find-input');
  $('find-form').addEventListener('submit', (e) => e.preventDefault());
  findInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') findInput.blur();
  });
  findInput.addEventListener('input', () => {
    if (!findInput.value.trim()) {
      app.find = null;
      render();
    }
  });
  $('find-next').addEventListener('click', () => runFind(1));
  $('find-prev').addEventListener('click', () => runFind(-1));
  $('find-clear').addEventListener('click', () => {
    findInput.value = '';
    app.find = null;
    render();
  });
  $('zoom-reset').addEventListener('click', () => {
    flame.resetZoom();
    $('zoom-reset').hidden = true;
  });

  const dialog = $<HTMLDialogElement>('help-dialog');
  dialog.innerHTML = HELP_HTML;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || (e.target as HTMLElement).closest('[data-close]')) dialog.close();
  });
  $('help-btn').addEventListener('click', () => dialog.showModal());

  document.querySelectorAll<HTMLButtonElement>('.transport button[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.act !== 'play') stopPlaying();
      act(b.dataset.act!);
    }),
  );

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inEditor = !!target.closest?.('.cm-editor');
    const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    if (e.key === 'F8') {
      e.preventDefault();
      stopPlaying();
      act(e.shiftKey ? 'contBack' : 'cont');
      return;
    }
    if (inEditor) {
      if (e.key === 'Escape') editor.view.contentDOM.blur();
      return;
    }
    if (inInput || e.ctrlKey || e.metaKey || e.altKey) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runProgram({ keepPos: false });
      }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      findInput.focus();
      return;
    }
    if (e.key === '?') {
      dialog.showModal();
      return;
    }
    const map: Record<string, string> = {
      ArrowLeft: e.shiftKey ? 'overBack' : 'back',
      ArrowRight: e.shiftKey ? 'over' : 'fwd',
      '[': 'outBack',
      ']': 'out',
      Home: 'start',
      End: 'end',
      ' ': 'play',
    };
    const a = map[e.key];
    if (a) {
      e.preventDefault();
      if (a !== 'play') stopPlaying();
      act(a);
    }
  });

  window.addEventListener('hashchange', () => {
    const next = initialCode();
    select.value = next.example ?? '';
    if (next.code !== editor.getCode()) {
      loadCode(next.code);
      runProgram({ keepPos: false });
    }
    if (next.step !== null) seek(next.step);
  });
}

setupChrome();
// canvas colors come from CSS, so redraw when the OS theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
{
  // `#…&chart=name` opens with a variable's history chart
  const chartParam = new URLSearchParams(location.hash.slice(1)).get('chart');
  if (chartParam && /^[A-Za-z_]\w*$/.test(chartParam)) app.chartVar = chartParam;
}
runProgram({ keepPos: false });
if (start.step !== null) seek(start.step);

Object.assign(window, {
  loom: {
    get multiverse() {
      return app.mv;
    },
    get cursor() {
      return app.cursor;
    },
  },
});
