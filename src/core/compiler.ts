/**
 * Compiles a Loom AST into stack-machine bytecode.
 *
 * The important design constraint is time travel: every statement begins
 * with a `LINE` instruction. The VM treats each executed `LINE` as one tick
 * of the timeline, which is what the debugger scrubs through.
 *
 * "Internal" code (the standard library and console expressions) is compiled
 * without LINE instructions and with line number 0, so it runs inside
 * whichever user statement called it and never appears on the timeline.
 */

import type { Expr, ProgramAst, Stmt } from './ast';
import type { CompiledProgram, FnProto, Instr, Op } from './bytecode';
import { LoomSyntaxError } from './lexer';
import { parse, parseExpression } from './parser';
import { STDLIB_SOURCE } from './stdlib';

interface LoopCtx {
  scopeDepth: number;
  tryDepth: number;
  breaks: number[];
  continues: number[];
}

interface FnCtx {
  proto: FnProto;
  scopeDepth: number;
  tryDepth: number;
  loops: LoopCtx[];
  isMain: boolean;
  internal: boolean;
}

export interface CompileOptions {
  /** include the standard library (default true) */
  stdlib?: boolean;
}

let stdlibAst: ProgramAst | null = null;

export function compile(source: string, opts: CompileOptions = {}): CompiledProgram {
  const ast = parse(source);
  const c = new Compiler(source);
  let prelude = -1;
  if (opts.stdlib !== false) {
    stdlibAst ??= parse(STDLIB_SOURCE);
    prelude = c.compileScript(stdlibAst, '<stdlib>', true);
  }
  const main = c.compileScript(ast, '<main>', false);
  return { source, protos: c.protos, main, prelude };
}

/**
 * Compile a standalone expression (for the time-travel console) as an extra
 * internal function appended to an existing program. Returns the extended
 * program and the index of the new function.
 */
export function compileExpressionInto(program: CompiledProgram, source: string): { program: CompiledProgram; entry: number } {
  const expr = parseExpression(source);
  const c = new Compiler(program.source);
  c.protos = [...program.protos];
  const entry = c.compileExpressionProto(expr);
  return { program: { ...program, protos: c.protos }, entry };
}

function declaresNames(body: Stmt[]): boolean {
  return body.some((s) => s.kind === 'Let' || s.kind === 'FnDecl');
}

function maxLine(node: unknown, acc = 0): number {
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (typeof n.line === 'number' && n.line > acc) acc = n.line;
    for (const k in n) {
      const v = n[k];
      if (v && typeof v === 'object') acc = maxLine(v, acc);
    }
  }
  return acc;
}

class Compiler {
  protos: FnProto[] = [];
  private ctx!: FnCtx;
  private hiddenCounter = 0;

  constructor(private source: string) {}

  compileScript(ast: ProgramAst, name: string, internal: boolean): number {
    const proto: FnProto = {
      name,
      params: [],
      code: [],
      startLine: internal ? 0 : 1,
      endLine: internal ? 0 : this.source.split('\n').length,
      ...(internal ? { internal: true } : {}),
    };
    const index = this.protos.push(proto) - 1;
    this.ctx = { proto, scopeDepth: 0, tryDepth: 0, loops: [], isMain: true, internal };
    this.statements(ast.body);
    const lastLine = maxLine(ast.body) || 1;
    this.emit('NIL', undefined, lastLine);
    this.emit('RETURN', undefined, lastLine);
    return index;
  }

  compileExpressionProto(expr: Expr): number {
    const proto: FnProto = { name: '<console>', params: [], code: [], startLine: 0, endLine: 0, internal: true };
    const index = this.protos.push(proto) - 1;
    this.ctx = { proto, scopeDepth: 0, tryDepth: 0, loops: [], isMain: false, internal: true };
    this.expr(expr);
    this.emit('RETURN', undefined, 0);
    return index;
  }

  // ------------------------------------------------------------- emission

  private emit(op: Op, a: any, line: number): number {
    const code = this.ctx.proto.code;
    const l = this.ctx.internal ? 0 : line;
    code.push(a === undefined ? { op, line: l } : { op, a, line: l });
    return code.length - 1;
  }

  private line(line: number): void {
    if (!this.ctx.internal) this.emit('LINE', line, line);
  }

