/** Built-in example programs. Each one shows off a different part of the debugger. */

export interface Example {
  id: string;
  title: string;
  blurb: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'welcome',
    title: 'Introduction',
    blurb: 'A first look at time travel',
    code: `// Chronoloom records every statement this program executes.
//
//  - Drag the timeline under the editor to move between steps
//  - Left / Right arrows step back and forward
//  - Shift + arrows step over function calls; [ and ] step out
//  - The pencil next to a variable sets a new value and re-runs from that step
//  - The arrows next to a variable go to its previous / next change
//  - Click the strip left of the line numbers to go to the next run of that line

fn greet(name, times) {
  let message = "Hello, " + name + "!"
  for i in 0..times {
    print(message + " #" + (i + 1))
  }
  return len(message) * times
}

let total = greet("time traveler", 3)
print("characters printed:", total)

// Primes below 40, trial division
let primes = []
for n in 2..40 {
  let isPrime = true
  for d in 2..n {
    if d * d > n { break }
    if n % d == 0 { isPrime = false; break }
  }
  if isPrime { push(primes, n) }
}
print(primes)
`,
  },
  {
    id: 'fib',
    title: 'Recursive Fibonacci',
    blurb: 'The flame chart and profiler',
    code: `// Recursive Fibonacci. The flame chart under the editor shows every call:
// each box is one fib(n), nested by call depth. Scroll on it to zoom,
// double-click a box to zoom into that call.
//
// Try: Step Out ( ] ) to leave the current call, Shift+Right to step over one,
// open the Profile tab, or set a breakpoint on line 13 with condition n == 6
// and press F8 / Shift+F8 to jump between those calls.

fn fib(n) {
  if n < 2 {
    return n
  }
  let a = fib(n - 1)
  let b = fib(n - 2)
  return a + b
}

let results = []
for i in 0..10 {
  push(results, fib(i))
}
print(results)
`,
  },
  {
    id: 'bubble',
    title: 'Bubble sort',
    blurb: 'Watch an array get sorted',
    code: `// Bubble sort, one comparison at a time. Press Play and watch the bars.
// The little markers under the bars are integer variables (i, j) that
// currently point into the array.
//
// Then: rewind to the start, click the pencil next to xs, type a new array
// such as [5, 4, 3, 2, 1] and see a second timeline unfold.

seed(2026)
let xs = []
for k in 0..14 {
  push(xs, randint(5, 99))
}

let swaps = 0
let n = len(xs)
for i in 0..n {
  let swapped = false
  for j in 0..n - i - 1 {
    if xs[j] > xs[j + 1] {
      let tmp = xs[j]
      xs[j] = xs[j + 1]
      xs[j + 1] = tmp
      swaps += 1
      swapped = true
    }
  }
  if not swapped { break }
}
print("sorted:", xs)
print("swaps:", swaps)
`,
  },
  {
    id: 'quicksort',
    title: 'Quicksort',
    blurb: 'Recursion + in-place partitioning',
    code: `// Quicksort with Lomuto partitioning. Inside partition(), the array a
// is the very same object as the global data (the Data panel says so):
// mutations through one name are visible through the other.

seed(7)
let data = []
for k in 0..16 {
  push(data, randint(1, 60))
}

fn swap(a, x, y) {
  let t = a[x]
  a[x] = a[y]
  a[y] = t
}

fn partition(a, lo, hi) {
  let pivot = a[hi]
  let i = lo
  for j in lo..hi {
    if a[j] < pivot {
      swap(a, i, j)
      i += 1
    }
  }
  swap(a, i, hi)
  return i
}

fn quicksort(a, lo, hi) {
  if lo >= hi { return }
  let p = partition(a, lo, hi)
  quicksort(a, lo, p - 1)
  quicksort(a, p + 1, hi)
}

quicksort(data, 0, len(data) - 1)
print(data)
`,
  },
  {
    id: 'bughunt',
    title: 'Bug hunt',
    blurb: 'Find the culprit with reverse watchpoints',
    code: `// Bug hunt: the vault ends up with a negative balance and the assert fails.
// You are parked at the crash. Which line broke it?
//
// 1. In the Variables panel, click the "previous change" arrow next to vault.
//    It jumps back to the last statement that changed it.
// 2. Keep clicking to walk backwards through every change.
// 3. Or search the whole run: type  vault.balance < 0  into the Find box
//    under the editor and press Enter to land on the first bad moment.
// 4. Found it? Fix the code. Or click the pencil to fork a timeline where
//    the fee is different, and compare the outcomes.

let vault = {balance: 100, log: []}

fn deposit(v, amount) {
  v.balance += amount
  push(v.log, "+" + amount)
}

fn withdraw(v, amount) {
  if amount <= v.balance {
    v.balance -= amount
    push(v.log, "-" + amount)
  }
}

fn applyFee(v, rate) {
  // charges a small percentage fee... or does it?
  let fee = v.balance * rate
  v.balance -= fee * 100
  push(v.log, "fee " + round(fee))
}

seed(3)
for day in 1..8 {
  let roll = randint(1, 3)
  if roll == 1 { deposit(vault, randint(10, 50)) }
  if roll == 2 { withdraw(vault, randint(20, 80)) }
  if day % 7 == 0 { applyFee(vault, 0.02) }
}
print("final balance:", vault.balance)
assert(vault.balance >= 0, "the vault went negative!")
`,
  },
  {
    id: 'collatz',
    title: 'Collatz sequence',
    blurb: 'Chart a variable across timelines',
    code: `// The Collatz conjecture: halve even numbers, triple-and-add-one odd ones.
// Every starting number seems to fall back to 1 eventually.
//
// 1. Click the plot button next to n to plot its path.
// 2. Go to the start (Home key), step once so n exists, click the pencil
//    next to n and type 27. A new timeline appears in the Timelines panel.
// 3. The chart overlays the parent timeline so you can compare them.

let n = 7
let steps = 0
let peak = n
while n != 1 {
  if n % 2 == 0 {
    n = n / 2
  } else {
    n = 3 * n + 1
  }
  steps += 1
  peak = max(peak, n)
}
print("steps:", steps, "peak:", peak)
`,
  },
  {
    id: 'life',
    title: 'Game of Life',
    blurb: '2D arrays become grids',
    code: `// Conway's Game of Life on a wrapping board, starring a glider and a blinker.
// The Data panel draws any 2D array as a grid. Scrub the timeline to watch
// each generation being built cell by cell.

let size = 10
let board = grid(size, size, 0)

// a glider
board[0][1] = 1
board[1][2] = 1
board[2][0] = 1
board[2][1] = 1
board[2][2] = 1
// a blinker
board[6][6] = 1
board[6][7] = 1
board[6][8] = 1

fn neighbours(b, r, c) {
  let count = 0
  for dr in -1..2 {
    for dc in -1..2 {
      if dr != 0 or dc != 0 {
        count += b[(r + dr) % size][(c + dc) % size]
      }
    }
  }
  return count
}

fn step(b) {
  let next = grid(size, size, 0)
  for r in 0..size {
    for c in 0..size {
      let n = neighbours(b, r, c)
      if n == 3 or (n == 2 and b[r][c] == 1) {
        next[r][c] = 1
      }
    }
  }
  return next
}

for gen in 0..6 {
  board = step(board)
}

let alive = 0
for row in board {
  alive += sum(row)
}
print("alive after 6 generations:", alive)
`,
  },
  {
    id: 'maze',
    title: 'Maze solver (BFS)',
    blurb: 'Breadth-first search, visualised',
    code: `// Breadth-first search through a maze. Walls are #, the flood fill writes
// each cell's distance from the start, then the path is traced back with *.

let plan = [
  "S..#......",
  ".#.#.####.",
  ".#...#....",
  ".####.#.#.",
  "......#.#.",
  "#.#####.#.",
  "..#.....#.",
  ".##.###.##",
  "....#....E",
]

let rows = len(plan)
let cols = len(plan[0])
let maze = grid(rows, cols, 0)
let start = nil
let goal = nil
for r in 0..rows {
  for c in 0..cols {
    let ch = plan[r][c]
    if ch == "#" { maze[r][c] = "#" }
    if ch == "S" { start = [r, c] }
    if ch == "E" { goal = [r, c] }
  }
}

// flood fill: distances start at 1 so the start cell is visible
let queue = [start]
let head = 0
maze[start[0]][start[1]] = 1
let dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]]
while head < len(queue) {
  let cell = queue[head]
  head += 1
  for d in dirs {
    let r = cell[0] + d[0]
    let c = cell[1] + d[1]
    if r >= 0 and r < rows and c >= 0 and c < cols and maze[r][c] == 0 {
      maze[r][c] = maze[cell[0]][cell[1]] + 1
      push(queue, [r, c])
    }
  }
}

// walk back from the goal along decreasing distances
let r = goal[0]
let c = goal[1]
let length = maze[r][c] - 1
while maze[r][c] != 1 {
  let here = maze[r][c]
  maze[r][c] = "*"
  for d in dirs {
    let nr = r + d[0]
    let nc = c + d[1]
    if nr >= 0 and nr < rows and nc >= 0 and nc < cols and maze[nr][nc] == here - 1 {
      r = nr
      c = nc
      break
    }
  }
}
maze[r][c] = "*"
print("shortest path length:", length)
`,
  },
  {
    id: 'closures',
    title: 'Closures',
    blurb: 'Captured scopes, made visible',
    code: `// Closures remember the scope they were born in.
// Step into the counter calls (Right arrow) and watch the Variables panel:
// each counter's count lives in its own captured scope, labelled "closure".

fn makeCounter(label) {
  let count = 0
  return fn(amount) {
    count += amount
    return label + ": " + count
  }
}

let apples = makeCounter("apples")
let pears = makeCounter("pears")
print(apples(1))
print(apples(2))
print(pears(10))
print(apples(3))
print(pears(5))
`,
  },
  {
    id: 'montecarlo',
    title: 'Monte Carlo pi',
    blurb: 'Seeded randomness, replayable',
    code: `// Estimating pi by throwing random darts at a unit square.
// Randomness in Loom is seeded and lives inside the machine state, so every
// replay is identical. That is what makes time travel possible.
//
// Plot estimate to watch it converge, then fork with a bigger darts count.

seed(1)
let darts = 300
let inside = 0
let estimate = 0
for k in 1..darts + 1 {
  let x = random()
  let y = random()
  if x * x + y * y <= 1 {
    inside += 1
  }
  estimate = 4 * inside / k
}
print("pi is roughly", estimate)
`,
  },
  {
    id: 'hanoi',
    title: 'Towers of Hanoi',
    blurb: 'Records of arrays',
    code: `// Towers of Hanoi: three pegs stored as arrays inside a record.
// The Data panel draws each peg. Step over (Shift+Right) the recursive calls
// to move a whole tower at once, or step into them to see every disc move.

let pegs = {A: [5, 4, 3, 2, 1], B: [], C: []}
let moves = 0

fn hanoi(n, from, to, via) {
  if n == 0 { return }
  hanoi(n - 1, from, via, to)
  push(pegs[to], pop(pegs[from]))
  moves += 1
  hanoi(n - 1, via, to, from)
}

hanoi(5, "A", "C", "B")
print("solved in", moves, "moves:", pegs)
`,
  },
  {
    id: 'errors',
    title: 'Exceptions',
    blurb: 'try / catch / throw',
    code: `// Errors are values you can catch. Runtime errors (like a bad index or a
// failed conversion) become records with a message and a line, and the stack
// unwinds to the nearest try. In the flame chart, calls cut short by a throw
// simply end early.

fn parseScore(text) {
  let n = num(text)
  if n < 0 or n > 100 {
    throw "out of range: {n}"
  }
  return n
}

fn describe(err) {
  if type(err) == "record" { return err.message }
  return err
}

fn average(entries) {
  let total = 0
  let ok = 0
  for e in entries {
    try {
      total += parseScore(e)
      ok += 1
    } catch err {
      print("skipped {e}: {describe(err)}")
    }
  }
  return total / ok
}

let raw = ["90", "75", "abc", "120", "88"]
print("average: {round(average(raw))}")

try {
  let xs = [1, 2, 3]
  print(xs[10])
} catch err {
  print("caught on line {err.line}: {err.message}")
}
`,
  },
  {
    id: 'functional',
    title: 'Functional style',
    blurb: 'map, filter, reduce and interpolation',
    code: `// The standard library (map, filter, reduce, sortBy, …) is written in Loom
// itself. Its own code stays off the timeline, but the callbacks you pass in
// are recorded like any other code, so you can step into them.
//
// Try the console (Output panel, Console tab): count(words, fn(w) => len(w) == 3)

let words = split("the quick brown fox jumps over the lazy dog", " ")
let lengths = map(words, fn(w) => len(w))
let long = filter(words, fn(w) => len(w) > 3)
let total = reduce(lengths, fn(a, b) => a + b, 0)
let byLength = sortBy(unique(words), fn(w) => len(w))
let longest = byLength[-1]

print("{len(words)} words, {total} letters")
print("long words: {join(long, ", ")}")
print("sorted by length: {byLength}")
print("longest: {longest} ({len(longest)} letters)")

let counts = {}
each(words, fn(w) {
  counts[w] = (counts[w] or 0) + 1
})
print("counts: {counts}")
`,
  },
];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
