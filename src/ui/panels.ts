/** Watch expressions, the time-travel console, the profiler and the breakpoint list. */

import { tryEvaluate, type Multiverse, type ProfileRow, type Timeline, type VMState } from '../core';
import { h, ICONS, truncate, valueClass } from './dom';
import type { Breakpoint, LoomEditor } from './editor';

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

// ----------------------------------------------------------------- watches

export class WatchPanel {
  private exprs: string[] = store.get<string[]>('chronoloom:watch', []);
  private last: { mv: Multiverse; state: VMState; frameIndex: number } | null = null;

  constructor(
    private root: HTMLElement,
    private onFind: (expr: string) => void,
  ) {}

  private save() {
    store.set('chronoloom:watch', this.exprs);
  }

  add(expr: string) {
    expr = expr.trim();
    if (!expr || this.exprs.includes(expr)) return;
    this.exprs.push(expr);
    this.save();
    this.rerender();
  }

  private rerender() {
    if (this.last) this.render(this.last.mv, this.last.state, this.last.frameIndex);
  }

  render(mv: Multiverse | null, state: VMState | null, frameIndex: number) {
    if (mv && state) this.last = { mv, state, frameIndex };
    const rows: Node[] = [];
    this.exprs.forEach((expr, i) => {
      let value: Node;
      if (mv && state) {
        const r = tryEvaluate(mv.vm, state, frameIndex, expr);
        value =
          'value' in r
            ? h('span', { class: `value ${valueClass(state, r.value)}`, title: mv.vm.format(state, r.value, true) }, truncate(mv.vm.format(state, r.value, true), 100))
            : h('span', { class: 'value watch-err', title: r.error }, r.error.replace(/^'(.+)' is not defined here$/, 'not in scope'));
      } else value = h('span', { class: 'value' }, '');
      rows.push(
        h(
          'div',
          { class: 'var watch-row' },
          h('span', { class: 'name', title: expr }, truncate(expr, 28)),
          value,
          h(
            'span',
            { class: 'actions' },
            h('button', { class: 'icon-btn', title: `Find every step where ${expr} is true`, html: ICONS.find, onclick: () => this.onFind(expr) }),
            h('button', {
              class: 'icon-btn',
              title: 'Remove',
              html: ICONS.close,
              onclick: () => {
                this.exprs.splice(i, 1);
                this.save();
                this.rerender();
              },
            }),
          ),
        ),
      );
    });
    const input = h('input', { class: 'watch-input', placeholder: 'Add watch expression…', spellcheck: 'false', 'aria-label': 'Add watch expression' });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.add(input.value);
      if (e.key === 'Escape') input.blur();
    });
    rows.push(h('div', { class: 'watch-add' }, input));
    this.root.replaceChildren(h('div', { class: 'scope-title' }, h('span', { class: 'tag' }, 'watch')), ...rows);
  }
}

// ----------------------------------------------------------------- console

interface ConsoleEntry {
  input: string;
  pos: number;
  timeline: number;
  line: number;
  value: string | null;
  output: string[];
  error: string | null;
}

export class ConsolePanel {
  private entries: ConsoleEntry[] = [];
  private history: string[] = store.get<string[]>('chronoloom:console', []);
  private hIndex = -1;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private where: HTMLElement;

  constructor(
    root: HTMLElement,
    private ctx: () => { mv: Multiverse; tl: Timeline; pos: number; frameIndex: number } | null,
    private onSeek: (tl: number, pos: number) => void,
  ) {
    this.log = h('div', { class: 'console-log scroll mono' });
    this.where = h('span', { class: 'console-where' });
    this.input = h('input', {
      class: 'console-input mono',
      placeholder: 'Evaluate at this step, e.g. fib(10) or map(xs, fn(x) => x * 2)',
      spellcheck: 'false',
      'aria-label': 'Console input',
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    root.replaceChildren(
      this.log,
      h('div', { class: 'console-bar' }, h('span', { class: 'prompt' }, '>'), this.input, this.where, h('button', { class: 'icon-btn', title: 'Clear', html: ICONS.clear, onclick: () => this.clear() })),
    );
    this.renderLog();
  }

  private clear() {
    this.entries = [];
    this.renderLog();
  }

  updateWhere(pos: number | null, frameName: string) {
    this.where.textContent = pos === null ? '' : `step ${pos} · ${frameName}`;
  }

  private onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const src = this.input.value.trim();
      if (!src) return;
      this.run(src);
      this.input.value = '';
      this.hIndex = -1;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.history.length) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') this.hIndex = Math.min(this.history.length - 1, this.hIndex + 1);
      else this.hIndex = Math.max(-1, this.hIndex - 1);
      this.input.value = this.hIndex < 0 ? '' : this.history[this.history.length - 1 - this.hIndex];
    } else if (e.key === 'Escape') this.input.blur();
  }

  run(src: string) {
    const c = this.ctx();
    if (!c) return;
    const r = c.mv.evaluate(c.tl, c.pos, c.frameIndex, src);
    this.entries.push({ input: src, pos: c.pos, timeline: c.tl.id, line: c.tl.lineAt(c.pos), ...r });
    if (this.history[this.history.length - 1] !== src) this.history.push(src);
    if (this.history.length > 100) this.history.shift();
    store.set('chronoloom:console', this.history);
    this.renderLog();
  }

  focus() {
    this.input.focus();
  }

  private renderLog() {
    if (!this.entries.length) {
      this.log.replaceChildren(
        h(
          'div',
          { class: 'empty', style: { fontFamily: 'var(--sans)' } },
          'Evaluate any expression as if it ran at the current step, in the selected stack frame. You can call your own functions; the recording is not changed.',
        ),
      );
      return;
    }
    const nodes = this.entries.map((e) =>
      h(
        'div',
        { class: 'console-entry' },
        h(
          'div',
          { class: 'console-in' },
          h('span', { class: 'prompt' }, '>'),
          h('span', null, e.input),
          h('button', { class: 'console-at', title: 'Go to this step', onclick: () => this.onSeek(e.timeline, e.pos) }, `step ${e.pos} · line ${e.line}`),
        ),
        ...e.output.map((o) => h('div', { class: 'console-print' }, o)),
        e.error !== null ? h('div', { class: 'console-err' }, e.error) : h('div', { class: 'console-out' }, e.value ?? ''),
      ),
    );
    this.log.replaceChildren(...nodes);
    this.log.scrollTop = this.log.scrollHeight;
  }
}

