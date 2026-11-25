/**
 * Time travel & the multiverse.
 *
 * A `Timeline` is one recorded execution of a program. While recording we
 * keep only cheap per-statement metadata (line, call depth, current
 * function), the program's printed output, a trace of variable writes and the
 * call tree. Every `checkpointEvery` statements a full machine snapshot is
 * stored.
 *
 * To travel to position `p`, we restore the nearest checkpoint at or before
 * `p` and deterministically replay forward — never more than
 * `checkpointEvery` statements, so seeking is effectively instant.
 *
 * A *fork* takes the machine state at some position, edits a variable, and
 * records a brand new timeline from there. The prefix (metadata, outputs,
 * checkpoints, finished calls) is shared with the parent.
 *
 * Positions: for a timeline with N recorded statements, positions 0..N-1 are
 * "about to execute statement #p" and position N is the end of the timeline
 * (program finished, crashed, or hit the step limit).
 */

import { compile, compileExpressionInto } from './compiler';
import type { Expr } from './ast';
import { EvalError, evaluateReadOnly, parseWatch } from './evaluate';
import { LoomSyntaxError } from './lexer';
import { parseExpression } from './parser';
import { formatValue, isRef, truthy, type Value } from './values';
import { cloneState, LoomRuntimeError, VM, type RuntimeErrorInfo, type VMHooks, type VMState } from './vm';

export interface OutputLine {
  /** statement position during which the text was printed */
  pos: number;
  text: string;
}

export type WriteRecord =
  | { pos: number; kind: 'bind'; name: string; env: number; value: Value }
  | { pos: number; kind: 'fork'; name: string; env: number; value: Value }
  | { pos: number; kind: 'mut'; obj: number };

export interface SeriesPoint {
  /** statement position that wrote the value */
  pos: number;
  value: number;
  /** first position at which the variable holds this value */
  visibleFrom: number;
}

/** One function call: it was active for positions s <= p < e. */
export interface CallRecord {
  fn: number;
  s: number;
  e: number;
  /** call depth of the callee (main is 1) */
  depth: number;
  /** short rendering of the arguments */
  args: string;
}

export interface ProfileRow {
  fn: number;
  name: string;
  internal: boolean;
  calls: number;
  /** statements executed directly in this function */
  self: number;
  /** statements executed while this function was on the stack */
  total: number;
}

export interface BreakpointSpec {
  line: number;
  condition?: string;
}

export interface ConsoleResult {
  value: string | null;
  output: string[];
  error: string | null;
}

export type TimelineEnd = { kind: 'done' } | { kind: 'error'; error: RuntimeErrorInfo } | { kind: 'limit' };

export interface MultiverseOptions {
  maxEvents?: number;
  checkpointEvery?: number;
  seed?: number;
}

interface Checkpoint {
  pos: number;
  state: VMState;
}

const clone = cloneState;

export class Timeline {
  lines: number[] = [];
  depths: number[] = [];
  /** prototype index of the innermost frame at each position */
  fns: number[] = [];
  checkpoints: Checkpoint[] = [];
  outputs: OutputLine[] = [];
  writes: WriteRecord[] = [];
  /** every function call, in order of entry */
  calls: CallRecord[] = [];
  end: TimelineEnd = { kind: 'done' };
  endState!: VMState;
  /** wall-clock time spent recording, ms */
  recordMs = 0;
  private hitCache: Map<number, number> | null = null;

  constructor(
    readonly id: number,
    readonly parent: Timeline | null,
    /** position in the parent where this timeline branched off (-1 for the root) */
    readonly forkPos: number,
    readonly label: string,
  ) {}

  /** Final position index (the end state). */
  get endPos(): number {
    return this.lines.length;
  }

  lineAt(pos: number): number {
    return pos >= this.lines.length ? this.endState.line : this.lines[pos];
  }

  depthAt(pos: number): number {
    return pos >= this.depths.length ? this.endState.frames.length : this.depths[pos];
  }

