/**
 * The data visualiser: draws the arrays, grids and records reachable from
 * the inspected frame. Numeric arrays become bar charts (with index-variable
 * pointers underneath), 2D arrays become grids, records become tables.
 * Cells that changed since the last rendered moment are highlighted.
 */

import { isRef, type HeapObj, type Value, type VMState } from '../core';
import { h, truncate } from './dom';
import type { InspectContext } from './inspect';

type Arr = Extract<HeapObj, { t: 'arr' }>;
type Rec = Extract<HeapObj, { t: 'rec' }>;

const ALWAYS_POINTERS = new Set(['i', 'j', 'k', 'lo', 'hi', 'mid', 'left', 'right', 'head', 'tail', 'idx', 'index', 'p', 'q', 'x', 'y']);

/** Identifiers used inside [...] anywhere in the program are probably indices. */
export function indexLikeNames(source: string): Set<string> {
  const out = new Set(ALWAYS_POINTERS);
  for (const m of source.matchAll(/\[([^\[\]\n]*)\]/g)) {
    for (const id of m[1].match(/[A-Za-z_]\w*/g) ?? []) out.add(id);
  }
  return out;
}

export class DataPanel {
  private prev = new Map<number, string[]>();
  private indexNames = new Set<string>();
  private highlight = false;

  constructor(private root: HTMLElement) {}

  setSource(source: string): void {
    this.indexNames = indexLikeNames(source);
    this.prev.clear();
  }

  render(ctx: InspectContext): void {
    const { mv, state } = ctx;
    this.highlight = ctx.highlight;
    const vm = mv.vm;
    const scopes = vm.scopes(state, ctx.frameIndex);

    // gather candidate objects: (name, objId) with aliases
    const objects = new Map<number, string[]>();
    const ints = new Map<string, number>();
    for (const scope of scopes) {
      for (const [name, v] of scope.vars) {
        if (typeof v === 'number' && Number.isInteger(v) && !ints.has(name)) ints.set(name, v);
        if (!isRef(v)) continue;
        const o = state.heap.get(v.r);
        if (!o || (o.t !== 'arr' && o.t !== 'rec')) continue;
        const names = objects.get(v.r) ?? [];
        if (!names.includes(name)) names.push(name);
        objects.set(v.r, names);
      }
    }

    const pointers = [...ints.entries()].filter(([n]) => this.indexNames.has(n));
    const next = new Map<number, string[]>();
    const nodes: Node[] = [];
    let count = 0;

    for (const [id, names] of objects) {
      if (count++ >= 10) break;
      const o = state.heap.get(id)!;
      const title = h(
        'div',
        { class: 'viz-title' },
        h('span', null, names[0]),
        names.length > 1 ? h('span', { class: 'alias', title: 'These names refer to the very same object' }, `also ${names.slice(1).join(', ')}`) : null,
        h('span', { class: 'id' }, `${o.t === 'arr' ? `array · ${(o as Arr).v.length}` : 'record'} · #${id}`),
      );
      const body = o.t === 'arr' ? this.renderArray(state, id, o as Arr, pointers, next) : this.renderRecord(state, id, o as Rec, next);
      nodes.push(h('div', { class: 'viz' }, title, body));
    }

    if (nodes.length === 0) {
      nodes.push(
        h('div', { class: 'empty' }, 'No arrays or records in scope.'),
      );
    }
    this.root.replaceChildren(...nodes);
    this.prev = next;
  }

  private snapshot(state: VMState, values: Value[]): string[] {
    return values.map((v) => (isRef(v) ? JSON.stringify(this.deep(state, v, 2)) : String(v)));
  }

  private deep(state: VMState, v: Value, depth: number): unknown {
    if (!isRef(v)) return v;
    const o = state.heap.get(v.r);
    if (!o || depth <= 0) return `#${v.r}`;
    if (o.t === 'arr') return o.v.map((x) => this.deep(state, x, depth - 1));
    if (o.t === 'rec') return Object.fromEntries(Object.entries(o.v).map(([k, x]) => [k, this.deep(state, x, depth - 1)]));
    return `#${v.r}`;
  }

