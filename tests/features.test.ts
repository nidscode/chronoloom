import { describe, expect, it } from 'vitest';
import { analyze, compile, Multiverse, run, tryEvaluate, VM, type VMState } from '../src/core';

const out = (src: string) => {
  const r = run(src);
  if (r.end.kind === 'error') throw new Error(`runtime error: ${r.end.error.message} (line ${r.end.error.line})`);
  return r.output;
};

const fingerprint = (s: VMState) =>
  JSON.stringify({ frames: s.frames, stack: s.stack, heap: [...s.heap.entries()], event: s.event, rng: s.rng });

describe('string interpolation', () => {
  it('embeds expressions in double-quoted strings', () => {
    expect(out('let n = 3\nlet xs = [1, 2]\nprint("n={n}, next={n + 1}, xs={xs}, s={"a" + "b"}")')).toEqual([
      'n=3, next=4, xs=[1, 2], s=ab',
    ]);
  });

  it('supports escaped braces and leaves single quotes alone', () => {
    expect(out('let x = 1\nprint("\\{x} {x}")\nprint(\'{x}\')')).toEqual(['{x} 1', '{x}']);
  });

  it('reports errors inside interpolations at the right column', () => {
    const d = analyze('let a = 1\nprint("v = {a +}")');
    expect(d[0].severity).toBe('error');
    expect(d[0].line).toBe(2);
    expect(d[0].col).toBeGreaterThan(10);
  });
});

describe('arrow functions and the standard library', () => {
  it('supports => bodies for expressions and declarations', () => {
    expect(out('fn sq(x) => x * x\nlet inc = fn(x) => x + 1\nprint(sq(inc(2)))')).toEqual(['9']);
  });

  it('provides map / filter / reduce and friends, written in Loom', () => {
    const src = `
      let xs = [5, 3, 8, 1]
      print(map(xs, fn(x) => x * 2))
      print(filter(xs, fn(x) => x > 2))
      print(reduce(xs, fn(a, b) => a + b, 0))
      print(find(xs, fn(x) => x > 4), findIndex(xs, fn(x) => x == 8), indexOf(xs, 1))
      print(any(xs, fn(x) => x > 7), all(xs, fn(x) => x > 0), count(xs, fn(x) => x % 2 == 1))
      print(sortBy(["pear", "fig", "banana"], fn(s) => len(s)))
      print(zip([1, 2], ["a", "b"]), enumerate(["x"]), flatten([[1], 2, [3, 4]]), unique([1, 1, 2]))
      print(times(3, fn(i) => i * i))`;
    expect(out(src)).toEqual([
      '[10, 6, 16, 2]',
      '[5, 3, 8]',
      '17',
      '5 2 3',
      'true true 3',
      '["fig", "pear", "banana"]',
      '[[1, "a"], [2, "b"]] [[0, "x"]] [1, 2, 3, 4] [1, 2]',
      '[0, 1, 4]',
    ]);
  });

  it('keeps standard-library code off the timeline but records callbacks', () => {
    const mv = new Multiverse('let ys = map([1, 2, 3], fn(x) => x * 10)\nprint(ys)');
    const lines = mv.root.lines;
    // line 1 once for the statement, plus once per callback invocation
    expect(lines.filter((l) => l === 1).length).toBe(4);
    expect(lines.every((l) => l > 0)).toBe(true);
    // the stdlib's internal variables never show up in the write trace
    expect(mv.root.writes.some((w) => w.kind !== 'mut' && w.name === 'out')).toBe(false);
  });

  it('attributes errors inside the standard library to the calling line', () => {
    const r = run('let a = 1\nlet b = map(5, fn(x) => x)');
    expect(r.end.kind).toBe('error');
    if (r.end.kind === 'error') expect(r.end.error.line).toBe(2);
  });
});

