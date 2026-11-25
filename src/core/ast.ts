/** AST node definitions for Loom. Every node carries its source position. */

export interface Pos {
  line: number;
  col: number;
}

export type Expr =
  | ({ kind: 'Num'; value: number } & Pos)
  | ({ kind: 'Str'; value: string } & Pos)
  | ({ kind: 'Template'; parts: (string | Expr)[] } & Pos)
  | ({ kind: 'Bool'; value: boolean } & Pos)
  | ({ kind: 'Nil' } & Pos)
  | ({ kind: 'Ident'; name: string } & Pos)
  | ({ kind: 'Array'; items: Expr[] } & Pos)
  | ({ kind: 'Record'; entries: { key: string; value: Expr }[] } & Pos)
  | ({ kind: 'Unary'; op: '-' | 'not'; operand: Expr } & Pos)
  | ({ kind: 'Binary'; op: BinaryOp; left: Expr; right: Expr } & Pos)
  | ({ kind: 'Logical'; op: 'and' | 'or'; left: Expr; right: Expr } & Pos)
  | ({ kind: 'Range'; from: Expr; to: Expr } & Pos)
  | ({ kind: 'Call'; callee: Expr; args: Expr[] } & Pos)
  | ({ kind: 'Index'; object: Expr; index: Expr } & Pos)
  | ({ kind: 'Member'; object: Expr; name: string } & Pos)
  | ({ kind: 'Func'; name: string | null; params: string[]; paramPos: Pos[]; body: Stmt[] } & Pos);

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type AssignTarget = Extract<Expr, { kind: 'Ident' | 'Index' | 'Member' }>;

export type Stmt =
  | ({ kind: 'Let'; name: string; namePos: Pos; init: Expr | null } & Pos)
  | ({ kind: 'Assign'; target: AssignTarget; op: '=' | '+=' | '-=' | '*=' | '/=' | '%='; value: Expr } & Pos)
  | ({ kind: 'ExprStmt'; expr: Expr } & Pos)
  | ({ kind: 'If'; cond: Expr; then: Stmt[]; else: Stmt[] | null } & Pos)
  | ({ kind: 'While'; cond: Expr; body: Stmt[] } & Pos)
  | ({ kind: 'For'; name: string; namePos: Pos; iter: Expr; body: Stmt[] } & Pos)
  | ({ kind: 'FnDecl'; name: string; namePos: Pos; params: string[]; paramPos: Pos[]; body: Stmt[] } & Pos)
  | ({ kind: 'Return'; value: Expr | null } & Pos)
  | ({ kind: 'Break' } & Pos)
  | ({ kind: 'Continue' } & Pos)
  | ({ kind: 'Throw'; value: Expr } & Pos)
  | ({ kind: 'Try'; body: Stmt[]; name: string | null; namePos: Pos | null; handler: Stmt[] } & Pos)
  | ({ kind: 'Block'; body: Stmt[] } & Pos);

export interface ProgramAst {
  body: Stmt[];
}