  /** How many times each source line was reached. */
  lineHits(): Map<number, number> {
    if (!this.hitCache) {
      const m = new Map<number, number>();
      for (const l of this.lines) m.set(l, (m.get(l) ?? 0) + 1);
      this.hitCache = m;
    }
    return this.hitCache;
  }

  // ----------------------------------------------------------- navigation

  /** Step over: next position at the same or shallower call depth. */
  stepOver(pos: number): number {
    const d = this.depthAt(pos);
    for (let p = pos + 1; p < this.lines.length; p++) if (this.depths[p] <= d) return p;
    return this.endPos;
  }

  stepOverBack(pos: number): number {
    const d = this.depthAt(pos);
    for (let p = Math.min(pos, this.lines.length) - 1; p >= 0; p--) if (this.depths[p] <= d) return p;
    return 0;
  }

  /** Step out: first position after the current function returns. */
  stepOut(pos: number): number {
    const d = this.depthAt(pos);
    for (let p = pos + 1; p < this.lines.length; p++) if (this.depths[p] < d) return p;
    return this.endPos;
  }

  /** Reverse step out: the position where the current call was entered from. */
  stepOutBack(pos: number): number {
    const d = this.depthAt(pos);
    for (let p = Math.min(pos, this.lines.length) - 1; p >= 0; p--) if (this.depths[p] < d) return p;
    return 0;
  }

  nextHitOfLine(pos: number, line: number): number | null {
    for (let p = pos + 1; p < this.lines.length; p++) if (this.lines[p] === line) return p;
    return null;
  }

  prevHitOfLine(pos: number, line: number): number | null {
    for (let p = Math.min(pos, this.lines.length) - 1; p >= 0; p--) if (this.lines[p] === line) return p;
    return null;
  }

  /** Output visible at a position (everything printed by already-completed statements). */
  outputsBefore(pos: number): number {
    let lo = 0;
    let hi = this.outputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.outputs[mid].pos < pos) lo = mid + 1;
      else hi = mid;
    }
    return pos >= this.endPos ? this.outputs.length : lo;
  }

  /**
   * Reverse watchpoint: the most recent statement before `pos` that changed
   * the binding (`name` in `env`) or mutated the object it currently holds.
   */
  previousChange(pos: number, name: string, env: number, current: Value): WriteRecord | null {
    const obj = isRef(current) ? current.r : -1;
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const w = this.writes[i];
      if (w.pos >= pos) continue;
      if (w.kind === 'mut' ? w.obj === obj : w.name === name && w.env === env) return w;
    }
    return null;
  }

  /** Forward watchpoint: the next statement at or after `pos` that changes it. */
  nextChange(pos: number, name: string, env: number, current: Value): WriteRecord | null {
    const obj = isRef(current) ? current.r : -1;
    for (const w of this.writes) {
      if (w.pos < pos) continue;
      if (w.kind === 'mut' ? w.obj === obj : w.name === name && w.env === env) return w;
    }
    return null;
  }

  /** Every numeric value ever assigned to a variable with this name (any scope). */
  numericSeries(name: string): SeriesPoint[] {
    const out: SeriesPoint[] = [];
    for (const w of this.writes) {
      if (w.kind !== 'mut' && w.name === name && typeof w.value === 'number' && Number.isFinite(w.value)) {
        // a normal write is visible once its statement completes; a fork edit is visible immediately
        out.push({ pos: w.pos, value: w.value, visibleFrom: w.kind === 'fork' ? w.pos : w.pos + 1 });
      }
    }
    return out;
  }

  /** First output index where this timeline's output differs from its parent's. */
  divergence(): number | null {
    if (!this.parent) return null;
    const a = this.outputs;
    const b = this.parent.outputs;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i]?.text !== b[i]?.text) return i;
    }
    return null;
  }

  /** Calls active at a position, outermost first. */
  callsAt(pos: number): CallRecord[] {
    return this.calls.filter((c) => c.s <= pos && pos < c.e);
  }

  /**
   * Per-function statistics. "total" counts each statement once per function
   * even under recursion (nested calls of the same function are not re-added).
   */
  profile(vm: VM): ProfileRow[] {
    const rows = new Map<number, ProfileRow>();
    const row = (fn: number): ProfileRow => {
      let r = rows.get(fn);
      if (!r) {
        const proto = vm.program.protos[fn];
        r = { fn, name: proto.name, internal: !!proto.internal, calls: 0, self: 0, total: 0 };
        rows.set(fn, r);
      }
      return r;
    };
    for (const f of this.fns) row(f).self++;
    const coveredUntil = new Map<number, number>();
    for (const c of this.calls) {
      const r = row(c.fn);
      r.calls++;
      if (c.s >= (coveredUntil.get(c.fn) ?? -1)) {
        r.total += c.e - c.s;
        coveredUntil.set(c.fn, c.e);
      }
    }
    const main = row(vm.program.main);
    main.calls = 1;
    main.total = this.endPos;
    return [...rows.values()].sort((a, b) => b.total - a.total || b.self - a.self);
  }

  ancestry(): Timeline[] {
    const out: Timeline[] = [];
    let t: Timeline | null = this;
    while (t) {
      out.unshift(t);
      t = t.parent;
    }
    return out;
  }
}

