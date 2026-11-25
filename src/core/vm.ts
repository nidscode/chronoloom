/**
 * The Loom virtual machine.
 *
 * The VM itself is stateless: all mutable machine state lives in a plain
 * `VMState` object, which can be deep-copied with `structuredClone`. That one
 * property is what makes time travel and timeline forking possible — any
 * moment of execution can be frozen, restored, edited and resumed.
 *
 * Execution is deterministic: the only source of nondeterminism (random
 * numbers) is a seeded PRNG whose state lives in the snapshot too.
 */

import type { Expr } from './ast';
import type { CompiledProgram, Instr } from './bytecode';
import {
  formatNumber,
  formatValue,
  isRef,
  truthy,
  typeName,
  valuesEqual,
  type Heap,
  type HeapObj,
  type Ref,
  type Value,
} from './values';

export interface Frame {
  /** prototype index */
  f: number;
  ip: number;
  /** current innermost environment */
  env: number;
  /** stack height to restore on return */
  base: number;
  /** line in the caller where this frame was called from */
  callLine: number;
  /** active exception handlers (innermost last) */
  h: Handler[];
}

export interface Handler {
  /** where to jump when an exception is caught */
  ip: number;
  /** stack height to restore */
  sp: number;
  /** environment to restore */
  env: number;
}

export interface RuntimeErrorInfo {
  message: string;
  line: number;
}

export interface VMState {
  frames: Frame[];
  stack: Value[];
  heap: Heap;
  nextId: number;
  gcAt: number;
  /** number of statement boundaries (LINE instructions) executed so far */
  event: number;
  /** source line of the statement about to execute */
  line: number;
  halted: boolean;
  error: RuntimeErrorInfo | null;
  rng: number;
  preludeEnv: number;
  globalEnv: number;
}

/** Observers invoked while *recording* a timeline (never during replay). */
export interface VMHooks {
  print?(text: string): void;
  /** a variable was defined or assigned; `internal` is true for standard-library code */
  bind?(name: string, env: number, value: Value, internal: boolean): void;
  mutate?(obj: number): void;
  /** a Loom function was entered (after its frame was pushed) */
  call?(fn: number, args: Value[]): void;
  /** a Loom function frame was popped (by return or by an exception unwinding it) */
  ret?(): void;
}

export interface ScopeView {
  envId: number;
  kind: 'block' | 'locals' | 'closure' | 'globals';
  vars: [string, Value][];
}

export class LoomRuntimeError extends Error {
  constructor(
    message: string,
    /** fatal errors cannot be caught by try/catch */
    public fatal = false,
  ) {
    super(message);
    this.name = 'LoomRuntimeError';
  }
}

const MAX_DEPTH = 300;
const MAX_OPS_PER_STATEMENT = 2_000_000;
const MAX_COLLECTION = 1_000_000;

type Builtin = (vm: VM, s: VMState, args: Value[], hooks: VMHooks | undefined) => Value;

