import { describe, expect, it } from 'vitest';
import { run } from '../src/core';
import { EXAMPLES } from '../src/examples';

describe('bundled examples', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.title} runs to completion`, () => {
      const r = run(ex.code);
      if (ex.id === 'bughunt') {
        // this one is *supposed* to crash — it's a debugging exercise
        expect(r.end.kind).toBe('error');
        if (r.end.kind === 'error') expect(r.end.error.message).toMatch(/negative/);
      } else {
        if (r.end.kind === 'error') throw new Error(`${r.end.error.message} @ line ${r.end.error.line}`);
        expect(r.end.kind).toBe('done');
      }
      expect(r.output.length).toBeGreaterThan(0);
    });
  }

  it('produce the expected results', () => {
    const out = (id: string) => run(EXAMPLES.find((e) => e.id === id)!.code).output;
    expect(out('fib')).toEqual(['[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]']);
    expect(out('collatz')).toEqual(['steps: 16 peak: 52']);
    expect(out('hanoi')[0]).toMatch(/solved in 31 moves/);
    expect(out('welcome').at(-1)).toBe('[2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]');
  });
});
