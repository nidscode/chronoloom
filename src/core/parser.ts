/**
 * Recursive-descent parser for Loom.
 *
 * Grammar sketch (statements need no semicolons):
 *
 *   program   := stmt*
 *   stmt      := let | fnDecl | if | while | for | return | break | continue
 *              | try | throw | block | exprOrAssign
 *   let       := 'let' IDENT ('=' expr)?
 *   fnDecl    := 'fn' IDENT '(' params ')' (block | '=>' expr)
 *   if        := 'if' expr block ('else' (if | block))?
 *   while     := 'while' expr block
 *   for       := 'for' IDENT 'in' expr block
 *   try       := 'try' block 'catch' IDENT? block
 *   throw     := 'throw' expr
 *   expr      := or
 *   or        := and ('or' and)*
 *   and       := equality ('and' equality)*
 *   equality  := compare (('==' | '!=') compare)*
 *   compare   := range (('<' | '<=' | '>' | '>=') range)*
 *   range     := term ('..' term)?
 *   term      := factor (('+' | '-') factor)*
 *   factor    := unary (('*' | '/' | '%') unary)*
 *   unary     := ('-' | 'not') unary | postfix
 *   postfix   := primary ( '(' args ')' | '[' expr ']' | '.' IDENT )*
 *   primary   := NUMBER | STRING | TEMPLATE | IDENT | true | false | nil
 *              | '(' expr ')' | '[' items ']' | '{' fields '}'
 *              | 'fn' '(' params ')' (block | '=>' expr)
 */

import type { AssignTarget, BinaryOp, Expr, Pos, ProgramAst, Stmt } from './ast';
import { LoomSyntaxError, tokenize, type Token } from './lexer';

export function parse(source: string): ProgramAst {
  return new Parser(tokenize(source)).parseProgram();
}

/** Parse a single standalone expression (watch expressions, console, injected values). */
export function parseExpression(source: string): Expr {
  const p = new Parser(tokenize(source));
  const expr = p.expression();
  p.expectEnd();
  return expr;
}

class Parser {
  private i = 0;

  constructor(private tokens: Token[]) {}

  // ---------------------------------------------------------------- helpers

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.tokens[this.i];
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private check(value: string): boolean {
    const t = this.peek();
    return (t.type === 'punct' || t.type === 'keyword') && t.value === value;
  }

