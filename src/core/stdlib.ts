/**
 * The Loom standard library, written in Loom itself.
 *
 * It is compiled as "internal" code: no statement-boundary events and no
 * line numbers, so it never clutters the timeline. Its functions live in the
 * builtin prelude scope. When a callback you pass (say, to `map`) runs, *its*
 * statements are recorded as usual, so you can still step through them.
 */

export const STDLIB_SOURCE = `
fn map(xs, f) {
  let out = []
  for x in xs { push(out, f(x)) }
  return out
}

fn filter(xs, f) {
  let out = []
  for x in xs {
    if f(x) { push(out, x) }
  }
  return out
}

fn reduce(xs, f, init) {
  let acc = init
  for x in xs { acc = f(acc, x) }
  return acc
}

fn each(xs, f) {
  for x in xs { f(x) }
}

fn find(xs, f) {
  for x in xs {
    if f(x) { return x }
  }
  return nil
}

fn findIndex(xs, f) {
  for i in 0..len(xs) {
    if f(xs[i]) { return i }
  }
  return -1
}

fn indexOf(xs, v) {
  for i in 0..len(xs) {
    if xs[i] == v { return i }
  }
  return -1
}

fn any(xs, f) {
  for x in xs {
    if f(x) { return true }
  }
  return false
}

fn all(xs, f) {
  for x in xs {
    if not f(x) { return false }
  }
  return true
}

fn count(xs, f) {
  let n = 0
  for x in xs {
    if f(x) { n += 1 }
  }
  return n
}

fn times(n, f) {
  let out = []
  for i in 0..n { push(out, f(i)) }
  return out
}

fn zip(a, b) {
  let out = []
  for i in 0..min(len(a), len(b)) { push(out, [a[i], b[i]]) }
  return out
}

fn enumerate(xs) {
  let out = []
  for i in 0..len(xs) { push(out, [i, xs[i]]) }
  return out
}

fn flatten(xs) {
  let out = []
  for x in xs {
    if type(x) == "array" {
      for y in x { push(out, y) }
    } else {
      push(out, x)
    }
  }
  return out
}

fn unique(xs) {
  let out = []
  for x in xs {
    if not has(out, x) { push(out, x) }
  }
  return out
}

fn sortBy(xs, key) {
  if len(xs) <= 1 { return copy(xs) }
  let mid = floor(len(xs) / 2)
  let a = sortBy(slice(xs, 0, mid), key)
  let b = sortBy(slice(xs, mid), key)
  let out = []
  let i = 0
  let j = 0
  while i < len(a) and j < len(b) {
    if key(b[j]) < key(a[i]) {
      push(out, b[j])
      j += 1
    } else {
      push(out, a[i])
      i += 1
    }
  }
  while i < len(a) {
    push(out, a[i])
    i += 1
  }
  while j < len(b) {
    push(out, b[j])
    j += 1
  }
  return out
}
`;

/** Names defined by the standard library (for the linter and autocomplete). */
export const STDLIB_NAMES = [
  'map',
  'filter',
  'reduce',
  'each',
  'find',
  'findIndex',
  'indexOf',
  'any',
  'all',
  'count',
  'times',
  'zip',
  'enumerate',
  'flatten',
  'unique',
  'sortBy',
];