  private here(): number {
    return this.ctx.proto.code.length;
  }

  private patch(at: number, target = this.here()): void {
    (this.ctx.proto.code[at] as Instr).a = target;
  }

  private hidden(base: string): string {
    return `$${base}${++this.hiddenCounter}`;
  }

  // ----------------------------------------------------------- statements

  /** Compile a list of statements, hoisting function declarations. */
  private statements(body: Stmt[]): void {
    for (const s of body) {
      if (s.kind === 'FnDecl') {
        this.emit('CLOSURE', this.functionProto(s.name, s.params, s.body, s.line), s.line);
        this.emit('DEFINE', s.name, s.line);
      }
    }
    for (const s of body) {
      if (s.kind !== 'FnDecl') this.statement(s);
    }
  }

  private scopedBlock(body: Stmt[], line: number): void {
    if (declaresNames(body)) {
      this.emit('PUSH_SCOPE', undefined, line);
      this.ctx.scopeDepth++;
      this.statements(body);
      this.ctx.scopeDepth--;
      this.emit('POP_SCOPE', undefined, line);
    } else {
      this.statements(body);
    }
  }

  private statement(s: Stmt): void {
    // Loops emit their own LINE at the top of every iteration.
    if (s.kind !== 'While' && s.kind !== 'For' && s.kind !== 'Block' && s.kind !== 'Try') {
      this.line(s.line);
    }

    switch (s.kind) {
      case 'Let':
        if (s.init) this.expr(s.init);
        else this.emit('NIL', undefined, s.line);
        this.emit('DEFINE', s.name, s.line);
        break;

      case 'Assign':
        this.assign(s);
        break;

      case 'ExprStmt':
        this.expr(s.expr);
        this.emit('POP', undefined, s.line);
        break;

      case 'Block':
        this.scopedBlock(s.body, s.line);
        break;

      case 'If': {
        this.expr(s.cond);
        const toElse = this.emit('JUMP_IF_FALSE', -1, s.line);
        this.scopedBlock(s.then, s.line);
        if (s.else) {
          const toEnd = this.emit('JUMP', -1, s.line);
          this.patch(toElse);
          this.scopedBlock(s.else, s.line);
          this.patch(toEnd);
        } else {
          this.patch(toElse);
        }
        break;
      }

      case 'While': {
        const top = this.here();
        this.line(s.line);
        this.expr(s.cond);
        const exit = this.emit('JUMP_IF_FALSE', -1, s.line);
        const loop = this.pushLoop();
        this.scopedBlock(s.body, s.line);
        this.ctx.loops.pop();
        for (const c of loop.continues) this.patch(c, top);
        this.emit('JUMP', top, s.line);
        this.patch(exit);
        for (const b of loop.breaks) this.patch(b);
        break;
      }

      case 'For':
        this.forLoop(s);
        break;

      case 'FnDecl':
        // hoisted in statements()
        break;

      case 'Return':
        if (this.ctx.isMain) {
          throw new LoomSyntaxError('`return` is only allowed inside a function', s.line, s.col);
        }
        if (s.value) this.expr(s.value);
        else this.emit('NIL', undefined, s.line);
        this.emit('RETURN', undefined, s.line);
        break;

      case 'Throw':
        this.expr(s.value);
        this.emit('THROW', undefined, s.line);
        break;

      case 'Try': {
        // TRY installs a handler that remembers the stack height and scope.
        const install = this.emit('TRY', -1, s.line);
        this.ctx.tryDepth++;
        this.scopedBlock(s.body, s.line);
        this.ctx.tryDepth--;
        this.emit('END_TRY', undefined, s.line);
        const toEnd = this.emit('JUMP', -1, s.line);
        // handler: the thrown value is on the stack
        this.patch(install);
        this.emit('PUSH_SCOPE', undefined, s.line);
        this.ctx.scopeDepth++;
        if (s.name) this.emit('DEFINE', s.name, s.line);
        else this.emit('POP', undefined, s.line);
        this.statements(s.handler);
        this.ctx.scopeDepth--;
        this.emit('POP_SCOPE', undefined, s.line);
        this.patch(toEnd);
        break;
      }

      case 'Break':
      case 'Continue': {
        const loop = this.ctx.loops[this.ctx.loops.length - 1];
        if (!loop) {
          throw new LoomSyntaxError(`\`${s.kind.toLowerCase()}\` used outside of a loop`, s.line, s.col);
        }
        for (let d = this.ctx.tryDepth; d > loop.tryDepth; d--) this.emit('END_TRY', undefined, s.line);
        for (let d = this.ctx.scopeDepth; d > loop.scopeDepth; d--) this.emit('POP_SCOPE', undefined, s.line);
        const j = this.emit('JUMP', -1, s.line);
        (s.kind === 'Break' ? loop.breaks : loop.continues).push(j);
        break;
      }
    }
  }