  private match(value: string): boolean {
    if (this.check(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private found(t: Token): string {
    return t.type === 'eof' ? 'end of file' : `'${t.type === 'template' ? 'string' : t.value}'`;
  }

  private expect(value: string, context?: string): Token {
    if (this.check(value)) return this.next();
    const t = this.peek();
    throw new LoomSyntaxError(`Expected '${value}'${context ? ` ${context}` : ''} but found ${this.found(t)}`, t.line, t.col);
  }

  private expectIdent(what: string): Token {
    const t = this.peek();
    if (t.type === 'ident') return this.next();
    const hint = t.type === 'keyword' ? ` ('${t.value}' is a reserved word)` : '';
    throw new LoomSyntaxError(`Expected ${what} but found ${this.found(t)}${hint}`, t.line, t.col);
  }

  private error(message: string, t: Token = this.peek()): never {
    throw new LoomSyntaxError(message, t.line, t.col);
  }

  expectEnd(): void {
    if (this.peek().type !== 'eof') this.error(`Unexpected ${this.found(this.peek())}`);
  }

  // ------------------------------------------------------------- statements

  parseProgram(): ProgramAst {
    const body: Stmt[] = [];
    while (this.peek().type !== 'eof') body.push(this.statement());
    return { body };
  }

  private block(context: string): Stmt[] {
    this.expect('{', context);
    const body: Stmt[] = [];
    while (!this.check('}')) {
      if (this.peek().type === 'eof') this.error(`Unclosed block — expected '}' ${context}`);
      body.push(this.statement());
    }
    this.expect('}');
    return body;
  }

  /** Function body: either a block or `=> expression`. */
  private fnBody(name: string, at: Pos): Stmt[] {
    if (this.check('=>')) {
      this.next();
      const value = this.expression();
      return [{ kind: 'Return', value, line: value.line, col: value.col }];
    }
    void at;
    return this.block(`to start the body of function '${name}'`);
  }

  private statement(): Stmt {
    const t = this.peek();
    const pos = { line: t.line, col: t.col };
    let stmt: Stmt;

    if (t.type === 'keyword') {
      switch (t.value) {
        case 'let': {
          this.next();
          const nt = this.expectIdent('a variable name after `let`');
          const init = this.match('=') ? this.expression() : null;
          stmt = { kind: 'Let', name: nt.value, namePos: { line: nt.line, col: nt.col }, init, ...pos };
          break;
        }
        case 'fn': {
          // `fn name(...)` is a declaration; `fn(...)` is an expression statement
          if (this.peek(1).type === 'ident') {
            this.next();
            const nt = this.next();
            const { params, paramPos } = this.params();
            const body = this.fnBody(nt.value, pos);
            stmt = { kind: 'FnDecl', name: nt.value, namePos: { line: nt.line, col: nt.col }, params, paramPos, body, ...pos };
          } else {
            stmt = this.exprOrAssign();
          }
          break;
        }
        case 'if':
          stmt = this.ifStatement();
          break;
        case 'while': {
          this.next();
          const cond = this.expression();
          const body = this.block('after the while condition');
          stmt = { kind: 'While', cond, body, ...pos };
          break;
        }
        case 'for': {
          this.next();
          const nt = this.expectIdent('a loop variable after `for`');
          this.expect('in', 'after the loop variable');
          const iter = this.expression();
          const body = this.block('after the for header');
          stmt = { kind: 'For', name: nt.value, namePos: { line: nt.line, col: nt.col }, iter, body, ...pos };
          break;
        }
        case 'return': {
          this.next();
          const nt = this.peek();
          const value = nt.nl || nt.type === 'eof' || this.check('}') || this.check(';') ? null : this.expression();
          stmt = { kind: 'Return', value, ...pos };
          break;
        }
        case 'throw': {
          this.next();
          if (this.peek().nl || this.peek().type === 'eof') this.error('Expected a value after `throw`');
          stmt = { kind: 'Throw', value: this.expression(), ...pos };
          break;
        }
        case 'try': {
          this.next();
          const body = this.block('after `try`');
          this.expect('catch', 'after the try block');
          let name: string | null = null;
          let namePos: Pos | null = null;
          if (this.peek().type === 'ident') {
            const nt = this.next();
            name = nt.value;
            namePos = { line: nt.line, col: nt.col };
          }
          const handler = this.block('after `catch`');
          stmt = { kind: 'Try', body, name, namePos, handler, ...pos };
          break;
        }
        case 'break':
          this.next();
          stmt = { kind: 'Break', ...pos };
          break;
        case 'continue':
          this.next();
          stmt = { kind: 'Continue', ...pos };
          break;
        default:
          stmt = this.exprOrAssign();
      }
    } else if (this.check('{')) {
      stmt = { kind: 'Block', body: this.block(''), ...pos };
    } else {
      stmt = this.exprOrAssign();
    }

    // optional semicolon; otherwise the next statement must start on a new line
    if (!this.match(';')) {
      const nt = this.peek();
      const prev = this.tokens[this.i - 1];
      const endedWithBlock = prev?.type === 'punct' && prev.value === '}';
      if (!nt.nl && nt.type !== 'eof' && !this.check('}') && !endedWithBlock) {
        this.error(`Unexpected ${this.found(nt)} — put separate statements on separate lines or use ';'`);
      }
    }
    return stmt;
  }

  private ifStatement(): Stmt {
    const t = this.expect('if');
    const cond = this.expression();
    const then = this.block('after the if condition');
    let elseBody: Stmt[] | null = null;
    if (this.match('else')) {
      elseBody = this.check('if') ? [this.ifStatement()] : this.block('after else');
    }
    return { kind: 'If', cond, then, else: elseBody, line: t.line, col: t.col };
  }

  private exprOrAssign(): Stmt {
    const t = this.peek();
    const expr = this.expression();
    const opTok = this.peek();
    if (opTok.type === 'punct' && ['=', '+=', '-=', '*=', '/=', '%='].includes(opTok.value)) {
      if (expr.kind !== 'Ident' && expr.kind !== 'Index' && expr.kind !== 'Member') {
        this.error('Invalid assignment target', opTok);
      }
      this.next();
      const value = this.expression();
      return { kind: 'Assign', target: expr as AssignTarget, op: opTok.value as '=', value, line: t.line, col: t.col };
    }
    return { kind: 'ExprStmt', expr, line: t.line, col: t.col };
  }

  private params(): { params: string[]; paramPos: Pos[] } {
    this.expect('(', 'to start the parameter list');
    const params: string[] = [];
    const paramPos: Pos[] = [];
    if (!this.check(')')) {
      do {
        const p = this.expectIdent('a parameter name');
        if (params.includes(p.value)) this.error(`Duplicate parameter '${p.value}'`, p);
        params.push(p.value);
        paramPos.push({ line: p.line, col: p.col });
      } while (this.match(','));
    }
    this.expect(')', 'to close the parameter list');
    return { params, paramPos };
  }

  // ------------------------------------------------------------ expressions

  expression(): Expr {
    return this.or();
  }

  private or(): Expr {
    let left = this.and();
    while (this.check('or')) {
      const t = this.next();
      left = { kind: 'Logical', op: 'or', left, right: this.and(), line: t.line, col: t.col };
    }
    return left;
  }

  private and(): Expr {
    let left = this.equality();
    while (this.check('and')) {
      const t = this.next();
      left = { kind: 'Logical', op: 'and', left, right: this.equality(), line: t.line, col: t.col };
    }
    return left;
  }

  private binaryLevel(ops: string[], nextLevel: () => Expr): Expr {
    let left = nextLevel();
    while (true) {
      const t = this.peek();
      if (t.type === 'punct' && ops.includes(t.value)) {
        this.next();
        const right = nextLevel();
        left = { kind: 'Binary', op: t.value as BinaryOp, left, right, line: t.line, col: t.col };
      } else {
        return left;
      }
    }
  }

  private equality(): Expr {
    return this.binaryLevel(['==', '!='], () => this.compare());
  }

  private compare(): Expr {
    return this.binaryLevel(['<', '<=', '>', '>='], () => this.range());
  }

  private range(): Expr {
    const from = this.term();
    if (this.check('..')) {
      const t = this.next();
      const to = this.term();
      return { kind: 'Range', from, to, line: t.line, col: t.col };
    }
    return from;
  }

  private term(): Expr {
    return this.binaryLevel(['+', '-'], () => this.factor());
  }

  private factor(): Expr {
    return this.binaryLevel(['*', '/', '%'], () => this.unary());
  }

  private unary(): Expr {
    const t = this.peek();
    if (this.check('-') || this.check('not')) {
      this.next();
      const operand = this.unary();
      if (t.value === '-' && operand.kind === 'Num') {
        return { kind: 'Num', value: -operand.value, line: t.line, col: t.col };
      }
      return { kind: 'Unary', op: t.value as '-' | 'not', operand, line: t.line, col: t.col };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    while (true) {
      const t = this.peek();
      // A '(' or '[' on a new line starts a new statement, not a call/index.
      if (this.check('(') && !t.nl) {
        this.next();
        const args: Expr[] = [];
        if (!this.check(')')) {
          do {
            if (this.check(')')) break; // trailing comma
            args.push(this.expression());
          } while (this.match(','));
        }
        this.expect(')', 'to close the argument list');
        expr = { kind: 'Call', callee: expr, args, line: t.line, col: t.col };
      } else if (this.check('[') && !t.nl) {
        this.next();
        const index = this.expression();
        this.expect(']', 'to close the index');
        expr = { kind: 'Index', object: expr, index, line: t.line, col: t.col };
      } else if (this.check('.')) {
        this.next();
        const name = this.peek();
        if (name.type !== 'ident' && name.type !== 'keyword') this.error('Expected a field name after "."');
        this.next();
        expr = { kind: 'Member', object: expr, name: name.value, line: t.line, col: t.col };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const t = this.peek();
    const pos = { line: t.line, col: t.col };

    if (t.type === 'number') {
      this.next();
      return { kind: 'Num', value: Number(t.value), ...pos };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'Str', value: t.value, ...pos };
    }
    if (t.type === 'template') {
      this.next();
      const parts = t.parts!.map((p) => {
        if (typeof p === 'string') return p;
        const sub = new Parser(tokenize(p.src, { line: p.line, col: p.col }));
        const e = sub.expression();
        sub.expectEnd();
        return e;
      });
      return { kind: 'Template', parts, ...pos };
    }
    if (t.type === 'ident') {
      this.next();
      return { kind: 'Ident', name: t.value, ...pos };
    }
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'true':
          this.next();
          return { kind: 'Bool', value: true, ...pos };
        case 'false':
          this.next();
          return { kind: 'Bool', value: false, ...pos };
        case 'nil':
          this.next();
          return { kind: 'Nil', ...pos };
        case 'fn': {
          this.next();
          const { params, paramPos } = this.params();
          const body = this.fnBody('<anonymous>', pos);
          return { kind: 'Func', name: null, params, paramPos, body, ...pos };
        }
      }
    }
    if (this.match('(')) {
      const e = this.expression();
      this.expect(')', 'to close the parenthesis');
      return e;
    }
    if (this.match('[')) {
      const items: Expr[] = [];
      while (!this.check(']')) {
        items.push(this.expression());
        if (!this.match(',')) break;
      }
      this.expect(']', 'to close the array');
      return { kind: 'Array', items, ...pos };
    }
    if (this.match('{')) {
      const entries: { key: string; value: Expr }[] = [];
      while (!this.check('}')) {
        const k = this.peek();
        let key: string;
        if (k.type === 'ident' || k.type === 'string' || k.type === 'keyword') key = k.value;
        else this.error('Expected a field name in record');
        this.next();
        this.expect(':', `after field name '${key}'`);
        entries.push({ key, value: this.expression() });
        if (!this.match(',')) break;
      }
      this.expect('}', 'to close the record');
      return { kind: 'Record', entries, ...pos };
    }

    if (t.type === 'eof') this.error('Unexpected end of file');
    this.error(`Unexpected ${this.found(t)}`);
  }
}