// ---------------------------------------------------------------- profiler

export class ProfilePanel {
  private key = '';

  constructor(
    private root: HTMLElement,
    private onPick: (row: ProfileRow) => void,
  ) {}

  render(mv: Multiverse, tl: Timeline, highlightFn: number | null) {
    const key = `${tl.id}:${tl.endPos}:${highlightFn}`;
    if (key === this.key) return;
    this.key = key;
    const rows = tl.profile(mv.vm).filter((r) => r.total > 0 || r.self > 0);
    const max = Math.max(1, ...rows.map((r) => r.total));
    const body = rows.map((r) =>
      h(
        'tr',
        { class: `${r.fn === highlightFn ? 'picked' : ''} ${r.internal ? 'internal' : ''}`, onclick: () => this.onPick(r), title: 'Click to highlight in the flame chart and go to the first call' },
        h('td', { class: 'fn' }, r.name === '<main>' ? 'main' : r.name, r.internal ? h('span', { class: 'tag-small' }, 'stdlib') : null),
        h('td', { class: 'num' }, r.calls.toLocaleString()),
        h('td', { class: 'num' }, r.self.toLocaleString()),
        h('td', { class: 'num' }, r.total.toLocaleString()),
        h('td', { class: 'barcell' }, h('div', { class: 'pbar', style: { width: `${(r.total / max) * 100}%` } }, h('div', { class: 'pbar-self', style: { width: `${r.total ? (r.self / r.total) * 100 : 0}%` } }))),
      ),
    );
    this.root.replaceChildren(
      h(
        'table',
        { class: 'profile' },
        h('thead', null, h('tr', null, h('th', null, 'Function'), h('th', { class: 'num', title: 'Number of calls' }, 'Calls'), h('th', { class: 'num', title: 'Statements executed in the function itself' }, 'Self'), h('th', { class: 'num', title: 'Statements executed while the function was running, including callees' }, 'Total'), h('th', null, ''))),
        h('tbody', null, ...body),
      ),
    );
  }
}

// ------------------------------------------------------------- breakpoints

export class BreakpointsPanel {
  constructor(
    private root: HTMLElement,
    private editor: () => LoomEditor,
  ) {}

  render(tl: Timeline | null) {
    const ed = this.editor();
    const bps: Breakpoint[] = ed.breakpoints();
    if (!bps.length) {
      this.root.replaceChildren(
        h('div', { class: 'empty' }, 'Click left of a line number to add a breakpoint. Then use Continue (F8) and Reverse continue (Shift+F8) to jump between hits, forward or backward. Breakpoints can have a condition.'),
      );
      return;
    }
    const doc = ed.view.state.doc;
    const hits = tl?.lineHits();
    const rows = bps.map((bp) => {
      const cond = h('input', {
        class: 'bp-cond mono',
        value: bp.condition,
        placeholder: 'condition (optional), e.g. i == 3',
        spellcheck: 'false',
        'aria-label': `Condition for breakpoint on line ${bp.line}`,
      });
      const commit = () => {
        if (cond.value !== bp.condition) ed.updateBreakpoint(bp.line, { condition: cond.value.trim() });
      };
      cond.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
      });
      cond.addEventListener('blur', commit);
      const enabled = h('input', { type: 'checkbox', checked: bp.enabled, title: 'Enabled', 'aria-label': `Enable breakpoint on line ${bp.line}` }) as HTMLInputElement;
      enabled.addEventListener('change', () => ed.updateBreakpoint(bp.line, { enabled: enabled.checked }));
      const count = hits?.get(bp.line) ?? 0;
      return h(
        'div',
        { class: 'bp-row' },
        enabled,
        h('span', { class: 'bp-line' }, `Line ${bp.line}`),
        h('span', { class: 'bp-code mono', title: doc.line(Math.min(bp.line, doc.lines)).text.trim() }, truncate(doc.line(Math.min(bp.line, doc.lines)).text.trim(), 40)),
        h('span', { class: 'bp-hits', title: 'How many times this line ran' }, `${count}×`),
        h('button', { class: 'icon-btn', title: 'Remove', html: ICONS.close, onclick: () => ed.removeBreakpoint(bp.line) }),
        cond,
      );
    });
    this.root.replaceChildren(
      ...rows,
      h('div', { class: 'bp-footer' }, h('button', { class: 'btn small', onclick: () => ed.clearBreakpoints(), text: 'Remove all' })),
    );
  }
}
