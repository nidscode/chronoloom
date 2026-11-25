import { describe, expect, it } from 'vitest';
import { Cursor, Multiverse, VM, compile, type VMState } from '../src/core';

/** A stable fingerprint of a machine state. */
function fingerprint(s: VMState): string {
  return JSON.stringify({
    frames: s.frames,
    stack: s.stack,
    heap: [...s.heap.entries()],
    event: s.event,
    line: s.line,
    halted: s.halted,
    rng: s.rng,
  });
}

const SORT = `
seed(42)
let xs = []
for i in 0..12 { push(xs, randint(1, 99)) }
fn bubble(a) {
  let n = len(a)
  for i in 0..n {
    for j in 0..n - i - 1 {
      if a[j] > a[j + 1] {
        let t = a[j]
        a[j] = a[j + 1]
        a[j + 1] = t
      }
    }
  }
  return a
}
bubble(xs)
print(xs)
`;

describe('time travel', () => {
  it('replaying from checkpoints reproduces every recorded state exactly', () => {
    const mv = new Multiverse(SORT, { checkpointEvery: 16 });
    const tl = mv.root;

    // Walk forward with a single independent VM and compare each position.
    const vm = new VM(compile(SORT));
    const live = vm.initialState(mv.seed);
    const truth: string[] = [];
    while (vm.stepEvent(live)) truth.push(fingerprint(live));

    expect(truth.length).toBe(tl.lines.length);
    for (let p = 0; p < tl.lines.length; p += 7) {
      expect(fingerprint(mv.stateAt(tl, p))).toBe(truth[p]);
    }
    // seeking backwards and in random order gives the same answers
    for (const p of [tl.lines.length - 1, 3, 200, 0, 57]) {
      expect(fingerprint(mv.stateAt(tl, p))).toBe(truth[p]);
    }
  });

  it('the cursor steps forward incrementally and agrees with random access', () => {
    const mv = new Multiverse(SORT);
    const cursor = new Cursor(mv, mv.root);
    for (let p = 0; p < 300; p++) {
      cursor.seek(p);
      if (p % 37 === 0) expect(fingerprint(cursor.state)).toBe(fingerprint(mv.stateAt(mv.root, p)));
    }
  });

  it('records line metadata, depths and output positions', () => {
    const mv = new Multiverse('fn f(x) {\n  return x * 2\n}\nlet a = f(1)\nprint(a)');
    const tl = mv.root;
    expect(tl.lines).toEqual([4, 2, 5]);
    expect(tl.depths).toEqual([1, 2, 1]);
    expect(tl.outputs).toEqual([{ pos: 2, text: '2' }]);
    expect(tl.outputsBefore(2)).toBe(0);
    expect(tl.outputsBefore(tl.endPos)).toBe(1);
  });

  it('supports step over / step out using call depth', () => {
    const src = 'fn f() {\n  let a = 1\n  let b = 2\n}\nf()\nlet z = 3';
    const tl = new Multiverse(src).root;
    // positions: 0 -> line 5 (call), 1 -> line 2, 2 -> line 3, 3 -> line 6
    expect(tl.lines).toEqual([5, 2, 3, 6]);
    expect(tl.stepOver(0)).toBe(3);
    expect(tl.stepOut(1)).toBe(3);
    expect(tl.stepOverBack(3)).toBe(0);
    expect(tl.stepOutBack(2)).toBe(0);
  });

  it('finds the previous change of a variable (reverse watchpoint)', () => {
    const src = 'let x = 1\nlet y = 0\nx = 5\ny = 1\ny = 2';
    const mv = new Multiverse(src);
    const tl = mv.root;
    const s = mv.stateAt(tl, tl.endPos);
    const [scope] = mv.vm.scopes(s, 0);
    const x = scope.vars.find(([k]) => k === 'x')![1];
    const w = tl.previousChange(tl.endPos, 'x', scope.envId, x);
    expect(w && tl.lines[w.pos]).toBe(3);
  });

  it('tracks mutations of the object a variable holds', () => {
    const src = 'let xs = [1, 2]\nlet other = 0\npush(xs, 3)\nother = 1';
    const mv = new Multiverse(src);
    const tl = mv.root;
    const s = mv.stateAt(tl, tl.endPos);
    const [scope] = mv.vm.scopes(s, 0);
    const xs = scope.vars.find(([k]) => k === 'xs')![1];
    const w = tl.previousChange(tl.endPos, 'xs', scope.envId, xs);
    expect(w && tl.lines[w.pos]).toBe(3);
  });

  it('collects numeric series for charts', () => {
    const tl = new Multiverse('let n = 6\nwhile n != 1 {\n  if n % 2 == 0 { n = n / 2 } else { n = 3 * n + 1 }\n}').root;
    expect(tl.numericSeries('n').map((p) => p.value)).toEqual([6, 3, 10, 5, 16, 8, 4, 2, 1]);
  });
});

