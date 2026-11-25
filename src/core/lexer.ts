/**
 * Lexer for the Loom language.
 *
 * Produces a flat token stream. Newlines are not tokens; instead every token
 * records whether it was preceded by a line break (`nl`). The parser uses this
 * to avoid treating `(` or `[` at the start of a new line as a call / index on
 * the previous expression, which lets Loom stay semicolon-free.
 *
 * Double-quoted strings support interpolation: `"x = {x + 1}"`. Such strings
 * become a single `template` token whose `parts` alternate between literal
 * text and embedded expression source (with its position, so errors inside
 * an interpolation point at the right column).
 */

export type TokenType = 'number' | 'string' | 'template' | 'ident' | 'keyword' | 'punct' | 'eof';

export interface TemplateExpr {
  src: string;
  line: number;
  col: number;
}

export type TemplatePart = string | TemplateExpr;

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line */
  line: number;
  /** 1-based column */
  col: number;
  /** offset into source */
  start: number;
  end: number;
  /** true if a newline appeared between the previous token and this one */
  nl: boolean;
  /** for template tokens */
  parts?: TemplatePart[];
}

export const KEYWORDS = new Set([
  'let',
  'fn',
  'return',
  'if',
  'else',
  'while',
  'for',
  'in',
  'break',
  'continue',
  'true',
  'false',
  'nil',
  'and',
  'or',
  'not',
  'try',
  'catch',
  'throw',
]);

// Longest punctuators first so that greedy matching works.
const PUNCTUATORS = [
  '..',
  '==',
  '!=',
  '<=',
  '>=',
  '=>',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  ';',
  '.',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
];

export class LoomSyntaxError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(message);
    this.name = 'LoomSyntaxError';
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '{': '{',
  '}': '}',
};

/**
 * @param base position of the first character (used when lexing an
 *             expression embedded in a string interpolation)
 */
export function tokenize(source: string, base: { line: number; col: number } = { line: 1, col: 1 }): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = base.line;
  let lineStart = -(base.col - 1);
  let sawNewline = true;

  const push = (type: TokenType, value: string, start: number, parts?: TemplatePart[]) => {
    tokens.push({
      type,
      value,
      line,
      col: start - lineStart + 1,
      start,
      end: i,
      nl: sawNewline,
      ...(parts ? { parts } : {}),
    });
    sawNewline = false;
  };

  while (i < source.length) {
    const c = source[i];

    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      sawNewline = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    const start = i;

    // numbers: 12, 3.14, 1_000, 1e9
    if (isDigit(c)) {
      while (i < source.length && (isDigit(source[i]) || source[i] === '_')) i++;
      if (source[i] === '.' && isDigit(source[i + 1] ?? '')) {
        i++;
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const save = i;
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        if (isDigit(source[i] ?? '')) {
          while (i < source.length && isDigit(source[i])) i++;
        } else {
          i = save;
        }
      }
      push('number', source.slice(start, i).replace(/_/g, ''), start);
      continue;
    }

    if (isIdentStart(c)) {
      while (i < source.length && isIdentPart(source[i])) i++;
      const word = source.slice(start, i);
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', word, start);
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const interpolate = quote === '"';
      i++;
      let value = '';
      const parts: TemplatePart[] = [];
      while (true) {
        if (i >= source.length || source[i] === '\n') {
          throw new LoomSyntaxError('Unterminated string', line, start - lineStart + 1);
        }
        const ch = source[i];
        if (ch === quote) {
          i++;
          break;
        }
        if (ch === '\\') {
          const next = source[i + 1];
          if (next !== undefined && next in ESCAPES) {
            value += ESCAPES[next];
            i += 2;
            continue;
          }
          throw new LoomSyntaxError(`Unknown escape \\${next ?? ''}`, line, i - lineStart + 1);
        }
        if (ch === '{' && interpolate) {
          // find the matching '}' (skipping nested braces and strings)
          let depth = 1;
          let j = i + 1;
          while (j < source.length && depth > 0) {
            const cj = source[j];
            if (cj === '\n') break;
            if (cj === '"' || cj === "'") {
              j++;
              while (j < source.length && source[j] !== cj && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
            } else if (cj === '{') depth++;
            else if (cj === '}') depth--;
            if (depth > 0) j++;
          }
          if (depth !== 0) {
            throw new LoomSyntaxError("Unclosed '{' in string (use \\{ for a literal brace)", line, i - lineStart + 1);
          }
          const src = source.slice(i + 1, j);
          if (!src.trim()) throw new LoomSyntaxError('Empty {} in string', line, i - lineStart + 1);
          parts.push(value, { src, line, col: i + 1 - lineStart + 1 });
          value = '';
          i = j + 1;
          continue;
        }
        value += ch;
        i++;
      }
      if (parts.length) {
        parts.push(value);
        push('template', source.slice(start, i), start, parts);
      } else {
        push('string', value, start);
      }
      continue;
    }

    let matched: string | null = null;
    for (const p of PUNCTUATORS) {
      if (source.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      i += matched.length;
      push('punct', matched, start);
      continue;
    }

    if (c === '!') {
      throw new LoomSyntaxError("Unexpected '!'. Loom uses `not` for negation", line, i - lineStart + 1);
    }
    if (c === '&' || c === '|') {
      throw new LoomSyntaxError(`Unexpected '${c}'. Loom uses \`and\` / \`or\` for logic`, line, i - lineStart + 1);
    }
    throw new LoomSyntaxError(`Unexpected character '${c}'`, line, i - lineStart + 1);
  }

  tokens.push({
    type: 'eof',
    value: '',
    line,
    col: i - lineStart + 1,
    start: i,
    end: i,
    nl: true,
  });
  return tokens;
}