describe('exceptions', () => {
  it('catches thrown values', () => {
    expect(out('try {\n  throw "boom"\n} catch e {\n  print("caught", e)\n}\nprint("after")')).toEqual(['caught boom', 'after']);
  });

  it('turns runtime errors into catchable records', () => {
    const src = 'try {\n  let x = [1][5]\n} catch e {\n  print(e.line, e.message)\n}';
    expect(out(src)).toEqual(['2 Index 5 out of bounds for array of length 1']);
  });

  it('unwinds through function calls and restores the stack', () => {
    const src = `
      fn deep(n) {
        if n == 0 { throw {code: 42} }
        return 1 + deep(n - 1)
      }
      let r = 0
      try {
        r = deep(5)
      } catch err {
        r = err.code
      }
      print(r, 10 + 1)`;
    expect(out(src)).toEqual(['42 11']);
  });

  it('supports nested try, rethrow, and catch without a name', () => {
    const src = `
      let log = []
      try {
        try {
          throw "inner"
        } catch e {
          push(log, e)
          throw "outer"
        }
      } catch e2 {
        push(log, e2)
      }
      try { error("x") } catch { push(log, "silent") }
      print(log)`;
    expect(out(src)).toEqual(['["inner", "outer", "silent"]']);
  });

  it('cleans up handlers when break leaves a try block', () => {
    const src = `
      let n = 0
      while true {
        try {
          n += 1
          if n == 3 { break }
        } catch e { print("never") }
      }
      throw "uncaught after loop"`;
    const r = run(src);
    expect(r.end.kind).toBe('error');
    if (r.end.kind === 'error') expect(r.end.error.message).toBe('Uncaught error: uncaught after loop');
  });

  it('keeps the call stack for post-mortem debugging of uncaught errors', () => {
    const mv = new Multiverse('fn f() {\n  throw "bad"\n}\nf()');
    expect(mv.root.end.kind).toBe('error');
    expect(mv.root.endState.frames.length).toBe(2);
  });

  it('replays exception-heavy programs deterministically', () => {
    const src = `
      fn risky(i) {
        if i % 3 == 0 { throw i }
        return i
      }
      let caught = []
      for i in 0..40 {
        try { risky(i) } catch e { push(caught, e) }
      }
      print(len(caught))`;
    const mv = new Multiverse(src, { checkpointEvery: 8 });
    const vm = new VM(compile(src));
    const s = vm.initialState(mv.seed);
    const truth: string[] = [];
    while (vm.stepEvent(s)) truth.push(fingerprint(s));
    for (let p = 0; p < truth.length; p += 5) expect(fingerprint(mv.stateAt(mv.root, p))).toBe(truth[p]);
    expect(mv.root.outputs[0].text).toBe('14');
  });
});

describe('call tree and profiler', () => {
  const FIB = 'fn fib(n) {\n  if n < 2 { return n }\n  return fib(n - 1) + fib(n - 2)\n}\nprint(fib(5))';

  it('records every call with its span and depth', () => {
    const tl = new Multiverse(FIB).root;
    expect(tl.calls.length).toBe(15); // fib(5) makes 15 calls
    const top = tl.calls[0];
    expect(top.depth).toBe(2);
    expect(top.args).toBe('5');
    expect(top.e).toBeGreaterThan(top.s);
    for (const c of tl.calls) {
      expect(c.e).toBeGreaterThanOrEqual(c.s);
      for (let p = c.s; p < c.e; p++) expect(tl.depths[p]).toBeGreaterThanOrEqual(c.depth);
    }
  });

  it('profiles functions without double counting recursion', () => {
    const mv = new Multiverse(FIB);
    const rows = mv.root.profile(mv.vm);
    const fib = rows.find((r) => r.name === 'fib')!;
    expect(fib.calls).toBe(15);
    expect(fib.total).toBe(mv.root.calls[0].e - mv.root.calls[0].s);
    expect(fib.self).toBe(mv.root.fns.filter((f) => f === fib.fn).length);
  });

  it('re-opens calls that were active at a fork point', () => {
    const src = 'fn f(n) {\n  let a = n\n  let b = a * 2\n  return b\n}\nprint(f(1))';
    const mv = new Multiverse(src);
    const pos = mv.root.lines.indexOf(3); // inside f
    const alt = mv.fork(mv.root, pos, 1, 'a', '100');
    expect(alt.outputs.map((o) => o.text)).toEqual(['200']);
    expect(alt.calls).toHaveLength(1);
    expect(alt.calls[0].e).toBeGreaterThan(pos);
    expect(mv.root.calls[0]).not.toBe(alt.calls[0]);
  });
});