function fail(message: string): never {
  throw new LoomRuntimeError(message);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export class VM {
  readonly builtins: Record<string, Builtin>;

  constructor(readonly program: CompiledProgram) {
    this.builtins = createBuiltins();
  }

  // ------------------------------------------------------------- state

  initialState(seed = 0x10c0ffee): VMState {
    const s: VMState = {
      frames: [],
      stack: [],
      heap: new Map(),
      nextId: 1,
      gcAt: 4000,
      event: 0,
      line: 0,
      halted: false,
      error: null,
      rng: seed | 0,
      preludeEnv: 0,
      globalEnv: 0,
    };
    const prelude: Record<string, Value> = {};
    s.preludeEnv = this.alloc(s, { t: 'env', v: prelude, p: null });
    for (const name of Object.keys(this.builtins)) {
      prelude[name] = { r: this.alloc(s, { t: 'bi', n: name }) };
    }
    prelude.PI = Math.PI;
    // run the standard library (written in Loom) into the prelude scope
    if (this.program.prelude >= 0) {
      s.frames.push({ f: this.program.prelude, ip: 0, env: s.preludeEnv, base: 0, callLine: 0, h: [] });
      const protos = this.program.protos;
      while (!s.halted) {
        const frame = s.frames[s.frames.length - 1];
        this.exec(s, frame, protos[frame.f].code[frame.ip++]);
      }
      s.halted = false;
      s.line = 0;
      s.stack = [];
      s.frames = [];
    }
    s.globalEnv = this.alloc(s, { t: 'env', v: {}, p: s.preludeEnv });
    s.frames.push({ f: this.program.main, ip: 0, env: s.globalEnv, base: 0, callLine: 0, h: [] });
    return s;
  }

  alloc(s: VMState, obj: HeapObj): number {
    const id = s.nextId++;
    s.heap.set(id, obj);
    return id;
  }

  newArray(s: VMState, items: Value[]): Ref {
    if (items.length > MAX_COLLECTION) fail(`Array too large (${items.length} elements)`);
    return { r: this.alloc(s, { t: 'arr', v: items }) };
  }

  get(s: VMState, v: Value): HeapObj | undefined {
    return isRef(v) ? s.heap.get(v.r) : undefined;
  }

  fnName = (protoIndex: number): string => this.program.protos[protoIndex]?.name ?? '?';

  format(s: VMState, v: Value, quote = false): string {
    return formatValue(s.heap, v, { quote, fnName: this.fnName });
  }

  // --------------------------------------------------------- execution

  /**
   * Run until the next statement boundary. Returns true if a new statement
   * was reached, false if the program halted (normally or with an error).
   */
  stepEvent(s: VMState, hooks?: VMHooks): boolean {
    if (s.halted) return false;
    let budget = MAX_OPS_PER_STATEMENT;
    const protos = this.program.protos;
    while (true) {
      const frame = s.frames[s.frames.length - 1];
      const ins: Instr = protos[frame.f].code[frame.ip++];
      try {
        if (this.exec(s, frame, ins, hooks)) return true;
        if (s.halted) return false;
        if (--budget <= 0) {
          throw new LoomRuntimeError('Too many operations without reaching a new statement (possible runaway computation)', true);
        }
      } catch (e) {
        if (!(e instanceof LoomRuntimeError)) throw e;
        const line = ins.line || this.userLine(s);
        if (!e.fatal && this.hasHandler(s)) {
          // runtime errors become catchable values: {message, line}
          const err: Ref = { r: this.alloc(s, { t: 'rec', v: { message: e.message, line } }) };
          this.unwind(s, err, hooks);
          continue;
        }
        s.error = { message: e.message, line };
        s.line = line;
        s.halted = true;
        return false;
      }
    }
  }

  /** Is there an active try/catch anywhere on the call stack? */
  hasHandler(s: VMState): boolean {
    for (let i = this.handlerFloor; i < s.frames.length; i++) if (s.frames[i].h.length) return true;
    return false;
  }

  /** Frames below this index are off-limits to exception handling (see runUntilReturn). */
  private handlerFloor = 0;

  /**
   * Run the topmost frame(s) until the stack shrinks back to `depth` frames,
   * then return the value the last frame returned. Used by the console to
   * call into the program from an arbitrary paused moment. Exceptions may
   * only be caught by frames above `depth`; anything else is thrown out as
   * a LoomRuntimeError.
   */
  runUntilReturn(s: VMState, depth: number, hooks?: VMHooks, maxOps = 5_000_000): Value {
    const protos = this.program.protos;
    const savedFloor = this.handlerFloor;
    this.handlerFloor = depth;
    try {
      let ops = 0;
      while (s.frames.length > depth) {
        const frame = s.frames[s.frames.length - 1];
        const ins = protos[frame.f].code[frame.ip++];
        try {
          this.exec(s, frame, ins, hooks);
        } catch (e) {
          if (!(e instanceof LoomRuntimeError) || e.fatal || !this.hasHandler(s)) throw e;
          this.unwind(s, { r: this.alloc(s, { t: 'rec', v: { message: e.message, line: ins.line || this.userLine(s) } }) }, hooks);
        }
        if (++ops > maxOps) throw new LoomRuntimeError('Evaluation took too long', true);
      }
      return s.stack.pop() ?? null;
    } finally {
      this.handlerFloor = savedFloor;
    }
  }

  /** Pop frames until a handler is found, then jump to it with `value` on the stack. */
  private unwind(s: VMState, value: Value, hooks?: VMHooks): void {
    while (true) {
      const f = s.frames[s.frames.length - 1];
      const h = f.h.pop();
      if (h) {
        s.stack.length = h.sp;
        f.env = h.env;
        f.ip = h.ip;
        s.stack.push(value);
        return;
      }
      s.frames.pop();
      s.stack.length = f.base;
      hooks?.ret?.();
    }
  }

  /** The source line of the innermost frame that is user code (not stdlib). */
  userLine(s: VMState): number {
    for (let i = s.frames.length - 1; i >= 0; i--) {
      if (!this.program.protos[s.frames[i].f].internal) return this.frameLine(s, i);
    }
    return s.line;
  }

  /** Execute one instruction. Returns true when a statement boundary was crossed. */
  private exec(s: VMState, frame: Frame, ins: Instr, hooks?: VMHooks): boolean {
    const stack = s.stack;
    switch (ins.op) {
      case 'LINE':
        // Collect on a fixed cadence (aligned with timeline checkpoints, so snapshots
        // only contain live objects) or when the heap grows large. Both triggers
        // depend only on machine state, so replays stay bit-for-bit identical.
        if ((s.event & 63) === 0 || s.heap.size > s.gcAt) this.collectGarbage(s);
        s.event++;
        s.line = ins.a;
        return true;

      case 'CONST':
        stack.push(ins.a);
        break;
      case 'NIL':
        stack.push(null);
        break;
      case 'TRUE':
        stack.push(true);
        break;
      case 'FALSE':
        stack.push(false);
        break;
      case 'POP':
        stack.pop();
        break;
      case 'DUP':
        stack.push(stack[stack.length - 1]);
        break;
      case 'DUP2':
        stack.push(stack[stack.length - 2], stack[stack.length - 1]);
        break;

      case 'DEFINE': {
        const v = stack.pop()!;
        const env = s.heap.get(frame.env) as Extract<HeapObj, { t: 'env' }>;
        env.v[ins.a] = v;
        hooks?.bind?.(ins.a, frame.env, v, !!this.program.protos[frame.f].internal);
        break;
      }
      case 'GET':
        stack.push(this.lookup(s, frame.env, ins.a));
        break;
      case 'SET': {
        const v = stack.pop()!;
        const envId = this.findBinding(s, frame.env, ins.a);
        if (envId === null) fail(this.undefinedMessage(s, frame.env, ins.a, true));
        if (envId === s.preludeEnv) fail(`Cannot reassign builtin '${ins.a}'`);
        (s.heap.get(envId) as Extract<HeapObj, { t: 'env' }>).v[ins.a] = v;
        hooks?.bind?.(ins.a, envId, v, !!this.program.protos[frame.f].internal);
        break;
      }

      case 'GET_INDEX': {
        const idx = stack.pop()!;
        const obj = stack.pop()!;
        stack.push(this.getIndex(s, obj, idx));
        break;
      }
      case 'SET_INDEX': {
        const v = stack.pop()!;
        const idx = stack.pop()!;
        const obj = stack.pop()!;
        this.setIndex(s, obj, idx, v);
        hooks?.mutate?.((obj as Ref).r);
        break;
      }
      case 'GET_FIELD': {
        const obj = stack.pop()!;
        const o = this.get(s, obj);
        if (!o || o.t !== 'rec') fail(`Cannot read field '${ins.a}' of ${typeName(s.heap, obj)}`);
        if (!Object.hasOwn(o.v, ins.a)) {
          const keys = Object.keys(o.v);
          fail(`Record has no field '${ins.a}'${keys.length ? ` (fields: ${keys.join(', ')})` : ''}`);
        }
        stack.push(o.v[ins.a]);
        break;
      }
      case 'SET_FIELD': {
        const v = stack.pop()!;
        const obj = stack.pop()!;
        const o = this.get(s, obj);
        if (!o || o.t !== 'rec') fail(`Cannot set field '${ins.a}' on ${typeName(s.heap, obj)}`);
        if (ins.a === '__proto__') fail('Invalid field name');
        o.v[ins.a] = v;
        hooks?.mutate?.((obj as Ref).r);
        break;
      }

      case 'ARRAY': {
        const items = stack.splice(stack.length - ins.a, ins.a);
        stack.push(this.newArray(s, items));
        break;
      }
      case 'RECORD': {
        const keys: string[] = ins.a;
        const vals = stack.splice(stack.length - keys.length, keys.length);
        const rec: Record<string, Value> = {};
        keys.forEach((k, i) => {
          if (k === '__proto__') fail('Invalid field name');
          rec[k] = vals[i];
        });
        stack.push({ r: this.alloc(s, { t: 'rec', v: rec }) });
        break;
      }
      case 'CONCAT': {
        const parts = stack.splice(stack.length - ins.a, ins.a);
        stack.push(parts.map((x) => (typeof x === 'string' ? x : this.format(s, x))).join(''));
        break;
      }
      case 'RANGE': {
        const to = stack.pop()!;
        const from = stack.pop()!;
        stack.push(this.range(s, from, to, 1));
        break;
      }

      case 'BINARY': {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(this.binary(s, ins.a, a, b));
        break;
      }
      case 'NEG': {
        const a = stack.pop()!;
        if (typeof a !== 'number') fail(`Cannot negate ${typeName(s.heap, a)}`);
        stack.push(-a);
        break;
      }
      case 'NOT':
        stack.push(!truthy(stack.pop()!));
        break;

      case 'JUMP':
        frame.ip = ins.a;
        break;
      case 'JUMP_IF_FALSE':
        if (!truthy(stack.pop()!)) frame.ip = ins.a;
        break;
      case 'JUMP_IF_FALSE_KEEP':
        if (!truthy(stack[stack.length - 1])) frame.ip = ins.a;
        break;
      case 'JUMP_IF_TRUE_KEEP':
        if (truthy(stack[stack.length - 1])) frame.ip = ins.a;
        break;

      case 'CALL':
        this.call(s, ins.a, ins.line, hooks);
        break;

      case 'RETURN': {
        const v = stack.pop()!;
        if (s.frames.length === 1) {
          // keep the main frame so the final state still shows globals
          s.halted = true;
          s.line = ins.line;
          return false;
        }
        s.frames.pop();
        stack.length = frame.base;
        stack.push(v);
        hooks?.ret?.();
        break;
      }

      case 'TRY':
        frame.h.push({ ip: ins.a, sp: stack.length, env: frame.env });
        break;
      case 'END_TRY':
        frame.h.pop();
        break;
      case 'THROW': {
        const v = stack.pop()!;
        if (!this.hasHandler(s)) {
          const o = this.get(s, v);
          const msg = o?.t === 'rec' && typeof o.v.message === 'string' ? o.v.message : this.format(s, v);
          fail(`Uncaught error: ${msg}`);
        }
        this.unwind(s, v, hooks);
        break;
      }

      case 'CLOSURE':
        stack.push({ r: this.alloc(s, { t: 'fn', f: ins.a, e: frame.env }) });
        break;

      case 'PUSH_SCOPE':
        frame.env = this.alloc(s, { t: 'env', v: {}, p: frame.env });
        break;
      case 'POP_SCOPE':
        frame.env = (s.heap.get(frame.env) as Extract<HeapObj, { t: 'env' }>).p!;
        break;

      case 'ITERABLE': {
        const v = stack.pop()!;
        if (typeof v === 'string') {
          stack.push(this.newArray(s, [...v]));
          break;
        }
        const o = this.get(s, v);
        if (o?.t === 'arr') stack.push(v);
        else if (o?.t === 'rec') stack.push(this.newArray(s, Object.keys(o.v)));
        else fail(`Cannot loop over ${typeName(s.heap, v)}${typeof v === 'number' ? ` — did you mean 0..${v}?` : ''}`);
        break;
      }
      case 'LEN': {
        const o = this.get(s, stack.pop()!);
        stack.push(o?.t === 'arr' ? o.v.length : 0);
        break;
      }
    }
    return false;
  }

  private call(s: VMState, argc: number, line: number, hooks?: VMHooks): void {
    const stack = s.stack;
    const base = stack.length - argc - 1;
    const callee = stack[base];
    const o = this.get(s, callee);
    if (!o || (o.t !== 'fn' && o.t !== 'bi')) {
      fail(`Cannot call ${typeName(s.heap, callee)}${callee !== null && !isRef(callee) ? ` (${this.format(s, callee, true)})` : ''}`);
    }
    const args = stack.slice(base + 1);
    if (o.t === 'bi') {
      const result = this.builtins[o.n](this, s, args, hooks);
      stack.length = base;
      stack.push(result);
      return;
    }
    const proto = this.program.protos[o.f];
    if (argc > proto.params.length) {
      fail(`${proto.name}() takes ${proto.params.length} argument${proto.params.length === 1 ? '' : 's'} but got ${argc}`);
    }
    if (s.frames.length >= MAX_DEPTH) {
      fail(`Stack overflow: recursion deeper than ${MAX_DEPTH} calls (in ${proto.name})`);
    }
    const vars: Record<string, Value> = {};
    const env = this.alloc(s, { t: 'env', v: vars, p: o.e, c: true });
    proto.params.forEach((p, i) => {
      vars[p] = i < args.length ? args[i] : null;
      hooks?.bind?.(p, env, vars[p], !!proto.internal);
    });
    stack.length = base;
    s.frames.push({ f: o.f, ip: 0, env, base, callLine: line, h: [] });
    hooks?.call?.(o.f, args);
  }

  // ------------------------------------------------------- environments

  findBinding(s: VMState, envId: number, name: string): number | null {
    let id: number | null = envId;
    while (id !== null) {
      const env = s.heap.get(id) as Extract<HeapObj, { t: 'env' }>;
      if (Object.hasOwn(env.v, name)) return id;
      id = env.p;
    }
    return null;
  }

  private lookup(s: VMState, envId: number, name: string): Value {
    const found = this.findBinding(s, envId, name);
    if (found === null) fail(this.undefinedMessage(s, envId, name, false));
    return (s.heap.get(found) as Extract<HeapObj, { t: 'env' }>).v[name];
  }

  private undefinedMessage(s: VMState, envId: number, name: string, assigning: boolean): string {
    const candidates: string[] = [];
    let id: number | null = envId;
    while (id !== null) {
      const env = s.heap.get(id) as Extract<HeapObj, { t: 'env' }>;
      candidates.push(...Object.keys(env.v).filter((k) => !k.startsWith('$')));
      id = env.p;
    }
    let best: string | null = null;
    let bestDist = Math.max(2, Math.floor(name.length / 3)) + 1;
    for (const c of candidates) {
      const d = levenshtein(name, c);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    const base = assigning
      ? `Cannot assign to undeclared variable '${name}' — declare it first with \`let ${name} = …\``
      : `Undefined variable '${name}'`;
    return best ? `${base}. Did you mean '${best}'?` : base;
  }

  // ---------------------------------------------------------- operators

  binary(s: VMState, op: string, a: Value, b: Value): Value {
    if (op === '==') return valuesEqual(a, b);
    if (op === '!=') return !valuesEqual(a, b);

    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) fail('Division by zero');
          return a / b;
        case '%':
          if (b === 0) fail('Modulo by zero');
          return ((a % b) + b) % b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
      }
    }
    if (op === '+') {
      if (typeof a === 'string' || typeof b === 'string') {
        return this.format(s, a) + this.format(s, b);
      }
      const oa = this.get(s, a);
      const ob = this.get(s, b);
      if (oa?.t === 'arr' && ob?.t === 'arr') return this.newArray(s, [...oa.v, ...ob.v]);
    }
    if (op === '*' && typeof a === 'string' && typeof b === 'number') {
      if (b < 0 || b * a.length > MAX_COLLECTION) fail('Invalid string repeat count');
      return a.repeat(Math.floor(b));
    }
    if (typeof a === 'string' && typeof b === 'string') {
      switch (op) {
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
      }
    }
    fail(`Cannot apply '${op}' to ${typeName(s.heap, a)} and ${typeName(s.heap, b)}`);
  }

  private normIndex(idx: Value, length: number, what: string): number {
    if (typeof idx !== 'number' || !Number.isInteger(idx)) {
      fail(`${what} index must be an integer, got ${typeof idx === 'number' ? formatNumber(idx) : typeof idx === 'string' ? JSON.stringify(idx) : String(idx)}`);
    }
    const i = idx < 0 ? length + idx : idx;
    if (i < 0 || i >= length) fail(`Index ${idx} out of bounds for ${what.toLowerCase()} of length ${length}`);
    return i;
  }

  getIndex(s: VMState, obj: Value, idx: Value): Value {
    if (typeof obj === 'string') return obj[this.normIndex(idx, obj.length, 'String')];
    const o = this.get(s, obj);
    if (o?.t === 'arr') return o.v[this.normIndex(idx, o.v.length, 'Array')];
    if (o?.t === 'rec') {
      if (typeof idx !== 'string') fail('Record keys must be strings');
      return Object.hasOwn(o.v, idx) ? o.v[idx] : null;
    }
    fail(`Cannot index into ${typeName(s.heap, obj)}`);
  }

  private setIndex(s: VMState, obj: Value, idx: Value, v: Value): void {
    const o = this.get(s, obj);
    if (o?.t === 'arr') {
      o.v[this.normIndex(idx, o.v.length, 'Array')] = v;
      return;
    }
    if (o?.t === 'rec') {
      if (typeof idx !== 'string') fail('Record keys must be strings');
      if (idx === '__proto__') fail('Invalid field name');
      o.v[idx] = v;
      return;
    }
    if (typeof obj === 'string') fail('Strings are immutable');
    fail(`Cannot index into ${typeName(s.heap, obj)}`);
  }

  range(s: VMState, from: Value, to: Value, step: Value): Ref {
    if (typeof from !== 'number' || typeof to !== 'number' || typeof step !== 'number') {
      fail('Range bounds must be numbers');
    }
    if (step === 0) fail('Range step cannot be 0');
    const count = Math.max(0, Math.ceil((to - from) / step));
    if (count > MAX_COLLECTION) fail(`Range too large (${count} elements)`);
    const items: Value[] = [];
    for (let i = 0; i < count; i++) items.push(from + i * step);
    return this.newArray(s, items);
  }

  // ----------------------------------------------------------------- GC

  /**
   * Mark & sweep. Only runs at statement boundaries (where every live value
   * is reachable from frames and the stack) and is triggered by heap size,
   * which is itself part of the snapshot — so GC is perfectly deterministic
   * across replays.
   */
  collectGarbage(s: VMState): void {
    const marked = new Set<number>();
    const work: number[] = [s.preludeEnv, s.globalEnv];
    const markValue = (v: Value) => {
      if (isRef(v) && !marked.has(v.r)) work.push(v.r);
    };
    for (const f of s.frames) {
      work.push(f.env);
      for (const h of f.h) work.push(h.env);
    }
    for (const v of s.stack) markValue(v);
    while (work.length) {
      const id = work.pop()!;
      if (marked.has(id)) continue;
      marked.add(id);
      const o = s.heap.get(id);
      if (!o) continue;
      switch (o.t) {
        case 'arr':
          o.v.forEach(markValue);
          break;
        case 'rec':
          Object.values(o.v).forEach(markValue);
          break;
        case 'env':
          Object.values(o.v).forEach(markValue);
          if (o.p !== null) work.push(o.p);
          break;
        case 'fn':
          work.push(o.e);
          break;
      }
    }
    for (const id of [...s.heap.keys()]) {
      if (!marked.has(id)) s.heap.delete(id);
    }
    s.gcAt = Math.max(4000, s.heap.size * 2);
  }

  // ------------------------------------------------- debugger utilities

  /** Evaluate a literal-ish expression (used to inject values into a fork). */
  materialize(s: VMState, e: Expr): Value {
    switch (e.kind) {
      case 'Num':
      case 'Str':
      case 'Bool':
        return e.value;
      case 'Nil':
        return null;
      case 'Unary': {
        const v = this.materialize(s, e.operand);
        if (e.op === '-' && typeof v === 'number') return -v;
        if (e.op === 'not') return !truthy(v);
        break;
      }
      case 'Array':
        return this.newArray(
          s,
          e.items.map((x) => this.materialize(s, x)),
        );
      case 'Record': {
        const rec: Record<string, Value> = {};
        for (const en of e.entries) rec[en.key] = this.materialize(s, en.value);
        return { r: this.alloc(s, { t: 'rec', v: rec }) };
      }
      case 'Range':
        return this.range(s, this.materialize(s, e.from), this.materialize(s, e.to), 1);
      case 'Ident': {
        const frame = s.frames[s.frames.length - 1];
        return this.lookup(s, frame.env, e.name);
      }
      case 'Binary': {
        const a = this.materialize(s, e.left);
        const b = this.materialize(s, e.right);
        return this.binary(s, e.op, a, b);
      }
    }
    fail('Only literal values (numbers, strings, arrays, records…) can be injected into a timeline');
  }

  /** Assign to an existing variable visible from the given frame. Returns the env id. */
  assignVariable(s: VMState, frameIndex: number, name: string, value: Value): number {
    const frame = s.frames[frameIndex];
    const envId = this.findBinding(s, frame.env, name);
    if (envId === null || envId === s.preludeEnv) fail(`No variable '${name}' in this scope`);
    (s.heap.get(envId) as Extract<HeapObj, { t: 'env' }>).v[name] = value;
    return envId;
  }

  /** Scope chain for a frame, innermost first, excluding the builtin prelude. */
  scopes(s: VMState, frameIndex: number): ScopeView[] {
    const frame = s.frames[frameIndex];
    if (!frame) return [];
    const out: ScopeView[] = [];
    let id: number | null = frame.env;
    let passedCall = false;
    while (id !== null && id !== s.preludeEnv) {
      const env = s.heap.get(id) as Extract<HeapObj, { t: 'env' }>;
      let kind: ScopeView['kind'];
      if (id === s.globalEnv) kind = 'globals';
      else if (passedCall) kind = 'closure';
      else kind = env.c ? 'locals' : 'block';
      if (env.c) passedCall = true;
      out.push({ envId: id, kind, vars: Object.entries(env.v).filter(([k]) => !k.startsWith('$')) });
      id = env.p;
    }
    return out;
  }

  /** Line currently executing in a given frame. */
  frameLine(s: VMState, frameIndex: number): number {
    if (frameIndex === s.frames.length - 1) return s.line;
    return s.frames[frameIndex + 1].callLine;
  }
}

