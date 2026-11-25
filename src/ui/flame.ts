/**
 * The flame chart: the whole execution as a call tree over time.
 *
 *   ┌ overview ───────────────────────────────────────────────┐  whole run, markers, zoom window
 *   ├ main ───────────────────────────────────────────────────┤
 *   │   fib(5)──────────────┐   fib(4)───────┐                 │  one row per call depth
 *   │     fib(4)───┐ fib(3) │     fib(3)─┐   │                 │
 *   └──────────────────────────────────────────────────────────┘
 *
 * x is time (statement position), each box is one function call. Click to
 * move to a step, drag to scrub, scroll to zoom, double-click a call to zoom
 * into it, double-click empty space to zoom out.
 */

import type { CallRecord, Timeline } from '../core';
import type { FnProto } from '../core/bytecode';

export interface FlameModel {
  tl: Timeline;
  pos: number;
  protos: FnProto[];
  selectedLine: number | null;
  forkPoints: number[];
  matches: number[];
  highlightFn: number | null;
}

const OVERVIEW_H = 20;
const GAP = 4;

function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const palette: string[] = [];
  for (let i = 1; i <= 8; i++) palette.push(v(`--flame-${i}`));
  return {
    bg: v('--scrub-bg'),
    grid: v('--line-soft'),
    past: v('--scrub-past'),
    future: v('--scrub-future'),
    mark: v('--scrub-mark'),
    fork: v('--fork'),
    forkBg: v('--fork-bg'),
    text: v('--text'),
    flameText: v('--flame-text'),
    internal: v('--flame-internal'),
    main: v('--flame-main'),
    playhead: v('--playhead'),
    accent: v('--accent'),
    error: v('--error'),
    limit: v('--warn'),
    window: v('--line'),
    palette,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class FlameChart {
  private model: FlameModel | null = null;
  private v0 = 0;
  private v1 = 1;
  private viewKey = '';
  private dragging: 'flame' | 'overview' | null = null;
  private overviewCache: { key: string; depth: Uint16Array; maxDepth: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private tip: HTMLElement,
    private onSeek: (pos: number) => void,
  ) {
    new ResizeObserver(() => this.draw()).observe(canvas);

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.model) return;
      this.dragging = e.offsetY < OVERVIEW_H ? 'overview' : 'flame';
      canvas.setPointerCapture(e.pointerId);
      this.seekAt(e.offsetX, this.dragging);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.model) return;
      this.showTip(e.offsetX, e.offsetY);
      if (this.dragging) {
        this.seekAt(e.offsetX, this.dragging);
      }
    });
    const stop = (e: PointerEvent) => {
      this.dragging = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) this.tip.hidden = true;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.model) return;
        e.preventDefault();
        const total = this.total;
        const span = this.v1 - this.v0;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = ((e.shiftKey ? e.deltaY : e.deltaX) / canvas.clientWidth) * span;
          this.setView(this.v0 + d, this.v1 + d);
        } else {
          const at = this.v0 + (e.offsetX / canvas.clientWidth) * span;
          const factor = Math.exp(e.deltaY * 0.0025);
          const next = Math.min(total, Math.max(Math.min(12, total), span * factor));
          const k = (at - this.v0) / span;
          this.setView(at - k * next, at - k * next + next);
        }
        this.draw();
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', (e) => {
      if (!this.model || e.offsetY < OVERVIEW_H) return;
      const c = this.callAt(e.offsetX, e.offsetY);
      if (c && c.e > c.s) {
        const pad = Math.max(1, (c.e - c.s) * 0.04);
        this.setView(c.s - pad, c.e + pad);
      } else {
        this.setView(0, this.total);
      }
      this.draw();
    });
  }

  private get total(): number {
    return this.model ? this.model.tl.endPos + 1 : 1;
  }

  /** Programmatic zoom-out. */
  resetZoom(): void {
    this.setView(0, this.total);
    this.draw();
  }

  get zoomed(): boolean {
    return this.v1 - this.v0 < this.total - 0.5;
  }

  private setView(a: number, b: number): void {
    const total = this.total;
    const span = Math.min(total, Math.max(1, b - a));
    a = Math.max(0, Math.min(a, total - span));
    this.v0 = a;
    this.v1 = a + span;
  }

  setModel(model: FlameModel): void {
    const key = `${model.tl.id}:${model.tl.endPos}`;
    const prev = this.model;
    this.model = model;
    if (key !== this.viewKey) {
      // new timeline: keep the zoom if it is a fork of what we were looking at
      const keep = prev && (model.tl.parent === prev.tl || prev.tl.parent === model.tl);
      this.viewKey = key;
      if (!keep) this.setView(0, this.total);
      else this.setView(this.v0, this.v1);
    }
    // follow the playhead
    if (model.pos < this.v0 || model.pos + 1 > this.v1) {
      const span = this.v1 - this.v0;
      this.setView(model.pos - span * 0.3, model.pos - span * 0.3 + span);
    }
    this.draw();
  }

  // ------------------------------------------------------------ geometry

  private rowHeight(): number {
    const h = this.canvas.clientHeight - OVERVIEW_H - GAP;
    const depth = this.maxDepth();
    return Math.max(3, Math.min(17, Math.floor(h / Math.max(1, depth))));
  }

  private maxDepth(): number {
    const tl = this.model!.tl;
    let d = 1;
    for (const c of tl.calls) if (c.depth > d) d = c.depth;
    return d;
  }

  private posAtX(x: number, overview: boolean): number {
    const w = this.canvas.clientWidth || 1;
    const p = overview ? (x / w) * this.total : this.v0 + (x / w) * (this.v1 - this.v0);
    return Math.max(0, Math.min(this.total - 1, Math.floor(p)));
  }

  private seekAt(x: number, where: 'flame' | 'overview'): void {
    this.onSeek(this.posAtX(x, where === 'overview'));
  }

  private callAt(x: number, y: number): CallRecord | null {
    const m = this.model!;
    const rowH = this.rowHeight();
    const depth = Math.floor((y - OVERVIEW_H - GAP) / rowH) + 1;
    if (depth < 2) return null;
    const p = this.v0 + (x / this.canvas.clientWidth) * (this.v1 - this.v0);
    let best: CallRecord | null = null;
    for (const c of m.tl.calls) {
      if (c.depth === depth && c.s <= p && p < Math.max(c.e, c.s + 1)) best = c;
    }
    return best;
  }

  private label(c: CallRecord): string {
    const proto = this.model!.protos[c.fn];
    return `${proto?.name ?? '?'}(${c.args})`;
  }

  private showTip(x: number, y: number): void {
    const m = this.model!;
    const tl = m.tl;
    let text: string;
    if (y >= OVERVIEW_H) {
      const c = this.callAt(x, y);
      if (c) {
        const n = c.e - c.s;
        text = `${this.label(c)} · steps ${c.s}–${Math.max(c.s, c.e - 1)} (${n} step${n === 1 ? '' : 's'}) · double-click to zoom`;
        this.place(x, text);
        return;
      }
    }
    const p = this.posAtX(x, y < OVERVIEW_H);
    text =
      p >= tl.endPos
        ? `end · ${tl.end.kind === 'error' ? 'error' : tl.end.kind === 'limit' ? 'step limit' : 'finished'}`
        : `step ${p.toLocaleString()} · line ${tl.lines[p]}`;
    this.place(x, text);
  }

  private place(x: number, text: string): void {
    this.tip.hidden = false;
    this.tip.textContent = text;
    const w = this.canvas.clientWidth;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.max(tw / 2, Math.min(w - tw / 2, x))}px`;
  }

  // ------------------------------------------------------------- drawing

  draw(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth));
    const h = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = theme();
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.model) return;
    const m = this.model;
    const tl = m.tl;
    const total = this.total;

    this.drawOverview(ctx, C, w);

    // ----- flame area
    const top = OVERVIEW_H + GAP;
    const rowH = this.rowHeight();
    const span = this.v1 - this.v0;
    const X = (p: number) => ((p - this.v0) / span) * w;
    const playX = X(m.pos + 0.5);

    if (tl.parent) {
      const fx = X(tl.forkPos);
      if (fx > 0) {
        ctx.fillStyle = C.forkBg;
        ctx.fillRect(0, top, Math.min(w, fx), h - top);
      }
    }

    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';

    // main row
    ctx.fillStyle = C.main;
    ctx.fillRect(Math.max(0, X(0)), top, Math.min(w, X(total)) - Math.max(0, X(0)), rowH - 1);
    if (rowH >= 11) {
      ctx.fillStyle = C.flameText;
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText('main', Math.max(0, X(0)) + 4, top + rowH / 2);
    }

    const charW = 6.6;
    let lastPx = new Map<number, number>();
    for (const c of tl.calls) {
      if (c.e <= this.v0 || c.s >= this.v1) continue;
      const x0 = X(c.s);
      const x1 = X(Math.max(c.e, c.s + 0.25));
      const bw = x1 - x0;
      const y = top + (c.depth - 1) * rowH;
      if (y > h) continue;
      // merge sub-pixel boxes on the same row
      if (bw < 1) {
        const px = Math.floor(x0);
        if (lastPx.get(c.depth) === px) continue;
        lastPx.set(c.depth, px);
      }
      const proto = m.protos[c.fn];
      const internal = !!proto?.internal;
      ctx.globalAlpha = c.s > m.pos ? 0.45 : m.highlightFn !== null && m.highlightFn !== c.fn ? 0.35 : 1;
      ctx.fillStyle = internal ? C.internal : C.palette[hash(proto?.name ?? '') % C.palette.length];
      ctx.fillRect(x0, y, Math.max(1, bw - (bw > 3 ? 1 : 0)), rowH - 1);
      if (bw > 30 && rowH >= 11) {
        const text = this.label(c);
        const maxChars = Math.floor((bw - 8) / charW);
        if (maxChars >= 2) {
          ctx.fillStyle = C.flameText;
          ctx.fillText(text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text, Math.max(x0, 0) + 4, y + rowH / 2);
        }
      }
    }
    ctx.globalAlpha = 1;
    lastPx = new Map();

    // query matches & selected-line hits as ticks along the bottom of the flame area
    const tick = (positions: Iterable<number>, color: string, yy: number) => {
      ctx.fillStyle = color;
      let last = -2;
      for (const p of positions) {
        if (p < this.v0 || p >= this.v1) continue;
        const x = Math.floor(X(p + 0.5));
        if (x === last) continue;
        last = x;
        ctx.fillRect(x, yy, 1, 4);
      }
    };
    if (m.matches.length) tick(m.matches, C.accent, h - 5);

    // fork points
    ctx.fillStyle = C.fork;
    for (const fp of [...m.forkPoints, ...(tl.parent ? [tl.forkPos] : [])]) {
      const x = X(fp + 0.5);
      if (x >= 0 && x <= w) ctx.fillRect(Math.round(x) - 1, top, 2, h - top);
    }

    // playhead
    ctx.fillStyle = C.playhead;
    ctx.fillRect(Math.round(playX) - 1, 0, 2, h);
  }

  private drawOverview(ctx: CanvasRenderingContext2D, C: ReturnType<typeof theme>, w: number): void {
    const m = this.model!;
    const tl = m.tl;
    const total = this.total;
    const key = `${tl.id}:${tl.endPos}:${w}`;
    if (this.overviewCache?.key !== key) {
      const depth = new Uint16Array(w);
      let maxDepth = 1;
      for (let x = 0; x < w; x++) {
        const p0 = Math.floor((x * total) / w);
        const p1 = Math.max(p0 + 1, Math.floor(((x + 1) * total) / w));
        let d = 0;
        for (let p = p0; p < p1 && p < tl.endPos; p++) if (tl.depths[p] > d) d = tl.depths[p];
        depth[x] = d;
        if (d > maxDepth) maxDepth = d;
      }
      this.overviewCache = { key, depth, maxDepth };
    }
    const { depth, maxDepth } = this.overviewCache;
    const H = OVERVIEW_H - 2;
    const playX = ((m.pos + 0.5) / total) * w;
    for (let x = 0; x < w; x++) {
      const d = depth[x];
      if (!d) continue;
      const bh = Math.max(2, (H * d) / maxDepth);
      ctx.fillStyle = x <= playX ? C.past : C.future;
      ctx.fillRect(x, OVERVIEW_H - 1 - bh, 1, bh);
    }
    const Xo = (p: number) => ((p + 0.5) / total) * w;
    const ticks = (positions: Iterable<number>, color: string, y: number, hgt: number) => {
      ctx.fillStyle = color;
      let last = -2;
      for (const p of positions) {
        const x = Math.floor(Xo(p));
        if (x === last) continue;
        last = x;
        ctx.fillRect(x, y, 1, hgt);
      }
    };
    ticks(
      tl.outputs.map((o) => o.pos),
      C.mark,
      0,
      4,
    );
    if (m.selectedLine !== null) {
      const hits: number[] = [];
      for (let p = 0; p < tl.endPos; p++) if (tl.lines[p] === m.selectedLine) hits.push(p);
      ticks(hits, C.text, 0, 3);
    }
    if (m.matches.length) ticks(m.matches, C.accent, 0, OVERVIEW_H);
    ctx.fillStyle = C.fork;
    for (const fp of [...m.forkPoints, ...(tl.parent ? [tl.forkPos] : [])]) ctx.fillRect(Math.round(Xo(fp)), 0, 2, OVERVIEW_H);
    if (tl.end.kind !== 'done') {
      ctx.fillStyle = tl.end.kind === 'error' ? C.error : C.limit;
      ctx.fillRect(w - 3, 0, 3, OVERVIEW_H);
    }
    // zoom window
    if (this.zoomed) {
      const a = (this.v0 / total) * w;
      const b = (this.v1 / total) * w;
      ctx.strokeStyle = C.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(2, b - a - 1), OVERVIEW_H - 1);
    }
    ctx.fillStyle = C.playhead;
    ctx.fillRect(Math.round(playX) - 1, 0, 2, OVERVIEW_H);
    // separator
    ctx.fillStyle = C.grid;
    ctx.fillRect(0, OVERVIEW_H + GAP / 2, w, 1);
  }
}