  private pushLoop(): LoopCtx {
    const loop: LoopCtx = { scopeDepth: this.ctx.scopeDepth, tryDepth: this.ctx.tryDepth, breaks: [], continues: [] };
    this.ctx.loops.push(loop);
    return loop;
  }

  /**
   * for x in iterable { body }
   *
   * Compiles to a counter loop over hidden variables:
   *   { let $it = ITERABLE(iterable); let $k = 0
   *     top: LINE; if not ($k < len($it)) goto exit
   *       { let x = $it[$k]; body }
   *     cont: $k = $k + 1; goto top
   *   exit: }
   *
   * Ranges (`for i in a..b`) skip materialising the array.
   */
  private forLoop(s: Extract<Stmt, { kind: 'For' }>): void {
    const line = s.line;
    const isRange = s.iter.kind === 'Range';
    const k = this.hidden('k');
    const end = this.hidden(isRange ? 'end' : 'it');

    this.emit('PUSH_SCOPE', undefined, line);
    this.ctx.scopeDepth++;

    if (s.iter.kind === 'Range') {
      this.expr(s.iter.from);
      this.emit('DEFINE', k, line);
      this.expr(s.iter.to);
      this.emit('DEFINE', end, line);
    } else {
      this.expr(s.iter);
      this.emit('ITERABLE', undefined, line);
      this.emit('DEFINE', end, line);
      this.emit('CONST', 0, line);
      this.emit('DEFINE', k, line);
    }

    const top = this.here();
    this.line(line);
    this.emit('GET', k, line);
    this.emit('GET', end, line);
    if (!isRange) this.emit('LEN', undefined, line);
    this.emit('BINARY', '<', line);
    const exit = this.emit('JUMP_IF_FALSE', -1, line);

    const loop = this.pushLoop();

    // per-iteration scope so closures capture a fresh loop variable
    this.emit('PUSH_SCOPE', undefined, line);
    this.ctx.scopeDepth++;
    if (isRange) {
      this.emit('GET', k, line);
    } else {
      this.emit('GET', end, line);
      this.emit('GET', k, line);
      this.emit('GET_INDEX', undefined, line);
    }
    this.emit('DEFINE', s.name, line);
    this.statements(s.body);
    this.ctx.scopeDepth--;
    this.emit('POP_SCOPE', undefined, line);

    this.ctx.loops.pop();
    for (const c of loop.continues) this.patch(c);
    this.emit('GET', k, line);
    this.emit('CONST', 1, line);
    this.emit('BINARY', '+', line);
    this.emit('SET', k, line);
    this.emit('JUMP', top, line);

    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
    this.ctx.scopeDepth--;
    this.emit('POP_SCOPE', undefined, line);
  }

  private assign(s: Extract<Stmt, { kind: 'Assign' }>): void {
    const line = s.line;
    const binop = s.op === '=' ? null : s.op[0];
    const t = s.target;

    if (t.kind === 'Ident') {
      if (binop) this.emit('GET', t.name, line);
      this.expr(s.value);
      if (binop) this.emit('BINARY', binop, line);
      this.emit('SET', t.name, line);
    } else if (t.kind === 'Index') {
      this.expr(t.object);
      this.expr(t.index);
      if (binop) {
        this.emit('DUP2', undefined, line);
        this.emit('GET_INDEX', undefined, line);
      }
      this.expr(s.value);
      if (binop) this.emit('BINARY', binop, line);
      this.emit('SET_INDEX', undefined, line);
    } else {
      this.expr(t.object);
      if (binop) {
        this.emit('DUP', undefined, line);
        this.emit('GET_FIELD', t.name, line);
      }
      this.expr(s.value);
      if (binop) this.emit('BINARY', binop, line);
      this.emit('SET_FIELD', t.name, line);
    }
  }

