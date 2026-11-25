export { tokenize, LoomSyntaxError, KEYWORDS } from './lexer';
export type { Token } from './lexer';
export { parse, parseExpression } from './parser';
export { compile, compileExpressionInto, disassemble } from './compiler';
export { VM, LoomRuntimeError, BUILTIN_NAMES } from './vm';
export type { VMState, Frame, ScopeView, RuntimeErrorInfo } from './vm';
export { Multiverse, Timeline, Cursor } from './timeline';
export type {
  OutputLine,
  WriteRecord,
  TimelineEnd,
  MultiverseOptions,
  SeriesPoint,
  CallRecord,
  ProfileRow,
  BreakpointSpec,
  ConsoleResult,
} from './timeline';
export { evaluateReadOnly, tryEvaluate, parseWatch, EvalError } from './evaluate';
export { analyze } from './analyze';
export type { Diagnostic, Severity } from './analyze';
export { STDLIB_NAMES } from './stdlib';
export { formatValue, formatNumber, isRef, typeName } from './values';
export type { Value, HeapObj, Ref } from './values';

import { Multiverse, type MultiverseOptions } from './timeline';

/** Convenience: run a program and return its printed output and how it ended. */
export function run(source: string, opts?: MultiverseOptions) {
  const mv = new Multiverse(source, opts);
  const tl = mv.root;
  return {
    output: tl.outputs.map((o) => o.text),
    end: tl.end,
    steps: tl.lines.length,
    multiverse: mv,
  };
}
