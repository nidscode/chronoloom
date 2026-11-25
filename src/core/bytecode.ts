/** Bytecode definitions shared by the compiler, VM and disassembler. */

export type Op =
  | 'CONST' // a: constant value (number | string)
  | 'NIL'
  | 'TRUE'
  | 'FALSE'
  | 'POP'
  | 'DUP' // duplicate top of stack
  | 'DUP2' // duplicate top two stack entries
  | 'DEFINE' // a: name — pop value, define in current scope
  | 'GET' // a: name
  | 'SET' // a: name — pop value, assign to existing binding
  | 'GET_INDEX' // pop index, object; push object[index]
  | 'SET_INDEX' // pop value, index, object
  | 'GET_FIELD' // a: field name
  | 'SET_FIELD' // a: field name; pop value, object
  | 'ARRAY' // a: element count
  | 'RECORD' // a: string[] keys
  | 'RANGE' // pop to, from; push array
  | 'CONCAT' // a: part count — pop parts, push their concatenation (string interpolation)
  | 'BINARY' // a: operator
  | 'NEG'
  | 'NOT'
  | 'JUMP' // a: target ip
  | 'JUMP_IF_FALSE' // a: target ip (pops condition)
  | 'JUMP_IF_FALSE_KEEP' // a: target ip (keeps condition on stack when jumping)
  | 'JUMP_IF_TRUE_KEEP'
  | 'CALL' // a: argument count
  | 'RETURN'
  | 'CLOSURE' // a: function prototype index
  | 'PUSH_SCOPE'
  | 'POP_SCOPE'
  | 'ITERABLE' // convert top of stack into an array suitable for for-in
  | 'LEN' // pop array; push length
  | 'TRY' // a: handler ip — install an exception handler
  | 'END_TRY' // remove the innermost handler of this frame
  | 'THROW' // pop value and raise it
  | 'LINE'; // a: line — statement boundary, the unit of time travel

export interface Instr {
  op: Op;
  a?: any;
  line: number;
}

export interface FnProto {
  name: string;
  params: string[];
  code: Instr[];
  /** first and last source line of the function, for display */
  startLine: number;
  endLine: number;
  /** standard-library / console code: emits no LINE events and has line 0 */
  internal?: boolean;
}

export interface CompiledProgram {
  source: string;
  protos: FnProto[];
  /** index of the top-level script prototype */
  main: number;
  /** index of the standard library prototype, run once before main (-1 if none) */
  prelude: number;
}