  private changedSet(id: number, snap: string[]): Set<number> {
    const before = this.prev.get(id);
    const hot = new Set<number>();
    if (!before || !this.highlight) return hot;
    for (let i = 0; i < snap.length; i++) if (before[i] !== snap[i]) hot.add(i);
    return hot;
  }

  private renderArray(state: VMState, id: number, o: Arr, pointers: [string, number][], next: Map<number, string[]>): HTMLElement {
    const snap = this.snapshot(state, o.v);
    const hot = this.changedSet(id, snap);
    next.set(id, snap);
    const items = o.v;

    // 2D grid?
    const rows = items.map((v) => (isRef(v) ? state.heap.get(v.r) : undefined));
    if (
      items.length > 0 &&
      items.length <= 48 &&
      rows.every((r) => r?.t === 'arr') &&
      rows.every((r) => (r as Arr).v.length === (rows[0] as Arr).v.length && (r as Arr).v.length <= 48 && (r as Arr).v.length > 0) &&
      rows.every((r) => (r as Arr).v.every((c) => !isRef(c)))
    ) {
      return this.renderGrid(id, rows as Arr[], hot);
    }

    const numeric = items.length > 0 && items.every((v) => typeof v === 'number');
    if (numeric && items.length <= 80) {
      const nums = items as number[];
      const maxAbs = Math.max(1e-9, ...nums.map(Math.abs));
      const showVals = items.length <= 24;
      const pointed = new Map<number, string[]>();
      for (const [name, val] of pointers) {
        const idx = val < 0 ? val + items.length : val;
        if (idx >= 0 && idx < items.length) pointed.set(idx, [...(pointed.get(idx) ?? []), name]);
      }
      const bars = h(
        'div',
        { class: 'bars', style: { marginTop: showVals ? '14px' : '0' } },
        ...nums.map((n, i) =>
          h(
            'div',
            {
              class: `bar ${n < 0 ? 'neg' : ''} ${hot.has(i) ? 'hot' : ''} ${pointed.has(i) ? 'pointed' : ''}`,
              style: { height: `${Math.max(2, (Math.abs(n) / maxAbs) * 100)}%` },
              title: `[${i}] = ${n}`,
            },
            showVals ? h('span', { class: 'bv' }, truncate(String(Math.round(n * 100) / 100), 6)) : null,
          ),
        ),
      );
      const ptrRow = h(
        'div',
        { class: 'pointers' },
        ...nums.map((_, i) => h('div', { class: 'pointer-slot' }, pointed.has(i) ? `▲${pointed.get(i)!.join(',')}` : '')),
      );
      return h('div', null, bars, ptrRow);
    }

    // generic: chips
    const shown = items.slice(0, 60);
    return h(
      'div',
      { class: 'cells' },
      ...shown.map((v, i) =>
        h(
          'span',
          { class: `cell ${hot.has(i) ? 'hot' : ''}`, title: `[${i}]` },
          h('span', { class: 'ix' }, String(i)),
          truncate(formatShort(state, v), 40),
        ),
      ),
      items.length > shown.length ? h('span', { class: 'cell' }, `… ${items.length - shown.length} more`) : null,
      items.length === 0 ? h('span', { class: 'cell', style: { color: 'var(--faint)' } }, 'empty') : null,
    );
  }

