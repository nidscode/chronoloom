import { describe, expect, it } from 'vitest';
import { LoomSyntaxError, compile, parse, run, tokenize } from '../src/core';

const out = (src: string) => {
  const r = run(src);
  if (r.end.kind === 'error') throw new Error(`runtime error: ${r.end.error.message} (line ${r.end.error.line})`);
  return r.output;
};

const err = (src: string) => {
  const r = run(src);
  if (r.end.kind !== 'error') throw new Error('expected a runtime error');
  return r.end.error;
};

describe('lexer', () => {
  it('tokenizes numbers, strings, keywords and punctuation', () => {
    const toks = tokenize('let x = 1_000.5 + "hi\\n" // comment\nx..y');
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ['keyword', 'let'],
      ['ident', 'x'],
      ['punct', '='],
      ['number', '1000.5'],
      ['punct', '+'],
      ['string', 'hi\n'],
      ['ident', 'x'],
      ['punct', '..'],
      ['ident', 'y'],
      ['eof', ''],
    ]);
  });

  it('tracks newlines between tokens', () => {
    const toks = tokenize('a\nb c');
    expect(toks.map((t) => t.nl)).toEqual([true, true, false, true]);
  });

  it('reports helpful errors for foreign operators', () => {
    expect(() => tokenize('a && b')).toThrow(/and/);
    expect(() => tokenize('!a')).toThrow(/not/);
    expect(() => tokenize('"abc')).toThrow(/Unterminated/);
  });
});

describe('parser', () => {
  it('parses a function declaration and calls', () => {
    const ast = parse('fn add(a, b) { return a + b }\nprint(add(1, 2))');
    expect(ast.body[0].kind).toBe('FnDecl');
    expect(ast.body[1].kind).toBe('ExprStmt');
  });

  it('does not treat a parenthesis on a new line as a call', () => {
    const ast = parse('let a = b\n(1 + 2)');
    expect(ast.body).toHaveLength(2);
  });

  it('reports line and column of syntax errors', () => {
    try {
      parse('let x = 1\nlet = 2');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LoomSyntaxError);
      expect((e as LoomSyntaxError).line).toBe(2);
    }
  });

  it('rejects return outside functions and break outside loops', () => {
    expect(() => compile('return 1')).toThrow(/only allowed inside a function/);
    expect(() => compile('break')).toThrow(/outside of a loop/);
  });
});

