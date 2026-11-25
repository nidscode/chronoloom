/**
 * Static analysis for Loom: finds problems before the program runs.
 *
 *  - syntax errors (with position)
 *  - undefined variables, with "did you mean" suggestions
 *  - variables used before their declaration in the same scope
 *  - assignment to undeclared variables or builtins
 *  - unused variables and functions
 *  - duplicate declarations in one scope
 *  - unreachable code after return / break / continue / throw
 *  - calls with more arguments than the function accepts
 *
 * Scoping mirrors the VM exactly: blocks that declare names get their own
 * scope, function declarations are hoisted, and function bodies are analysed
 * after the scope that defines them is complete (because they run later and
 * may refer to names declared after the function itself).
 */

import type { Expr, Pos, Stmt } from './ast';
import { compile } from './compiler';
import { LoomSyntaxError } from './lexer';
import { parse } from './parser';
import { STDLIB_NAMES } from './stdlib';
import { BUILTIN_NAMES } from './vm';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  message: string;
  line: number;
  col: number;
  /** characters to underline; -1 means "to the end of the line" */
  length: number;
}

type DeclKind = 'let' | 'fn' | 'param' | 'loop' | 'catch';

interface Decl {
  name: string;
  kind: DeclKind;
  pos: Pos;
  used: boolean;
  params?: number;
}

class Scope {
  vars = new Map<string, Decl>();
  /** `let` names that appear in this block (declared or not yet) */
  pending = new Map<string, Pos>();
  constructor(readonly parent: Scope | null) {}
}

const BUILTINS = new Set<string>([...BUILTIN_NAMES, ...STDLIB_NAMES]);

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function analyze(source: string): Diagnostic[] {
  try {
    const ast = parse(source);
    // the compiler checks return/break placement
    compile(source, { stdlib: false });
    return new Analyzer().run(ast.body);
  } catch (e) {
    if (e instanceof LoomSyntaxError) {
      return [{ severity: 'error', message: e.message, line: e.line, col: e.col, length: 1 }];
    }
    throw e;
  }
}

class Analyzer {
  private diags: Diagnostic[] = [];
  private scopes: Scope[] = [];
  private queue: { scope: Scope; params: string[]; paramPos: Pos[]; body: Stmt[] }[] = [];

  run(body: Stmt[]): Diagnostic[] {
    const globals = this.scope(null);
    this.block(body, globals);
    while (this.queue.length) {
      const job = this.queue.shift()!;
      const fnScope = this.scope(job.scope);
      job.params.forEach((p, i) => this.declare(fnScope, p, 'param', job.paramPos[i]));
      this.block(job.body, fnScope);
    }
    this.reportUnused();
    return this.diags.sort((a, b) => a.line - b.line || a.col - b.col);
  }

  private scope(parent: Scope | null): Scope {
    const s = new Scope(parent);
    this.scopes.push(s);
    return s;
  }

  private report(severity: Severity, message: string, pos: Pos, length: number): void {
    this.diags.push({ severity, message, line: pos.line, col: pos.col, length });
  }

  private declare(scope: Scope, name: string, kind: DeclKind, pos: Pos, params?: number): void {
    const prev = scope.vars.get(name);
    if (prev && (kind === 'let' || kind === 'fn') && (prev.kind === 'let' || prev.kind === 'fn')) {
      this.report('warning', `'${name}' is already declared in this scope (line ${prev.pos.line})`, pos, name.length);
    }
    scope.vars.set(name, { name, kind, pos, used: false, params });
  }

