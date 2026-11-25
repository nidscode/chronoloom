/**
 * Runtime value model.
 *
 * Everything the VM touches is plain data (no JS closures, no class
 * instances) so an entire machine state can be snapshotted with
 * `structuredClone`. Mutable objects live in a heap addressed by integer ids;
 * values refer to them through `{ r: id }` references.
 */

export interface Ref {
  r: number;
}

export type Value = number | string | boolean | null | Ref;

export type HeapObj =
  | { t: 'arr'; v: Value[] }
  | { t: 'rec'; v: Record<string, Value> }
  | { t: 'env'; v: Record<string, Value>; p: number | null; /** true for a function-call environment */ c?: boolean }
  | { t: 'fn'; f: number; e: number }
  | { t: 'bi'; n: string };

export function isRef(v: Value): v is Ref {
  return v !== null && typeof v === 'object';
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false;
}

export type Heap = Map<number, HeapObj>;

export function typeName(heap: Heap, v: Value): string {
  if (v === null) return 'nil';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  const o = heap.get(v.r);
  if (!o) return 'ref';
  switch (o.t) {
    case 'arr':
      return 'array';
    case 'rec':
      return 'record';
    case 'fn':
    case 'bi':
      return 'function';
    case 'env':
      return 'env';
  }
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan';
  // trim floating noise like 0.30000000000000004
  return String(Number(n.toPrecision(12)));
}

export interface FormatOptions {
  /** quote strings (true inside containers / debugger views) */
  quote?: boolean;
  maxDepth?: number;
  maxItems?: number;
  fnName?: (protoIndex: number) => string;
}

export function formatValue(heap: Heap, v: Value, opts: FormatOptions = {}, depth = 0): string {
  const { quote = false, maxDepth = 4, maxItems = 100 } = opts;
  if (v === null) return 'nil';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return quote ? JSON.stringify(v) : v;
  const o = heap.get(v.r);
  if (!o) return '<freed>';
  const inner = { ...opts, quote: true };
  switch (o.t) {
    case 'arr': {
      if (depth >= maxDepth) return '[…]';
      const items = o.v.slice(0, maxItems).map((x) => formatValue(heap, x, inner, depth + 1));
      if (o.v.length > maxItems) items.push(`… ${o.v.length - maxItems} more`);
      return `[${items.join(', ')}]`;
    }
    case 'rec': {
      if (depth >= maxDepth) return '{…}';
      const keys = Object.keys(o.v);
      const items = keys
        .slice(0, maxItems)
        .map((k) => `${/^[A-Za-z_]\w*$/.test(k) ? k : JSON.stringify(k)}: ${formatValue(heap, o.v[k], inner, depth + 1)}`);
      if (keys.length > maxItems) items.push(`…`);
      return `{${items.join(', ')}}`;
    }
    case 'fn':
      return `<fn ${opts.fnName ? opts.fnName(o.f) : '#' + o.f}>`;
    case 'bi':
      return `<builtin ${o.n}>`;
    case 'env':
      return '<env>';
  }
}

/** Structural equality used by `==`. Containers compare by identity. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (isRef(a) && isRef(b)) return a.r === b.r;
  return a === b;
}
