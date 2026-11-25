/**
 * Read-only expression evaluation against a frozen machine state.
 *
 * Used for watch expressions, history queries, breakpoint conditions and
 * editor hover. It never allocates on the heap or calls Loom functions, so it
 * cannot disturb the state it inspects (which may be the debugger's live
 * cursor). For full-power evaluation, see `Multiverse.evaluate` (the console),
 * which runs on a throwaway copy instead.
 */

import type { Expr } from './ast';
import { parseExpression } from './parser';
import { isRef, truthy, type HeapObj, type Value } from './values';
import { LoomRuntimeError, type VM, type VMState } from './vm';

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/** Builtins that neither allocate nor have side effects. */
const PURE_BUILTINS = new Set([
  'len', 'abs', 'floor', 'ceil', 'round', 'int', 'sqrt', 'sin', 'cos', 'log', 'pow', 'atan2',
  'min', 'max', 'sum', 'has', 'type', 'str', 'num', 'upper', 'lower', 'trim', 'char', 'code',
]);

const cache = new Map<string, Expr>();

/** Parse (and cache) a watch expression. Throws LoomSyntaxError. */
export function parseWatch(source: string): Expr {
  let e = cache.get(source);
  if (!e) {
    e = parseExpression(source);
    if (cache.size > 500) cache.clear();
    cache.set(source, e);
  }
  return e;
}

function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof LoomRuntimeError) throw new EvalError(e.message);
    throw e;
  }
}

export function evaluateReadOnly(vm: VM, s: VMState, frameIndex: number, e: Expr): Value {
  const frame = s.frames[frameIndex];
  if (!frame) throw new EvalError('No frame to evaluate in');
  const ev = (x: Expr): Value => evaluateReadOnly(vm, s, frameIndex, x);

  switch (e.kind) {
    case 'Num':
    case 'Str':
    case 'Bool':
      return e.value;
    case 'Nil':
      return null;
    case 'Template':
      return e.parts.map((p) => (typeof p === 'string' ? p : vm.format(s, ev(p)))).join('');
    case 'Ident': {
      const env = vm.findBinding(s, frame.env, e.name);
      if (env === null) throw new EvalError(`'${e.name}' is not defined here`);
      return (s.heap.get(env) as Extract<HeapObj, { t: 'env' }>).v[e.name];
    }
    case 'Unary': {
      const v = ev(e.operand);
      if (e.op === 'not') return !truthy(v);
      if (typeof v !== 'number') throw new EvalError('Cannot negate a non-number');
      return -v;
    }
    case 'Binary': {
      const a = ev(e.left);
      const b = ev(e.right);
      if (e.op === '+' && isRef(a) && isRef(b)) throw new EvalError('Joining arrays is not allowed here');
      return wrap(() => vm.binary(s, e.op, a, b));
    }
    case 'Logical': {
      const a = ev(e.left);
      if (e.op === 'and') return truthy(a) ? ev(e.right) : a;
      return truthy(a) ? a : ev(e.right);
    }
    case 'Index': {
      const o = ev(e.object);
      const i = ev(e.index);
      return wrap(() => vm.getIndex(s, o, i));
    }
    case 'Member': {
      const o = ev(e.object);
      const obj = isRef(o) ? s.heap.get(o.r) : undefined;
      if (obj?.t !== 'rec') throw new EvalError(`Cannot read field '${e.name}' of a non-record`);
      if (!Object.hasOwn(obj.v, e.name)) throw new EvalError(`No field '${e.name}'`);
      return obj.v[e.name];
    }
    case 'Call': {
      if (e.callee.kind !== 'Ident' || !PURE_BUILTINS.has(e.callee.name)) {
        throw new EvalError('Only simple builtins (len, abs, min, max, …) can be called here. Use the console to call functions.');
      }
      const callee = ev(e.callee);
      const fn = isRef(callee) ? s.heap.get(callee.r) : undefined;
      if (fn?.t !== 'bi') throw new EvalError(`'${e.callee.name}' is not the builtin here`);
      const args = e.args.map(ev);
      return wrap(() => vm.builtins[fn.n](vm, s, args, undefined));
    }
    default:
      throw new EvalError('Arrays, records, ranges and functions cannot be created here. Use the console instead.');
  }
}

/** Evaluate a source expression; returns the value or an error message. */
export function tryEvaluate(vm: VM, s: VMState, frameIndex: number, source: string): { value: Value } | { error: string } {
  try {
    return { value: evaluateReadOnly(vm, s, frameIndex, parseWatch(source)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