  private lookup(scope: Scope, name: string): Decl | null {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const d = s.vars.get(name);
      if (d) return d;
    }
    return null;
  }

  private visibleNames(scope: Scope): string[] {
    const names = new Set<string>(BUILTINS);
    for (let s: Scope | null = scope; s; s = s.parent) for (const k of s.vars.keys()) names.add(k);
    return [...names];
  }

  private suggest(scope: Scope, name: string): string {
    let best: string | null = null;
    let bestDist = Math.max(2, Math.floor(name.length / 3)) + 1;
    for (const c of this.visibleNames(scope)) {
      const d = distance(name, c);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best ? `. Did you mean '${best}'?` : '';
  }

  private unresolved(scope: Scope, name: string, pos: Pos, writing: boolean): void {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const later = s.pending.get(name);
      if (later) {
        this.report('error', `'${name}' is used before its declaration on line ${later.line}`, pos, name.length);
        return;
      }
    }
    const msg = writing
      ? `'${name}' is not declared — use \`let ${name} = …\` first`
      : `'${name}' is not defined${this.suggest(scope, name)}`;
    this.report('error', msg, pos, name.length);
  }

  // ------------------------------------------------------------ statements

  private block(body: Stmt[], scope: Scope): void {
    for (const s of body) {
      if (s.kind === 'Let') scope.pending.set(s.name, s.namePos);
      if (s.kind === 'FnDecl') {
        this.declare(scope, s.name, 'fn', s.namePos, s.params.length);
        this.queue.push({ scope, params: s.params, paramPos: s.paramPos, body: s.body });
      }
    }
    let terminated = false;
    for (const s of body) {
      if (terminated && s.kind !== 'FnDecl') {
        this.report('warning', 'Unreachable code', s, -1);
        terminated = false; // report once per block
      }
      this.stmt(s, scope);
      if (s.kind === 'Return' || s.kind === 'Break' || s.kind === 'Continue' || s.kind === 'Throw') terminated = true;
    }
  }

  private stmt(s: Stmt, scope: Scope): void {
    switch (s.kind) {
      case 'Let':
        if (s.init) this.expr(s.init, scope);
        this.declare(scope, s.name, 'let', s.namePos);
        break;
      case 'Assign': {
        const t = s.target;
        if (t.kind === 'Ident') {
          const d = this.lookup(scope, t.name);
          if (!d) {
            if (BUILTINS.has(t.name)) this.report('error', `Cannot assign to builtin '${t.name}'`, t, t.name.length);
            else this.unresolved(scope, t.name, t, true);
          }
        } else {
          this.expr(t.object, scope);
          if (t.kind === 'Index') this.expr(t.index, scope);
        }
        this.expr(s.value, scope);
        break;
      }
      case 'ExprStmt':
        this.expr(s.expr, scope);
        break;
      case 'If':
        this.expr(s.cond, scope);
        this.block(s.then, this.scope(scope));
        if (s.else) this.block(s.else, this.scope(scope));
        break;
      case 'While':
        this.expr(s.cond, scope);
        this.block(s.body, this.scope(scope));
        break;
      case 'For': {
        this.expr(s.iter, scope);
        const inner = this.scope(scope);
        this.declare(inner, s.name, 'loop', s.namePos);
        this.block(s.body, inner);
        break;
      }
      case 'FnDecl':
        break; // hoisted in block()
      case 'Return':
        if (s.value) this.expr(s.value, scope);
        break;
      case 'Throw':
        this.expr(s.value, scope);
        break;
      case 'Try': {
        this.block(s.body, this.scope(scope));
        const handler = this.scope(scope);
        if (s.name && s.namePos) this.declare(handler, s.name, 'catch', s.namePos);
        this.block(s.handler, handler);
        break;
      }
      case 'Block':
        this.block(s.body, this.scope(scope));
        break;
      case 'Break':
      case 'Continue':
        break;
    }
  }

  // ----------------------------------------------------------- expressions

  private expr(e: Expr, scope: Scope): void {
    switch (e.kind) {
      case 'Ident': {
        const d = this.lookup(scope, e.name);
        if (d) d.used = true;
        else if (!BUILTINS.has(e.name)) this.unresolved(scope, e.name, e, false);
        break;
      }
      case 'Template':
        for (const p of e.parts) if (typeof p !== 'string') this.expr(p, scope);
        break;
      case 'Array':
        e.items.forEach((x) => this.expr(x, scope));
        break;
      case 'Record':
        e.entries.forEach((x) => this.expr(x.value, scope));
        break;
      case 'Unary':
        this.expr(e.operand, scope);
        break;
      case 'Binary':
      case 'Logical':
        this.expr(e.left, scope);
        this.expr(e.right, scope);
        break;
      case 'Range':
        this.expr(e.from, scope);
        this.expr(e.to, scope);
        break;
      case 'Call': {
        if (e.callee.kind === 'Ident') {
          const d = this.lookup(scope, e.callee.name);
          if (d?.kind === 'fn' && d.params !== undefined && e.args.length > d.params) {
            this.report(
              'error',
              `${e.callee.name}() takes ${d.params} argument${d.params === 1 ? '' : 's'} but is given ${e.args.length}`,
              e.callee,
              e.callee.name.length,
            );
          }
        }
        this.expr(e.callee, scope);
        e.args.forEach((a) => this.expr(a, scope));
        break;
      }
      case 'Index':
        this.expr(e.object, scope);
        this.expr(e.index, scope);
        break;
      case 'Member':
        this.expr(e.object, scope);
        break;
      case 'Func':
        this.queue.push({ scope, params: e.params, paramPos: e.paramPos, body: e.body });
        break;
      case 'Num':
      case 'Str':
      case 'Bool':
      case 'Nil':
        break;
    }
  }

  private reportUnused(): void {
    for (const scope of this.scopes) {
      for (const d of scope.vars.values()) {
        if (d.used || d.name.startsWith('_')) continue;
        if (d.kind === 'let') this.report('warning', `'${d.name}' is never read`, d.pos, d.name.length);
        else if (d.kind === 'fn') this.report('info', `Function '${d.name}' is never called`, d.pos, d.name.length);
      }
    }
  }
}