export class Multiverse {
  readonly vm: VM;
  readonly timelines: Timeline[] = [];
  readonly maxEvents: number;
  readonly checkpointEvery: number;
  readonly seed: number;

  constructor(
    readonly source: string,
    opts: MultiverseOptions = {},
  ) {
    this.maxEvents = opts.maxEvents ?? 100_000;
    this.checkpointEvery = opts.checkpointEvery ?? 64;
    this.seed = opts.seed ?? 0x10c0ffee;
    this.vm = new VM(compile(source));
    const root = new Timeline(0, null, -1, 'origin');
    this.timelines.push(root);
    const state = this.vm.initialState(this.seed);
    root.checkpoints.push({ pos: -1, state: clone(state) });
    this.record(root, state);
  }

  get root(): Timeline {
    return this.timelines[0];
  }

  /** Run a timeline forward from `state`, recording everything. */
  private record(tl: Timeline, state: VMState, open: CallRecord[] = []): void {
    const t0 = performance.now();
    const fmt = { quote: true, maxDepth: 1, maxItems: 3, fnName: this.vm.fnName };
    const hooks: VMHooks = {
      print: (text) => tl.outputs.push({ pos: state.event - 1, text }),
      bind: (name, env, value, internal) => {
        if (!internal && name[0] !== '$') tl.writes.push({ pos: state.event - 1, kind: 'bind', name, env, value });
      },
      mutate: (obj) => tl.writes.push({ pos: state.event - 1, kind: 'mut', obj }),
      call: (fn, args) => {
        let shown = args.map((a) => formatValue(state.heap, a, fmt)).join(', ');
        if (shown.length > 60) shown = shown.slice(0, 59) + '…';
        const c: CallRecord = { fn, s: state.event, e: -1, depth: state.frames.length, args: shown };
        tl.calls.push(c);
        open.push(c);
      },
      ret: () => {
        const c = open.pop();
        if (c) c.e = state.event;
      },
    };
    const K = this.checkpointEvery;
    while (true) {
      if (tl.lines.length >= this.maxEvents) {
        tl.end = { kind: 'limit' };
        break;
      }
      if (!this.vm.stepEvent(state, hooks)) {
        tl.end = state.error ? { kind: 'error', error: state.error } : { kind: 'done' };
        break;
      }
      const pos = state.event - 1;
      tl.lines.push(state.line);
      tl.depths.push(state.frames.length);
      tl.fns.push(state.frames[state.frames.length - 1].f);
      if (pos % K === 0) tl.checkpoints.push({ pos, state: clone(state) });
    }
    for (const c of open) c.e = tl.lines.length;
    tl.endState = clone(state);
    tl.recordMs = performance.now() - t0;
  }