// ======================================================================
// Builtins
// ======================================================================

function num(s: VMState, v: Value, fn: string): number {
  if (typeof v !== 'number') fail(`${fn}() expects a number, got ${typeName(s.heap, v)}`);
  return v;
}

function arr(vm: VM, s: VMState, v: Value, fn: string): Value[] {
  const o = vm.get(s, v);
  if (o?.t !== 'arr') fail(`${fn}() expects an array, got ${typeName(s.heap, v)}`);
  return o.v;
}

function str(s: VMState, v: Value, fn: string): string {
  if (typeof v !== 'string') fail(`${fn}() expects a string, got ${typeName(s.heap, v)}`);
  return v;
}

function arity(args: Value[], min: number, max: number, fn: string): void {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : `${min}–${max}`;
    fail(`${fn}() takes ${want} argument${max === 1 ? '' : 's'} but got ${args.length}`);
  }
}

function nextRandom(s: VMState): number {
  // mulberry32
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function compareValues(s: VMState, a: Value, b: Value): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  fail(`sort() can only compare numbers with numbers or strings with strings (got ${typeName(s.heap, a)} and ${typeName(s.heap, b)})`);
}

function math1(name: string, f: (x: number) => number): Builtin {
  return (_vm, s, args) => {
    arity(args, 1, 1, name);
    return f(num(s, args[0], name));
  };
}