  private renderGrid(id: number, rows: Arr[], hotRows: Set<number>): HTMLElement {
    const cols = rows[0].v.length;
    const size = Math.max(9, Math.min(22, Math.floor(380 / cols) - 2));
    const before = this.prev.get(-id - 1);
    const flat: string[] = [];
    let maxNum = 1;
    let binary = true;
    for (const r of rows) {
      for (const c of r.v) {
        if (typeof c === 'number') {
          if (c > maxNum) maxNum = c;
          if (c !== 0 && c !== 1) binary = false;
        }
      }
    }
    const cells: HTMLElement[] = [];
    rows.forEach((r, ri) => {
      r.v.forEach((c, ci) => {
        const key = String(c);
        flat.push(key);
        const changed = before !== undefined && hotRows.has(ri) && before[ri * cols + ci] !== key;
        let cls = 'gcell';
        let text = '';
        let bg: string | undefined;
        let fg: string | undefined;
        if (c === null || c === false || c === 0 || c === '' || c === '.') {
          /* empty */
        } else if (c === true) cls += ' on';
        else if (c === '#') cls += ' wall';
        else if (typeof c === 'string') {
          cls += ' str';
          text = c.slice(0, 2);
        } else if (typeof c === 'number') {
          if (binary) cls += ' on';
          else {
            const k = Math.min(1, Math.abs(c) / maxNum);
            bg = `color-mix(in srgb, var(--accent) ${Math.round(15 + 70 * k)}%, var(--panel))`;
            if (k > 0.5) fg = "#fff";
            if (size >= 16) text = String(Math.round(c));
          }
        }
        if (changed) cls += ' hot';
        cells.push(
          h(
            'div',
            {
              class: cls,
              style: { width: `${size}px`, height: `${size}px`, background: bg, color: fg, fontSize: size < 16 ? '0px' : undefined },
              title: `[${ri}][${ci}] = ${typeof c === 'string' ? JSON.stringify(c) : String(c)}`,
            },
            text,
          ),
        );
      });
    });
    // remember a flat snapshot under a derived key for per-cell diffs
    queueMicrotask(() => this.prev.set(-id - 1, flat));
    return h('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${cols}, ${size}px)` } }, ...cells);
  }

  private renderRecord(state: VMState, id: number, o: Rec, next: Map<number, string[]>): HTMLElement {
    const keys = Object.keys(o.v);
    const snap = this.snapshot(state, keys.map((k) => o.v[k]));
    const hot = this.changedSet(id, snap);
    next.set(id, snap);
    return h(
      'table',
      { class: 'rec-table' },
      h(
        'tbody',
        null,
        ...keys.slice(0, 40).map((k, i) => {
          const v = o.v[k];
          const inner = isRef(v) ? state.heap.get(v.r) : undefined;
          let cell: Node;
          if (inner?.t === 'arr' && inner.v.length <= 24 && inner.v.every((x) => typeof x === 'number')) {
            const nums = inner.v as number[];
            const maxAbs = Math.max(1, ...nums.map(Math.abs));
            cell = h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-end', gap: '10px' } },
              h(
                'div',
                { class: 'mini-bars' },
                ...nums.map((n) => h('div', { class: 'bar', style: { height: `${Math.max(4, (Math.abs(n) / maxAbs) * 100)}%`, width: "8px", flex: "none" }, title: String(n) })),
              ),
              h('span', { style: { color: 'var(--muted)' } }, truncate(formatShort(state, v), 40)),
            );
          } else {
            cell = document.createTextNode(truncate(formatShort(state, v), 160));
          }
          return h('tr', { class: hot.has(i) ? 'hot' : '' }, h('td', null, k), h('td', null, cell));
        }),
      ),
    );
  }
}

function formatShort(state: VMState, v: Value): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (!isRef(v)) return v === null ? 'nil' : String(typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
  const o = state.heap.get(v.r);
  if (!o) return '?';
  if (o.t === 'arr') return `[${o.v.map((x) => formatShort(state, x)).join(', ')}]`;
  if (o.t === 'rec') return `{${Object.entries(o.v).map(([k, x]) => `${k}: ${formatShort(state, x)}`).join(', ')}}`;
  if (o.t === 'fn') return '<fn>';
  return '<builtin>';
}