  /**
   * Materialise the machine state at a position. The returned state is a
   * private copy; callers may mutate it. Pass `from` (a state known to be at
   * position `fromPos` on the same timeline) to step forward incrementally
   * instead of restoring a checkpoint.
   */
  stateAt(tl: Timeline, pos: number, from?: { pos: number; state: VMState }): VMState {
    pos = Math.max(0, Math.min(pos, tl.endPos));
    if (pos === tl.endPos) return clone(tl.endState);

    // find the latest checkpoint <= pos (binary search; checkpoints are sorted)
    const cps = tl.checkpoints;
    let lo = 0;
    let hi = cps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cps[mid].pos <= pos) lo = mid;
      else hi = mid - 1;
    }
    const cp = cps[lo];

    let state: VMState;
    if (from && from.pos <= pos && from.pos >= cp.pos && from.pos < tl.endPos) {
      state = from.state; // continue stepping the caller's own copy
    } else {
      state = clone(cp.state);
    }
    while (state.event < pos + 1 && !state.halted) {
      this.vm.stepEvent(state);
    }
    return state;
  }

  /**
   * Create a new timeline: take the state at `pos` in `parent`, set variable
   * `name` (visible from `frameIndex`) to the value of `valueSource`, and run.
   */
  fork(parent: Timeline, pos: number, frameIndex: number, name: string, valueSource: string): Timeline {
    if (pos >= parent.endPos) throw new Error('Cannot fork at the end of a timeline — step back first');
    const state = this.stateAt(parent, pos);
    const value = this.vm.materialize(state, parseExpression(valueSource));
    const env = this.vm.assignVariable(state, frameIndex, name, value);
    const shown = this.vm.format(state, value, true);
    const label = `${name} = ${shown.length > 24 ? shown.slice(0, 23) + '…' : shown}`;

    const tl = new Timeline(this.timelines.length, parent, pos, label);
    tl.lines = parent.lines.slice(0, pos + 1);
    tl.depths = parent.depths.slice(0, pos + 1);
    tl.fns = parent.fns.slice(0, pos + 1);
    tl.checkpoints = parent.checkpoints.filter((c) => c.pos < pos);
    tl.checkpoints.push({ pos, state: clone(state) });
    tl.outputs = parent.outputs.filter((o) => o.pos < pos);
    tl.writes = parent.writes.filter((w) => w.pos < pos);
    tl.writes.push({ pos, kind: 'fork', name, env, value });

    // Calls that finished before the fork are shared; calls still running at
    // the fork point are re-opened, because their ending changes.
    const open: CallRecord[] = [];
    for (const c of parent.calls) {
      if (c.s > pos) continue;
      if (c.e <= pos) tl.calls.push(c);
      else {
        const copy = { ...c, e: -1 };
        tl.calls.push(copy);
        open.push(copy);
      }
    }
    this.timelines.push(tl);
    this.record(tl, state, open);
    return tl;
  }

  // ------------------------------------------------------------ inspection

  /**
   * Omniscient search: every position at which `source` (evaluated in the
   * innermost frame) is truthy. One deterministic replay of the timeline.
   */
  query(tl: Timeline, source: string, limit = 50_000): { matches: number[]; error: string | null } {
    let expr: Expr;
    try {
      expr = parseWatch(source);
    } catch (e) {
      return { matches: [], error: (e as Error).message };
    }
    const matches: number[] = [];
    let lastError: string | null = null;
    let evaluated = 0;
    const test = (s: VMState): boolean => {
      try {
        const v = evaluateReadOnly(this.vm, s, s.frames.length - 1, expr);
        evaluated++;
        return truthy(v);
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        lastError = e.message;
        return false;
      }
    };
    if (tl.endPos > 0) {
      const state = this.stateAt(tl, 0);
      for (let p = 0; p < tl.endPos; p++) {
        if (p > 0) this.vm.stepEvent(state);
        if (test(state) && matches.push(p) >= limit) break;
      }
    }
    if (matches.length < limit && test(tl.endState)) matches.push(tl.endPos);
    return { matches, error: evaluated === 0 ? lastError : null };
  }

  /**
   * Find the next (dir = 1) or previous (dir = -1) position that hits a
   * breakpoint whose condition (if any) is true there.
   */
  findBreakpoint(tl: Timeline, from: number, dir: 1 | -1, breakpoints: BreakpointSpec[]): { pos: number } | { error: string } | null {
    const byLine = new Map<number, Expr | null>();
    for (const bp of breakpoints) {
      if (bp.condition && bp.condition.trim()) {
        try {
          byLine.set(bp.line, parseWatch(bp.condition));
        } catch (e) {
          return { error: `Breakpoint on line ${bp.line}: ${(e as Error).message}` };
        }
      } else byLine.set(bp.line, null);
    }
    if (byLine.size === 0) return null;
    const hit = (s: VMState, cond: Expr): boolean => {
      try {
        return truthy(evaluateReadOnly(this.vm, s, s.frames.length - 1, cond));
      } catch {
        return false;
      }
    };
    if (dir === 1) {
      let first = -1;
      for (let p = from + 1; p < tl.endPos; p++) {
        if (byLine.has(tl.lines[p])) {
          first = p;
          break;
        }
      }
      if (first < 0) return null;
      const state = this.stateAt(tl, first);
      for (let p = first; p < tl.endPos; p++) {
        if (p > first) this.vm.stepEvent(state);
        if (!byLine.has(tl.lines[p])) continue;
        const cond = byLine.get(tl.lines[p]);
        if (!cond || hit(state, cond)) return { pos: p };
      }
      return null;
    }
    for (let p = Math.min(from, tl.endPos) - 1; p >= 0; p--) {
      if (!byLine.has(tl.lines[p])) continue;
      const cond = byLine.get(tl.lines[p]);
      if (!cond || hit(this.stateAt(tl, p), cond)) return { pos: p };
    }
    return null;
  }

  /**
   * The time-travel console: evaluate any expression (including calls to
   * the program's own functions) as if it ran at `pos` inside the given
   * frame. Runs on a private copy, so the recording is never affected.
   */
  evaluate(tl: Timeline, pos: number, frameIndex: number, source: string): ConsoleResult {
    const output: string[] = [];
    try {
      const { program, entry } = compileExpressionInto(this.vm.program, source);
      const vm = new VM(program);
      const s = this.stateAt(tl, pos);
      s.halted = false;
      s.error = null;
      const index = Math.min(Math.max(0, frameIndex), s.frames.length - 1);
      const frame = s.frames[index];
      s.frames.length = index + 1; // work directly above the chosen frame
      const depth = s.frames.length;
      s.frames.push({ f: entry, ip: 0, env: frame.env, base: s.stack.length, callLine: 0, h: [] });
      const value = vm.runUntilReturn(s, depth, { print: (text) => output.push(text) });
      return { value: vm.format(s, value, true), output, error: null };
    } catch (e) {
      if (e instanceof LoomSyntaxError || e instanceof LoomRuntimeError) return { value: null, output, error: e.message };
      throw e;
    }
  }
}

/**
 * A movable read head over a timeline that keeps its own live state, so
 * stepping forward one statement at a time costs one statement of work.
 */
export class Cursor {
  pos = 0;
  state: VMState;

  constructor(
    readonly mv: Multiverse,
    public tl: Timeline,
  ) {
    this.state = mv.stateAt(tl, 0);
  }

  seek(pos: number, tl: Timeline = this.tl): VMState {
    pos = Math.max(0, Math.min(pos, tl.endPos));
    const sameTl = tl === this.tl;
    const hint =
      sameTl && pos > this.pos && pos - this.pos <= this.mv.checkpointEvery * 2
        ? { pos: this.pos, state: this.state }
        : undefined;
    this.state = this.mv.stateAt(tl, pos, hint);
    this.tl = tl;
    this.pos = pos;
    return this.state;
  }
}