  private functionProto(name: string, params: string[], body: Stmt[], line: number): number {
    const internal = this.ctx.internal;
    const proto: FnProto = {
      name,
      params,
      code: [],
      startLine: internal ? 0 : line,
      endLine: internal ? 0 : Math.max(line, maxLine(body)),
      ...(internal ? { internal: true } : {}),
    };
    const index = this.protos.push(proto) - 1;
    const saved = this.ctx;
    this.ctx = { proto, scopeDepth: 0, tryDepth: 0, loops: [], isMain: false, internal };
    this.statements(body);
    this.emit('NIL', undefined, proto.endLine);
    this.emit('RETURN', undefined, proto.endLine);
    this.ctx = saved;
    return index;
  }

  // ---------------------------------------------------------- expressions

  private expr(e: Expr): void {
    const line = e.line;
    switch (e.kind) {
      case 'Num':
      case 'Str':
        this.emit('CONST', e.value, line);
        break;
      case 'Template':
        for (const p of e.parts) {
          if (typeof p === 'string') this.emit('CONST', p, line);
          else this.expr(p);
        }
        this.emit('CONCAT', e.parts.length, line);
        break;
      case 'Bool':
        this.emit(e.value ? 'TRUE' : 'FALSE', undefined, line);
        break;
      case 'Nil':
        this.emit('NIL', undefined, line);
        break;
      case 'Ident':
        this.emit('GET', e.name, line);
        break;
      case 'Array':
        for (const item of e.items) this.expr(item);
        this.emit('ARRAY', e.items.length, line);
        break;
      case 'Record':
        for (const entry of e.entries) this.expr(entry.value);
        this.emit(
          'RECORD',
          e.entries.map((x) => x.key),
          line,
        );
        break;
      case 'Unary':
        this.expr(e.operand);
        this.emit(e.op === '-' ? 'NEG' : 'NOT', undefined, line);
        break;
      case 'Binary':
        this.expr(e.left);
        this.expr(e.right);
        this.emit('BINARY', e.op, line);
        break;
      case 'Logical': {
        this.expr(e.left);
        const j = this.emit(e.op === 'and' ? 'JUMP_IF_FALSE_KEEP' : 'JUMP_IF_TRUE_KEEP', -1, line);
        this.emit('POP', undefined, line);
        this.expr(e.right);
        this.patch(j);
        break;
      }
      case 'Range':
        this.expr(e.from);
        this.expr(e.to);
        this.emit('RANGE', undefined, line);
        break;
      case 'Call':
        this.expr(e.callee);
        for (const a of e.args) this.expr(a);
        this.emit('CALL', e.args.length, line);
        break;
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        this.emit('GET_INDEX', undefined, line);
        break;
      case 'Member':
        this.expr(e.object);
        this.emit('GET_FIELD', e.name, line);
        break;
      case 'Func':
        this.emit('CLOSURE', this.functionProto(e.name ?? '<anonymous>', e.params, e.body, line), line);
        break;
    }
  }
}

/** Human-readable bytecode listing (standard-library code is skipped unless `all`). */
export function disassemble(program: CompiledProgram, all = false): string {
  const out: string[] = [];
  program.protos.forEach((p, idx) => {
    if (p.internal && !all) return;
    out.push(`== fn #${idx} ${p.name}(${p.params.join(', ')})${p.internal ? '  [stdlib]' : `  lines ${p.startLine}-${p.endLine}`} ==`);
    p.code.forEach((ins, ip) => {
      let arg = '';
      if (ins.a !== undefined) {
        arg = typeof ins.a === 'string' ? JSON.stringify(ins.a) : Array.isArray(ins.a) ? `[${ins.a.join(', ')}]` : String(ins.a);
        if (ins.op === 'CLOSURE') arg += `  (${program.protos[ins.a].name})`;
      }
      out.push(`  ${String(ip).padStart(4, '0')}  L${String(ins.line).padEnd(4)} ${ins.op.padEnd(18)} ${arg}`.trimEnd());
    });
    out.push('');
  });
  return out.join('\n');
}