describe('evaluation', () => {
  it('does arithmetic with correct precedence', () => {
    expect(out('print(1 + 2 * 3, (1 + 2) * 3, 7 % 3, -7 % 3, 10 / 4)')).toEqual(['7 9 1 2 2.5']);
  });

  it('concatenates strings with anything', () => {
    expect(out('print("n=" + 3 + " ok=" + true + " " + [1, "a"])')).toEqual(['n=3 ok=true [1, "a"]']);
  });

  it('supports if / else if / else', () => {
    const src = `
      fn grade(x) {
        if x >= 90 { return "A" } else if x >= 80 { return "B" } else { return "C" }
      }
      print(grade(95), grade(85), grade(10))`;
    expect(out(src)).toEqual(['A B C']);
  });

  it('runs while loops with break and continue', () => {
    const src = `
      let i = 0
      let acc = []
      while true {
        i += 1
        if i % 2 == 0 { continue }
        if i > 9 { break }
        push(acc, i)
      }
      print(acc)`;
    expect(out(src)).toEqual(['[1, 3, 5, 7, 9]']);
  });

  it('iterates ranges, arrays, strings and records', () => {
    const src = `
      let s = 0
      for i in 0..5 { s += i }
      let t = ""
      for ch in "abc" { t = ch + t }
      let ks = []
      for k in {x: 1, y: 2} { push(ks, k) }
      let total = 0
      for v in [10, 20, 30] { total += v }
      print(s, t, ks, total)`;
    expect(out(src)).toEqual(['10 cba ["x", "y"] 60']);
  });

  it('handles break/continue inside nested scoped loops', () => {
    const src = `
      let found = []
      for i in 0..4 {
        let row = i * 10
        for j in 0..4 {
          let v = row + j
          if j == 2 { continue }
          if j == 3 { break }
          push(found, v)
        }
      }
      print(found)`;
    expect(out(src)).toEqual(['[0, 1, 10, 11, 20, 21, 30, 31]']);
  });

  it('implements lexical closures', () => {
    const src = `
      fn counter() {
        let n = 0
        return fn() { n += 1; return n }
      }
      let a = counter()
      let b = counter()
      a(); a()
      print(a(), b())`;
    expect(out(src)).toEqual(['3 1']);
  });

  it('captures a fresh loop variable per iteration', () => {
    const src = `
      let fs = []
      for i in 0..3 { push(fs, fn() { return i * i }) }
      print(fs[0](), fs[1](), fs[2]())`;
    expect(out(src)).toEqual(['0 1 4']);
  });

  it('hoists function declarations (mutual recursion)', () => {
    const src = `
      print(isEven(10), isOdd(7))
      fn isEven(n) { if n == 0 { return true } return isOdd(n - 1) }
      fn isOdd(n) { if n == 0 { return false } return isEven(n - 1) }`;
    expect(out(src)).toEqual(['true true']);
  });

  it('short-circuits and / or', () => {
    const src = `
      let calls = 0
      fn touch() { calls += 1; return true }
      let a = false and touch()
      let b = true or touch()
      let c = nil or "fallback"
      print(a, b, c, calls)`;
    expect(out(src)).toEqual(['false true fallback 0']);
  });

  it('supports records and compound assignment on fields and indices', () => {
    const src = `
      let p = {name: "ada", score: 1}
      p.score += 41
      p.tags = ["math"]
      let xs = [1, 2, 3]
      xs[1] *= 10
      xs[-1] = 99
      print(p, xs, p["name"], p["missing"])`;
    expect(out(src)).toEqual(['{name: "ada", score: 42, tags: ["math"]} [1, 20, 99] ada nil']);
  });

  it('has a useful standard library', () => {
    const src = `
      print(len("hey"), len([1,2]), sort([3,1,2]), reverse("abc"), join(["a","b"], "-"))
      print(split("a,b,c", ","), slice([1,2,3,4], 1, 3), max(4, 9, 2), min([5, 3, 8]), sum([1,2,3]))
      print(range(3), range(1, 10, 4), floor(2.7), abs(-3), type({}), type(print), has([1,2], 2))
      print(upper("loom"), num("42") + 1, str(1.5) + "!", grid(2, 2, 0))`;
    expect(out(src)).toEqual([
      '3 2 [1, 2, 3] cba a-b',
      '["a", "b", "c"] [2, 3] 9 3 6',
      '[0, 1, 2] [1, 5, 9] 2 3 record function true',
      'LOOM 43 1.5! [[0, 0], [0, 0]]',
    ]);
  });

  it('produces deterministic pseudo-random numbers', () => {
    const src = 'seed(7)\nprint(randint(1, 100), randint(1, 100), randint(1, 100))';
    expect(out(src)).toEqual(out(src));
    const a = out('seed(1)\nprint(random())');
    const b = out('seed(2)\nprint(random())');
    expect(a).not.toEqual(b);
  });

  it('recurses deeply enough for classic algorithms', () => {
    const src = `
      fn fib(n) { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }
      print(fib(15))`;
    expect(out(src)).toEqual(['610']);
  });
});

describe('runtime errors', () => {
  it('reports undefined variables with suggestions', () => {
    const e = err('let total = 1\nprint(totl)');
    expect(e.message).toMatch(/Undefined variable 'totl'. Did you mean 'total'/);
    expect(e.line).toBe(2);
  });

  it('reports out-of-bounds indexing', () => {
    expect(err('let a = [1]\nprint(a[3])').message).toMatch(/out of bounds/);
  });

  it('reports type errors', () => {
    expect(err('print(1 + nil)').message).toMatch(/Cannot apply '\+'/);
    expect(err('let x = 3\nx()').message).toMatch(/Cannot call number/);
  });

  it('detects runaway recursion', () => {
    expect(err('fn f(n) { return f(n + 1) }\nf(0)').message).toMatch(/Stack overflow/);
  });

  it('refuses to assign undeclared variables', () => {
    expect(err('x = 1').message).toMatch(/declare it first/);
  });

  it('stops infinite loops at the step limit', () => {
    const r = run('let i = 0\nwhile true { i += 1 }', { maxEvents: 1000 });
    expect(r.end.kind).toBe('limit');
    expect(r.steps).toBe(1000);
  });
});

describe('garbage collection', () => {
  it('collects garbage without changing program behaviour', () => {
    const src = `
      let keep = []
      for i in 0..3000 {
        let tmp = [i, i * 2, {v: i}]
        if i % 1000 == 0 { push(keep, tmp) }
      }
      print(len(keep), keep[2][2].v)`;
    const r = run(src);
    expect(r.output).toEqual(['3 2000']);
    // heap must have been collected: far fewer live objects than allocated
    expect(r.multiverse.root.endState.heap.size).toBeLessThan(5000);
  });
});
