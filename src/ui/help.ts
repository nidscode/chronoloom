/** Contents of the help dialog: language reference + controls. */

export const HELP_HTML = `
<div class="help-inner">
  <button class="btn ghost help-close" data-close title="Close (Esc)">✕</button>
  <h2>Help</h2>
  <p>Chronoloom runs programs written in Loom, a small scripting language. Each statement the
  program executes is recorded as a step, so you can move backward and forward through the run,
  inspect variables at any step, search the whole history, and evaluate code in the past. You can
  also change a variable at a step; the program then re-runs from there as a separate timeline,
  and the original run is kept.</p>

  <div class="help-grid">
    <div>
      <h3>Keyboard</h3>
      <table>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>step back / forward one statement</td></tr>
        <tr><td><kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd></td><td>step over function calls</td></tr>
        <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>step out: to the call site / past the return</td></tr>
        <tr><td><kbd>F8</kbd> <kbd>Shift</kbd>+<kbd>F8</kbd></td><td>continue to the next / previous breakpoint hit</td></tr>
        <tr><td><kbd>Home</kbd> <kbd>End</kbd></td><td>first / last step</td></tr>
        <tr><td><kbd>Space</kbd></td><td>play / pause</td></tr>
        <tr><td><kbd>/</kbd></td><td>search the history (Find box)</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>run (re-record) the program</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>leave the editor so the arrow keys move between steps</td></tr>
      </table>
      <h3>Debugger</h3>
      <ul>
        <li><b>Flame chart</b> (under the editor): every function call over time, nested by depth.
          Click or drag to move, scroll to zoom, double-click a call to zoom into it.</li>
        <li><b>Find</b>: type an expression such as <code>total &gt; 20</code>; every step where it is
          true is marked, and Enter / Shift+Enter jump between them.</li>
        <li><b>Breakpoints</b>: click left of a line number. Add a condition in the Breakpoints tab.
          F8 continues forward, Shift+F8 continues backward.</li>
        <li><b>Watch</b>: add expressions at the top of the Variables panel; they update at every step.</li>
        <li><b>Console</b>: evaluate anything, including calls to your own functions, as if it ran at
          the current step. The recording is not changed.</li>
        <li><b>Hover</b> a variable in the editor to see its value at the current step.</li>
        <li><b>Arrows</b> next to a variable: go to the previous / next statement that changed it
          (including mutations of the array or record it holds).</li>
        <li><b>Pencil</b>: set a variable to a new value at the current step and re-run from there as a new timeline.</li>
        <li><b>Plot button</b>: plot every numeric value a variable has taken. In a fork, the parent's
          history appears as a dashed line.</li>
        <li><b>Profile</b> tab: calls, self and total steps per function. Click a row to highlight it in the flame chart.</li>
        <li><b>Heat strip</b> left of the line numbers: how often each line ran. Click it to jump to
          the next run of that line (Shift+click: previous run).</li>
        <li><b>Problems</b>: undefined or unused variables, unreachable code and wrong argument
          counts are underlined while you type.</li>
      </ul>
    </div>
    <div>
      <h3>The Loom language</h3>
<pre>// variables & functions
let name = "Ada"
fn square(x) { return x * x }
fn double(x) => x * 2
let twice = fn(f, x) => f(f(x))

// strings
print("hello {name}, 2 + 2 = {2 + 2}")

// control flow
if a > b and not done { … } else if … { … } else { … }
while n > 0 { n -= 1 }
for i in 0..10 { … }       // 0 to 9
for item in [1, 2, 3] { … }
for key in {a: 1, b: 2} { … }
break   continue   return

// errors
try {
  throw "bad input"
} catch err {
  print(err)
}

// data
let xs = [3, 1, 2]
xs[0] = 9            xs[-1]   // last element
let p = {x: 1, y: 2}
p.x += 5             p["y"]
let board = grid(3, 3, 0)  board[1][2] = 1

// standard library
map(xs, fn(x) => x * 2)
filter(xs, fn(x) => x > 1)
reduce(xs, fn(a, b) => a + b, 0)</pre>
      <p>Values: numbers, strings, <code>true</code>/<code>false</code>, <code>nil</code>, arrays,
      records and functions (closures). Only <code>false</code> and <code>nil</code> are falsy.
      <code>+</code> joins strings with anything; <code>%</code> is a true modulo. Runtime errors
      can be caught; the error is a record with <code>message</code> and <code>line</code>.</p>
    </div>
  </div>

  <h3>Builtins</h3>
  <table>
    <tr><td>output</td><td><code>print(a, b, …)</code></td></tr>
    <tr><td>arrays</td><td><code>len push pop insert remove slice sort reverse copy fill grid range sum min max has join</code></td></tr>
    <tr><td>functional</td><td><code>map filter reduce each find findIndex indexOf any all count times zip enumerate flatten unique sortBy</code> (written in Loom)</td></tr>
    <tr><td>records</td><td><code>keys values has len copy</code></td></tr>
    <tr><td>strings</td><td><code>len split join upper lower trim char code str num slice reverse</code></td></tr>
    <tr><td>math</td><td><code>abs floor ceil round int sqrt pow sin cos atan2 log PI</code></td></tr>
    <tr><td>random</td><td><code>random() randint(lo, hi) seed(n)</code>: seeded, so every replay is identical</td></tr>
    <tr><td>checks</td><td><code>type(x) assert(cond, msg) error(msg)</code></td></tr>
  </table>

  <h3>How it works</h3>
  <p>The compiler turns source into stack-machine bytecode and inserts a <code>LINE</code>
  instruction at every statement. All machine state (frames, exception handlers, operand stack,
  heap, PRNG seed) is plain data, so a snapshot is a cheap structural copy. While recording, a full
  snapshot is kept every 64 statements, along with the call tree and every variable write. Jumping
  to any moment restores the nearest snapshot and deterministically replays at most 63 statements.
  A fork copies the parent's history up to the fork point, applies your edit to the restored
  state, and records onward. Searches, conditional breakpoints and watches evaluate expressions
  read-only against those states; the console runs on a throwaway copy.</p>
  <p>Chronoloom by Nidhi Bivalkar.</p>
</div>
`;
