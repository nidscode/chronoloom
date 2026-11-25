/**
 * `loom` — the Chronoloom command line.
 *
 *   loom run   <file>                 run a program
 *   loom trace <file> [--from N] [--to N]   print every recorded step
 *   loom heat  <file>                 source annotated with execution counts
 *   loom fork  <file> --at N --set name=value   compare two timelines
 *   loom query <file> "<expr>"         every step where an expression is true
 *   loom profile <file>               calls and steps per function
 *   loom dis   <file>                 show the compiled bytecode
 *   loom check <file>                 syntax errors and lint warnings
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyze, compile, disassemble, LoomRuntimeError, LoomSyntaxError, Multiverse, type Timeline } from '../core';

const VERSION = '1.0.0';
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  gold: paint('33'),
  blue: paint('34'),
  pink: paint('35'),
  cyan: paint('36'),
};

const HELP = `${c.bold('loom')} ${c.dim(VERSION)} — Chronoloom, a time-travelling language

${c.bold('usage')}
  loom run   <file.loom> [--max-steps N] [--seed N]
  loom trace <file.loom> [--from N] [--to N]
  loom heat  <file.loom>
  loom fork  <file.loom> --at <step> --set <name>=<value>
  loom query <file.loom> "<expression>" [--limit N]
  loom profile <file.loom>
  loom dis   <file.loom> [--all]
  loom check <file.loom>

${c.bold('examples')}
  loom run examples/fib.loom
  loom fork examples/collatz.loom --at 1 --set n=27
  loom heat examples/bubble.loom
  loom query examples/bughunt.loom "vault.balance < 0"
  loom profile examples/fib.loom

Made by Nidhi Bivalkar.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = 'true';
    } else if (a === '-h') flags.help = 'true';
    else if (a === '-v') flags.version = 'true';
    else positional.push(a);
  }
  return { positional, flags };
}

function fail(msg: string): never {
  console.error(c.red('error: ') + msg);
  process.exit(2);
}

function intFlag(flags: Record<string, string>, name: string, fallback: number): number {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} expects a non-negative integer`);
  return n;
}

function readSource(path: string | undefined): string {
  if (!path) fail('missing <file> argument (see `loom --help`)');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read ${path}`);
  }
}

function showSyntaxError(e: LoomSyntaxError, source: string, file: string): never {
  const line = source.split('\n')[e.line - 1] ?? '';
  console.error(`${c.red('syntax error')} ${c.dim(`${file}:${e.line}:${e.col}`)}\n  ${e.message}\n`);
  console.error(`  ${c.dim(String(e.line).padStart(4) + ' │')} ${line}`);
  console.error(`  ${' '.repeat(4)}${c.dim(' │')} ${' '.repeat(Math.max(0, e.col - 1))}${c.red('^')}`);
  process.exit(1);
}

function record(source: string, file: string, flags: Record<string, string>): Multiverse {
  try {
    return new Multiverse(source, {
      maxEvents: intFlag(flags, 'max-steps', 1_000_000),
      seed: flags.seed !== undefined ? intFlag(flags, 'seed', 0) : undefined,
    });
  } catch (e) {
    if (e instanceof LoomSyntaxError) showSyntaxError(e, source, file);
    throw e;
  }
}

function describeEnd(tl: Timeline, source: string, file: string): number {
  if (tl.end.kind === 'error') {
    const { line, message } = tl.end.error;
    console.error(`\n${c.red('runtime error')} ${c.dim(`${file}:${line}`)}  ${message}`);
    console.error(`  ${c.dim(String(line).padStart(4) + ' │')} ${source.split('\n')[line - 1]?.trim() ?? ''}`);
    console.error(c.dim(`  (after ${tl.endPos.toLocaleString()} steps — open it in the web IDE to rewind to the cause)`));
    return 1;
  }
  if (tl.end.kind === 'limit') {
    console.error(c.gold(`\nstopped: step limit of ${tl.endPos.toLocaleString()} reached (use --max-steps)`));
    return 3;
  }
  return 0;
}

// ------------------------------------------------------------------ commands

function cmdRun(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  const mv = record(source, file, flags);
  for (const o of mv.root.outputs) console.log(o.text);
  return describeEnd(mv.root, source, file);
}

function cmdTrace(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  const lines = source.split('\n');
  const mv = record(source, file, flags);
  const tl = mv.root;
  const from = intFlag(flags, 'from', 0);
  const to = Math.min(intFlag(flags, 'to', Math.min(tl.endPos, from + 200)), tl.endPos);
  let oi = 0;
  while (oi < tl.outputs.length && tl.outputs[oi].pos < from) oi++;
  const writes = new Map<number, string[]>();
  for (const w of tl.writes) {
    if (w.kind === 'mut' || w.pos < from || w.pos >= to) continue;
    const v = typeof w.value === 'object' && w.value !== null ? '…' : JSON.stringify(w.value) ?? 'nil';
    writes.set(w.pos, [...(writes.get(w.pos) ?? []), `${w.name}=${v}`]);
  }
  for (let p = from; p < to; p++) {
    const ln = tl.lines[p];
    const depth = tl.depths[p];
    const indent = c.dim('│ '.repeat(Math.max(0, depth - 1)));
    const w = writes.get(p);
    console.log(
      `${c.dim('#' + String(p).padStart(5))} ${c.blue('L' + String(ln).padEnd(4))} ${indent}${lines[ln - 1]?.trim() ?? ''}${w ? '  ' + c.cyan(w.join(' ')) : ''}`,
    );
    while (oi < tl.outputs.length && tl.outputs[oi].pos === p) {
      console.log(`${' '.repeat(13)}${indent}${c.gold('» ' + tl.outputs[oi].text)}`);
      oi++;
    }
  }
  if (to < tl.endPos) console.log(c.dim(`… ${tl.endPos - to} more steps (use --from / --to)`));
  else describeEnd(tl, source, file);
  return 0;
}

function cmdHeat(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  const mv = record(source, file, flags);
  const hits = mv.root.lineHits();
  const max = Math.max(1, ...hits.values());
  const width = 18;
  source.split('\n').forEach((text, i) => {
    const n = hits.get(i + 1) ?? 0;
    const bar = n ? '█'.repeat(Math.max(1, Math.round((Math.log(1 + n) / Math.log(1 + max)) * width))) : '';
    const colored = n === 0 ? '' : n / max > 0.5 ? c.red(bar) : n / max > 0.1 ? c.gold(bar) : c.blue(bar);
    console.log(`${c.dim(String(i + 1).padStart(4))} ${String(n || '').padStart(7)} ${colored}${' '.repeat(width - bar.length)} ${text}`);
  });
  console.log(c.dim(`\n${mv.root.endPos.toLocaleString()} steps in ${mv.root.recordMs.toFixed(1)} ms`));
  return 0;
}

function cmdFork(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  const mv = record(source, file, flags);
  const root = mv.root;
  if (flags.at === undefined || flags.set === undefined) fail('fork needs --at <step> and --set <name>=<value>');
  const at = intFlag(flags, 'at', 0);
  const eq = flags.set.indexOf('=');
  if (eq < 1) fail('--set expects name=value, e.g. --set n=27');
  const name = flags.set.slice(0, eq).trim();
  const value = flags.set.slice(eq + 1);
  if (at >= root.endPos) fail(`--at must be below ${root.endPos} (the number of recorded steps)`);
  let alt: Timeline;
  try {
    const state = mv.stateAt(root, at);
    alt = mv.fork(root, at, state.frames.length - 1, name, value);
  } catch (e) {
    if (e instanceof LoomRuntimeError || e instanceof LoomSyntaxError) fail(e.message);
    throw e;
  }
  const lines = source.split('\n');
  console.log(`${c.pink('⑂ fork')} at step ${at} (line ${root.lines[at]}: ${c.dim(lines[root.lines[at] - 1]?.trim() ?? '')}) with ${c.bold(alt.label)}\n`);
  const show = (tl: Timeline, title: string) => {
    console.log(c.bold(title) + c.dim(`  ${tl.endPos} steps, ${tl.end.kind}`));
    const div = tl.divergence();
    tl.outputs.forEach((o, i) => console.log('  ' + (div !== null && i >= div ? c.pink(o.text) : o.text)));
    if (tl.end.kind === 'error') console.log('  ' + c.red(`✖ line ${tl.end.error.line}: ${tl.end.error.message}`));
    console.log();
  };
  show(root, 'T0 · original');
  show(alt, `T1 · ${alt.label}`);
  const div = alt.divergence();
  console.log(div === null ? c.green('Both timelines printed the same output.') : c.pink(`Timelines diverge at output line ${div + 1}.`));
  return 0;
}

function cmdDis(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  try {
    console.log(disassemble(compile(source), flags.all === 'true'));
  } catch (e) {
    if (e instanceof LoomSyntaxError) showSyntaxError(e, source, file);
    throw e;
  }
  return 0;
}

function cmdCheck(file: string): number {
  const source = readSource(file);
  const lines = source.split('\n');
  const diags = analyze(source);
  const colors = { error: c.red, warning: c.gold, info: c.blue };
  for (const d of diags) {
    console.log(`${colors[d.severity](d.severity)} ${c.dim(`${file}:${d.line}:${d.col}`)}  ${d.message}`);
    console.log(`  ${c.dim(String(d.line).padStart(4) + ' │')} ${lines[d.line - 1] ?? ''}`);
    const len = d.length < 0 ? Math.max(1, (lines[d.line - 1] ?? '').length - d.col + 1) : Math.max(1, d.length);
    console.log(`  ${' '.repeat(4)}${c.dim(' │')} ${' '.repeat(Math.max(0, d.col - 1))}${colors[d.severity]('~'.repeat(len))}`);
  }
  const errors = diags.filter((d) => d.severity === 'error').length;
  if (errors === 0) {
    const p = compile(source, { stdlib: false });
    const user = p.protos.filter((f) => !f.internal);
    const ops = user.reduce((n, f) => n + f.code.length, 0);
    const warn = diags.length ? ` · ${diags.length} warning${diags.length === 1 ? '' : 's'}` : '';
    console.log(`${c.green('ok')} ${basename(file)} · ${user.length} function${user.length === 1 ? '' : 's'} · ${ops} instructions${warn}`);
  }
  return errors ? 1 : 0;
}

function cmdQuery(file: string, expr: string | undefined, flags: Record<string, string>): number {
  if (!expr) fail('query needs an expression, e.g. loom query prog.loom "x > 10"');
  const source = readSource(file);
  const lines = source.split('\n');
  const mv = record(source, file, flags);
  const tl = mv.root;
  const { matches, error } = mv.query(tl, expr);
  if (error) fail(error);
  const limit = intFlag(flags, 'limit', 30);
  console.log(`${c.bold(String(matches.length))} step${matches.length === 1 ? '' : 's'} where ${c.cyan(expr)} ${c.dim(`(of ${tl.endPos + 1})`)}`);
  for (const p of matches.slice(0, limit)) {
    const ln = tl.lineAt(p);
    const src = p >= tl.endPos ? c.dim('(end of program)') : lines[ln - 1]?.trim() ?? '';
    console.log(`  ${c.dim('#' + String(p).padStart(5))} ${c.blue('L' + String(ln).padEnd(4))} ${src}`);
  }
  if (matches.length > limit) console.log(c.dim(`  … ${matches.length - limit} more (use --limit)`));
  return 0;
}

function cmdProfile(file: string, flags: Record<string, string>): number {
  const source = readSource(file);
  const mv = record(source, file, flags);
  const tl = mv.root;
  const rows = tl.profile(mv.vm).filter((r) => r.total > 0 || r.self > 0);
  const width = 24;
  console.log(c.dim(`${'function'.padEnd(18)} ${'calls'.padStart(8)} ${'self'.padStart(8)} ${'total'.padStart(8)}`));
  for (const r of rows) {
    const name = (r.name === '<main>' ? 'main' : r.name) + (r.internal ? c.dim(' (stdlib)') : '');
    const bar = '█'.repeat(Math.max(1, Math.round((r.total / Math.max(1, tl.endPos)) * width)));
    const pad = 18 + (name.length - (r.name === '<main>' ? 4 : r.name.length) - (r.internal ? 9 : 0));
    console.log(`${name.padEnd(pad)} ${String(r.calls).padStart(8)} ${String(r.self).padStart(8)} ${String(r.total).padStart(8)}  ${c.blue(bar)}`);
  }
  console.log(c.dim(`\n${tl.endPos.toLocaleString()} steps, ${tl.calls.length.toLocaleString()} calls, recorded in ${tl.recordMs.toFixed(1)} ms`));
  return 0;
}

// ---------------------------------------------------------------------- main

function main(argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  const [cmd, file] = positional;
  if (!cmd || flags.help) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case 'run':
      return cmdRun(file, flags);
    case 'trace':
      return cmdTrace(file, flags);
    case 'heat':
      return cmdHeat(file, flags);
    case 'fork':
      return cmdFork(file, flags);
    case 'dis':
      return cmdDis(file, flags);
    case 'query':
      return cmdQuery(file, positional[2], flags);
    case 'profile':
      return cmdProfile(file, flags);
    case 'check':
      return cmdCheck(file);
    default:
      // `loom file.loom` is shorthand for `loom run file.loom`
      if (cmd.endsWith('.loom')) return cmdRun(cmd, flags);
      fail(`unknown command '${cmd}' (see \`loom --help\`)`);
  }
}

process.exitCode = main(process.argv.slice(2));