function createBuiltins(): Record<string, Builtin> {
  return {
    print: (vm, s, args, hooks) => {
      hooks?.print?.(args.map((a) => vm.format(s, a)).join(' '));
      return null;
    },
    len: (vm, s, args) => {
      arity(args, 1, 1, 'len');
      const v = args[0];
      if (typeof v === 'string') return v.length;
      const o = vm.get(s, v);
      if (o?.t === 'arr') return o.v.length;
      if (o?.t === 'rec') return Object.keys(o.v).length;
      fail(`len() expects a string, array or record, got ${typeName(s.heap, v)}`);
    },
    push: (vm, s, args, hooks) => {
      arity(args, 2, 2, 'push');
      const a = arr(vm, s, args[0], 'push');
      if (a.length >= MAX_COLLECTION) fail('Array too large');
      a.push(args[1]);
      hooks?.mutate?.((args[0] as Ref).r);
      return args[0];
    },
    pop: (vm, s, args, hooks) => {
      arity(args, 1, 1, 'pop');
      const a = arr(vm, s, args[0], 'pop');
      if (a.length === 0) fail('pop() from an empty array');
      hooks?.mutate?.((args[0] as Ref).r);
      return a.pop()!;
    },
    insert: (vm, s, args, hooks) => {
      arity(args, 3, 3, 'insert');
      const a = arr(vm, s, args[0], 'insert');
      const i = num(s, args[1], 'insert');
      if (!Number.isInteger(i) || i < 0 || i > a.length) fail(`insert() index ${i} out of bounds`);
      a.splice(i, 0, args[2]);
      hooks?.mutate?.((args[0] as Ref).r);
      return args[0];
    },
    remove: (vm, s, args, hooks) => {
      arity(args, 2, 2, 'remove');
      const a = arr(vm, s, args[0], 'remove');
      const i = num(s, args[1], 'remove');
      if (!Number.isInteger(i) || i < 0 || i >= a.length) fail(`remove() index ${i} out of bounds`);
      hooks?.mutate?.((args[0] as Ref).r);
      return a.splice(i, 1)[0];
    },
    str: (vm, s, args) => {
      arity(args, 1, 1, 'str');
      return vm.format(s, args[0]);
    },
    num: (_vm, s, args) => {
      arity(args, 1, 1, 'num');
      const v = args[0];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      fail(`num() cannot convert ${typeName(s.heap, v)} ${typeof v === 'string' ? JSON.stringify(v) : ''}`.trim());
    },
    int: math1('int', Math.trunc),
    floor: math1('floor', Math.floor),
    ceil: math1('ceil', Math.ceil),
    round: math1('round', Math.round),
    abs: math1('abs', Math.abs),
    sqrt: math1('sqrt', (x) => {
      if (x < 0) fail('sqrt() of a negative number');
      return Math.sqrt(x);
    }),
    sin: math1('sin', Math.sin),
    cos: math1('cos', Math.cos),
    log: math1('log', (x) => {
      if (x <= 0) fail('log() of a non-positive number');
      return Math.log(x);
    }),
    pow: (_vm, s, args) => {
      arity(args, 2, 2, 'pow');
      return Math.pow(num(s, args[0], 'pow'), num(s, args[1], 'pow'));
    },
    atan2: (_vm, s, args) => {
      arity(args, 2, 2, 'atan2');
      return Math.atan2(num(s, args[0], 'atan2'), num(s, args[1], 'atan2'));
    },
    min: (vm, s, args) => {
      const xs = args.length === 1 && isRef(args[0]) ? arr(vm, s, args[0], 'min') : args;
      if (xs.length === 0) fail('min() of nothing');
      return xs.reduce((a, b) => (compareValues(s, a, b) <= 0 ? a : b));
    },
    max: (vm, s, args) => {
      const xs = args.length === 1 && isRef(args[0]) ? arr(vm, s, args[0], 'max') : args;
      if (xs.length === 0) fail('max() of nothing');
      return xs.reduce((a, b) => (compareValues(s, a, b) >= 0 ? a : b));
    },
    sum: (vm, s, args) => {
      arity(args, 1, 1, 'sum');
      return arr(vm, s, args[0], 'sum').reduce<number>((acc, v) => acc + num(s, v, 'sum'), 0);
    },
    random: (_vm, s, args) => {
      arity(args, 0, 0, 'random');
      return nextRandom(s);
    },
    randint: (_vm, s, args) => {
      arity(args, 2, 2, 'randint');
      const lo = Math.ceil(num(s, args[0], 'randint'));
      const hi = Math.floor(num(s, args[1], 'randint'));
      if (hi < lo) fail('randint() needs lo <= hi');
      return lo + Math.floor(nextRandom(s) * (hi - lo + 1));
    },
    seed: (_vm, s, args) => {
      arity(args, 1, 1, 'seed');
      s.rng = num(s, args[0], 'seed') | 0;
      return null;
    },
    range: (vm, s, args) => {
      arity(args, 1, 3, 'range');
      if (args.length === 1) return vm.range(s, 0, args[0], 1);
      return vm.range(s, args[0], args[1], args.length === 3 ? args[2] : 1);
    },
    keys: (vm, s, args) => {
      arity(args, 1, 1, 'keys');
      const o = vm.get(s, args[0]);
      if (o?.t !== 'rec') fail(`keys() expects a record, got ${typeName(s.heap, args[0])}`);
      return vm.newArray(s, Object.keys(o.v));
    },
    values: (vm, s, args) => {
      arity(args, 1, 1, 'values');
      const o = vm.get(s, args[0]);
      if (o?.t !== 'rec') fail(`values() expects a record, got ${typeName(s.heap, args[0])}`);
      return vm.newArray(s, Object.values(o.v));
    },
    has: (vm, s, args) => {
      arity(args, 2, 2, 'has');
      const [c, x] = args;
      if (typeof c === 'string') return typeof x === 'string' && c.includes(x);
      const o = vm.get(s, c);
      if (o?.t === 'rec') return typeof x === 'string' && Object.hasOwn(o.v, x);
      if (o?.t === 'arr') return o.v.some((v) => valuesEqual(v, x));
      fail(`has() expects a string, array or record, got ${typeName(s.heap, c)}`);
    },
    type: (_vm, s, args) => {
      arity(args, 1, 1, 'type');
      return typeName(s.heap, args[0]);
    },
    join: (vm, s, args) => {
      arity(args, 1, 2, 'join');
      const sep = args.length > 1 ? str(s, args[1], 'join') : '';
      return arr(vm, s, args[0], 'join')
        .map((v) => vm.format(s, v))
        .join(sep);
    },
    split: (vm, s, args) => {
      arity(args, 1, 2, 'split');
      const sep = args.length > 1 ? str(s, args[1], 'split') : '';
      return vm.newArray(s, str(s, args[0], 'split').split(sep));
    },
    upper: (_vm, s, args) => str(s, args[0], 'upper').toUpperCase(),
    lower: (_vm, s, args) => str(s, args[0], 'lower').toLowerCase(),
    trim: (_vm, s, args) => str(s, args[0], 'trim').trim(),
    char: (_vm, s, args) => String.fromCharCode(num(s, args[0], 'char')),
    code: (_vm, s, args) => {
      const x = str(s, args[0], 'code');
      if (x.length === 0) fail('code() of an empty string');
      return x.charCodeAt(0);
    },
    slice: (vm, s, args) => {
      arity(args, 2, 3, 'slice');
      const from = num(s, args[1], 'slice');
      const to = args.length > 2 ? num(s, args[2], 'slice') : undefined;
      if (typeof args[0] === 'string') return args[0].slice(from, to);
      return vm.newArray(s, arr(vm, s, args[0], 'slice').slice(from, to));
    },
    sort: (vm, s, args) => {
      arity(args, 1, 1, 'sort');
      return vm.newArray(
        s,
        [...arr(vm, s, args[0], 'sort')].sort((a, b) => compareValues(s, a, b)),
      );
    },
    reverse: (vm, s, args) => {
      arity(args, 1, 1, 'reverse');
      if (typeof args[0] === 'string') return [...args[0]].reverse().join('');
      return vm.newArray(s, [...arr(vm, s, args[0], 'reverse')].reverse());
    },
    copy: (vm, s, args) => {
      arity(args, 1, 1, 'copy');
      const o = vm.get(s, args[0]);
      if (o?.t === 'arr') return vm.newArray(s, [...o.v]);
      if (o?.t === 'rec') return { r: vm.alloc(s, { t: 'rec', v: { ...o.v } }) };
      return args[0];
    },
    fill: (vm, s, args) => {
      arity(args, 2, 2, 'fill');
      const n = num(s, args[0], 'fill');
      if (n < 0 || n > MAX_COLLECTION) fail('fill() size out of range');
      return vm.newArray(s, new Array(Math.floor(n)).fill(args[1]));
    },
    grid: (vm, s, args) => {
      arity(args, 3, 3, 'grid');
      const rows = num(s, args[0], 'grid');
      const cols = num(s, args[1], 'grid');
      if (rows < 0 || cols < 0 || rows * cols > MAX_COLLECTION) fail('grid() size out of range');
      const out: Value[] = [];
      for (let r = 0; r < rows; r++) out.push(vm.newArray(s, new Array(Math.floor(cols)).fill(args[2])));
      return vm.newArray(s, out);
    },
    assert: (vm, s, args) => {
      arity(args, 1, 2, 'assert');
      if (!truthy(args[0])) fail(`Assertion failed${args.length > 1 ? ': ' + vm.format(s, args[1]) : ''}`);
      return null;
    },
    error: (vm, s, args) => {
      fail(args.length ? vm.format(s, args[0]) : 'error() called');
    },
  };
}

/** Names of every native builtin (plus the PI constant). */
export const BUILTIN_NAMES: readonly string[] = [...Object.keys(createBuiltins()), 'PI'];

/**
 * Snapshot a machine state. Equivalent to a deep copy, but much faster than
 * `structuredClone`: references (`{r}`), functions and builtins are never
 * mutated after creation, so they are shared; only arrays, records,
 * environments, frames and the stack are copied.
 */
export function cloneState(s: VMState): VMState {
  const heap: Heap = new Map();
  for (const [id, o] of s.heap) {
    switch (o.t) {
      case 'arr':
        heap.set(id, { t: 'arr', v: o.v.slice() });
        break;
      case 'rec':
        heap.set(id, { t: 'rec', v: { ...o.v } });
        break;
      case 'env':
        heap.set(id, o.c ? { t: 'env', v: { ...o.v }, p: o.p, c: true } : { t: 'env', v: { ...o.v }, p: o.p });
        break;
      default:
        heap.set(id, o);
    }
  }
  return {
    ...s,
    frames: s.frames.map((f) => ({ ...f, h: f.h.map((h) => ({ ...h })) })),
    stack: s.stack.slice(),
    heap,
    error: s.error ? { ...s.error } : null,
  };
}