describe('forking timelines', () => {
  const SRC = `
let limit = 3
let total = 0
for i in 0..limit {
  total += i
}
print("total", total)
`;

  it('creates an alternate timeline with a changed variable', () => {
    const mv = new Multiverse(SRC);
    const root = mv.root;
    expect(root.outputs.map((o) => o.text)).toEqual(['total 3']);

    // fork right before `let total = 0` runs, after `limit` has been bound
    const pos = root.lines.indexOf(3);
    const alt = mv.fork(root, pos, 0, 'limit', '10');
    expect(alt.outputs.map((o) => o.text)).toEqual(['total 45']);
    expect(alt.parent).toBe(root);
    expect(alt.forkPos).toBe(pos);
    expect(alt.label).toBe('limit = 10');

    // the original timeline is untouched
    expect(root.outputs.map((o) => o.text)).toEqual(['total 3']);
    expect(alt.lines.slice(0, pos + 1)).toEqual(root.lines.slice(0, pos + 1));
    expect(alt.divergence()).toBe(0);
  });

  it('positions before the fork are identical in both timelines', () => {
    const mv = new Multiverse(SRC);
    const pos = 4;
    const alt = mv.fork(mv.root, pos, 0, 'total', '100');
    for (let p = 0; p < pos; p++) {
      expect(fingerprint(mv.stateAt(alt, p))).toBe(fingerprint(mv.stateAt(mv.root, p)));
    }
    expect(alt.outputs.at(-1)!.text).not.toBe(mv.root.outputs.at(-1)!.text);
  });

  it('can fork a fork, building a tree of timelines', () => {
    const mv = new Multiverse(SRC);
    const a = mv.fork(mv.root, 1, 0, 'limit', '5');
    const b = mv.fork(a, 2, 0, 'total', '1000');
    expect(b.ancestry().map((t) => t.id)).toEqual([0, 1, 2]);
    expect(b.outputs.map((o) => o.text)).toEqual(['total 1010']);
    expect(mv.timelines).toHaveLength(3);
  });

  it('injects structured values', () => {
    const mv = new Multiverse('let xs = [3, 1, 2]\nlet s = sort(xs)\nprint(s)');
    const alt = mv.fork(mv.root, 1, 0, 'xs', '[9, 8, 7, 1]');
    expect(alt.outputs.map((o) => o.text)).toEqual(['[1, 7, 8, 9]']);
  });

  it('rejects non-literal injected values', () => {
    const mv = new Multiverse('let a = 1\nlet b = 2');
    expect(() => mv.fork(mv.root, 1, 0, 'a', 'print(1)')).toThrow();
  });
});

describe('snapshots', () => {
  it('cloneState produces an independent deep copy', async () => {
    const { cloneState } = await import('../src/core/vm');
    const mv = new Multiverse('let xs = [1, 2]\nlet r = {a: [3]}\nfn f() => 1\nlet z = 0');
    const s = mv.stateAt(mv.root, mv.root.endPos);
    const c = cloneState(s);
    expect(fingerprint(c)).toBe(fingerprint(s));
    expect(JSON.stringify([...c.heap])).toBe(JSON.stringify([...structuredClone(s).heap]));
    // mutate the copy everywhere it could share structure
    for (const o of c.heap.values()) {
      if (o.t === 'arr') o.v.push(99);
      if (o.t === 'rec' || o.t === 'env') o.v.extra = 1;
    }
    c.frames[0].ip = 12345;
    c.stack.push(7);
    expect(fingerprint(s)).toBe(fingerprint(mv.stateAt(mv.root, mv.root.endPos)));
  });
});