describe('omniscient queries, breakpoints and the console', () => {
  const SRC = `
let total = 0
for i in 0..10 {
  total += i
}
fn double(x) {
  return x * 2
}
print(total)`;

  it('finds every moment an expression is true', () => {
    const mv = new Multiverse(SRC);
    const { matches, error } = mv.query(mv.root, 'total > 20');
    expect(error).toBeNull();
    const first = mv.stateAt(mv.root, matches[0]);
    expect(tryEvaluate(mv.vm, first, 0, 'total')).toEqual({ value: 21 });
    const before = mv.stateAt(mv.root, matches[0] - 1);
    expect(tryEvaluate(mv.vm, before, 0, 'total')).toEqual({ value: 15 });
  });

  it('reports a useful error when a query never makes sense', () => {
    const mv = new Multiverse(SRC);
    expect(mv.query(mv.root, 'nope > 1').error).toMatch(/not defined/);
    expect(mv.query(mv.root, 'total >').error).toMatch(/Unexpected/);
  });

  it('refuses side effects in read-only evaluation', () => {
    const mv = new Multiverse(SRC);
    const s = mv.stateAt(mv.root, 5);
    const before = fingerprint(s);
    expect(tryEvaluate(mv.vm, s, 0, 'double(2)')).toHaveProperty('error');
    expect(tryEvaluate(mv.vm, s, 0, '[1, 2]')).toHaveProperty('error');
    expect(tryEvaluate(mv.vm, s, 0, 'len("abc") + total * 2')).toHaveProperty('value');
    expect(fingerprint(s)).toBe(before);
  });

  it('continues to conditional breakpoints forwards and backwards', () => {
    const mv = new Multiverse(SRC);
    const tl = mv.root;
    const bp = [{ line: 4, condition: 'i == 7' }];
    const hit = mv.findBreakpoint(tl, 0, 1, bp);
    expect(hit && 'pos' in hit).toBe(true);
    const pos = (hit as { pos: number }).pos;
    expect(tryEvaluate(mv.vm, mv.stateAt(tl, pos), 0, 'i')).toEqual({ value: 7 });
    expect(mv.findBreakpoint(tl, pos, 1, bp)).toBeNull();
    expect(mv.findBreakpoint(tl, tl.endPos, -1, bp)).toEqual({ pos });
    expect(mv.findBreakpoint(tl, 0, 1, [{ line: 4, condition: 'i ==' }])).toHaveProperty('error');
  });

  it('evaluates arbitrary expressions, including calls, at any moment', () => {
    const mv = new Multiverse(SRC);
    const tl = mv.root;
    const mid = tl.lines.indexOf(4) + 6;
    const before = fingerprint(mv.stateAt(tl, mid));
    const r = mv.evaluate(tl, mid, 0, 'double(total) + i');
    expect(r.error).toBeNull();
    const s = mv.stateAt(tl, mid);
    const expected = 2 * (tryEvaluate(mv.vm, s, 0, 'total') as { value: number }).value + (tryEvaluate(mv.vm, s, 0, 'i') as { value: number }).value;
    expect(r.value).toBe(String(expected));
    expect(fingerprint(mv.stateAt(tl, mid))).toBe(before);
    expect(mv.evaluate(tl, mid, 0, 'map([1, 2], double)').value).toBe('[2, 4]');
    expect(mv.evaluate(tl, mid, 0, 'print("hi")').output).toEqual(['hi']);
    expect(mv.evaluate(tl, mid, 0, 'undefinedThing').error).toMatch(/Undefined variable/);
  });
});

describe('static analysis', () => {
  const msgs = (src: string) => analyze(src).map((d) => `${d.severity}@${d.line}: ${d.message}`);

  it('accepts a clean program', () => {
    expect(analyze('fn f(x) => x + 1\nlet a = f(1)\nprint(a)')).toEqual([]);
  });

  it('finds undefined names with suggestions', () => {
    expect(msgs('let total = 1\nprint(totl)')).toEqual([
      "warning@1: 'total' is never read",
      "error@2: 'totl' is not defined. Did you mean 'total'?",
    ]);
  });

  it('allows functions to use globals declared after them', () => {
    expect(analyze('fn show() {\n  print(late)\n}\nlet late = 1\nshow()')).toEqual([]);
  });

  it('flags use before declaration in the same scope', () => {
    expect(msgs('print(x)\nlet x = 1')).toContain("error@1: 'x' is used before its declaration on line 2");
  });

  it('flags unused variables, unreachable code, bad assignments and arity', () => {
    const src = `
fn f(a) {
  return a
  print("never")
}
let unused = 1
undeclared = 2
print = 3
f(1, 2)`;
    expect(msgs(src)).toEqual([
      'warning@4: Unreachable code',
      "warning@6: 'unused' is never read",
      "error@7: 'undeclared' is not declared — use `let undeclared = …` first",
      "error@8: Cannot assign to builtin 'print'",
      'error@9: f() takes 1 argument but is given 2',
    ]);
  });

  it('understands closures, loops, catch variables and the stdlib', () => {
    const src = `
let fs = []
for i in 0..3 { push(fs, fn() => i) }
try { throw 1 } catch e { print(e) }
print(map(fs, fn(f) => f()))`;
    expect(analyze(src)).toEqual([]);
  });

  it('reports syntax errors as diagnostics', () => {
    const d = analyze('let x = (1 +\n');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('error');
  });

  it('finds no problems in the bundled examples except the intentional ones', async () => {
    const { EXAMPLES } = await import('../src/examples');
    for (const ex of EXAMPLES) {
      const errors = analyze(ex.code).filter((d) => d.severity === 'error');
      expect(errors, ex.id).toEqual([]);
    }
  });
});
