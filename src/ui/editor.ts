/**
 * CodeMirror 6 integration: Loom syntax highlighting, live diagnostics,
 * autocomplete, breakpoints, hover-to-inspect, and the debugger's
 * decorations (executing line, selected frame, errors, inline values and the
 * execution heat strip).
 */

import { autocompletion, completionKeymap, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  type StringStream,
} from '@codemirror/language';
import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { BUILTIN_NAMES, KEYWORDS, STDLIB_NAMES, type Diagnostic } from '../core';
import { BUILTIN_DOCS, KEYWORD_DOCS } from './docs';

const BUILTIN_SET = new Set([...BUILTIN_NAMES, ...STDLIB_NAMES]);

// ------------------------------------------------------------- language

const loomLanguage = StreamLanguage.define<{ afterFn: boolean }>({
  name: 'loom',
  startState: () => ({ afterFn: false }),
  token(stream: StringStream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/)) return 'number';
    const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      if (state.afterFn) {
        state.afterFn = false;
        return 'def';
      }
      if (w === 'true' || w === 'false' || w === 'nil') return 'atom';
      if (KEYWORDS.has(w)) {
        state.afterFn = w === 'fn';
        return 'keyword';
      }
      if (BUILTIN_SET.has(w)) return 'builtin';
      if (stream.match(/^\s*\(/, false)) return 'fncall';
      return 'variableName';
    }
    state.afterFn = false;
    if (stream.match(/^(\.\.|==|!=|<=|>=|=>|\+=|-=|\*=|\/=|%=|[+\-*/%<>=])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
  tokenTable: {
    builtin: t.standard(t.variableName),
    def: t.definition(t.function(t.variableName)),
    fncall: t.function(t.variableName),
  },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.operator, class: 'tok-op' },
  { tag: t.function(t.variableName), class: 'tok-fn' },
  { tag: t.definition(t.function(t.variableName)), class: 'tok-fn' },
  { tag: t.standard(t.variableName), class: 'tok-builtin' },
  { tag: t.variableName, class: 'tok-var' },
]);

// ---------------------------------------------------------- decorations

export interface ExecMarks {
  current: number | null;
  frame: number | null;
  error: number | null;
  inline: { line: number; text: string; error?: boolean } | null;
}

const setMarks = StateEffect.define<ExecMarks>();
const setHeat = StateEffect.define<{ hits: Map<number, number>; selected: number | null }>();
const flashLine = StateEffect.define<number>();

class InlineValues extends WidgetType {
  constructor(
    readonly text: string,
    readonly error: boolean,
  ) {
    super();
  }
  eq(other: InlineValues) {
    return other.text === this.text && other.error === this.error;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-inline-values' + (this.error ? ' err' : '');
    span.textContent = this.text;
    return span;
  }
}

function lineDeco(doc: EditorState['doc'], line: number | null, cls: string) {
  if (line === null || line < 1 || line > doc.lines) return null;
  return { from: doc.line(line).from, deco: Decoration.line({ class: cls }) };
}

const EMPTY_MARKS: ExecMarks = { current: null, frame: null, error: null, inline: null };

const marksField = StateField.define<{ marks: ExecMarks; decos: DecorationSet; flash: number | null }>({
  create: () => ({ marks: EMPTY_MARKS, decos: Decoration.none, flash: null }),
  update(value, tr) {
    let { marks, flash } = value;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setMarks)) {
        marks = e.value;
        changed = true;
      }
      if (e.is(flashLine)) {
        flash = e.value;
        changed = true;
      }
    }
    if (!changed && !tr.docChanged) return value;
    if (tr.docChanged && !changed) {
      // code was edited: the recording no longer matches, drop decorations
      return { marks: EMPTY_MARKS, decos: Decoration.none, flash: null };
    }
    const doc = tr.state.doc;
    const items: { from: number; deco: Decoration; order: number }[] = [];
    const push = (x: ReturnType<typeof lineDeco>, order: number) => x && items.push({ ...x, order });
    push(lineDeco(doc, marks.frame, 'cm-frame-line'), 0);
    push(lineDeco(doc, marks.error, 'cm-error-line'), 1);
    if (marks.current !== marks.error) push(lineDeco(doc, marks.current, 'cm-exec-line'), 2);
    if (flash !== null) push(lineDeco(doc, flash, 'cm-flash-line'), 3);
    if (marks.inline && marks.inline.line >= 1 && marks.inline.line <= doc.lines) {
      items.push({
        from: doc.line(marks.inline.line).to,
        deco: Decoration.widget({ widget: new InlineValues(marks.inline.text, !!marks.inline.error), side: 1 }),
        order: 4,
      });
    }
    items.sort((a, b) => a.from - b.from || a.order - b.order);
    const builder = new RangeSetBuilder<Decoration>();
    for (const it of items) builder.add(it.from, it.from, it.deco);
    return { marks, decos: builder.finish(), flash };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// ------------------------------------------------------------ heat gutter

class HeatMarker extends GutterMarker {
  constructor(
    readonly count: number,
    readonly max: number,
    readonly selected: boolean,
  ) {
    super();
  }
  eq(o: HeatMarker) {
    return o.count === this.count && o.max === this.max && o.selected === this.selected;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'heat-mark' + (this.selected ? ' selected' : '');
    const k = Math.log(1 + this.count) / Math.log(1 + this.max);
    el.style.background = `color-mix(in srgb, var(--accent) ${Math.round(25 + 75 * k)}%, transparent)`;
    el.title = `Ran ${this.count.toLocaleString()} time${this.count === 1 ? '' : 's'}. Click: next run, Shift+click: previous run`;
    return el;
  }
}

const heatField = StateField.define<{ hits: Map<number, number>; selected: number | null }>({
  create: () => ({ hits: new Map(), selected: null }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHeat)) return e.value;
    if (tr.docChanged) return { hits: new Map(), selected: null };
    return v;
  },
});

// ------------------------------------------------------------ breakpoints

export interface Breakpoint {
  line: number;
  condition: string;
  enabled: boolean;
}

class BreakpointMarker extends GutterMarker {
  constructor(
    readonly condition: string,
    readonly enabled: boolean,
  ) {
    super();
  }
  eq(o: BreakpointMarker) {
    return o.condition === this.condition && o.enabled === this.enabled;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = `bp-dot${this.enabled ? '' : ' disabled'}${this.condition ? ' cond' : ''}`;
    el.title = this.condition ? `Breakpoint when ${this.condition}` : 'Breakpoint';
    return el;
  }
}

type BpEffect =
  | { kind: 'toggle'; pos: number }
  | { kind: 'update'; pos: number; condition?: string; enabled?: boolean }
  | { kind: 'remove'; pos: number }
  | { kind: 'clear'; pos: number };

const bpEffect = StateEffect.define<BpEffect>({
  map: (v, mapping) => ({ ...v, pos: mapping.mapPos(v.pos) }),
});

const bpField = StateField.define<RangeSet<BreakpointMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(bpEffect)) continue;
      const v = e.value;
      if (v.kind === 'clear') {
        set = RangeSet.empty;
        continue;
      }
      let existing: BreakpointMarker | null = null;
      set.between(v.pos, v.pos, (from, _to, m) => {
        if (from === v.pos) existing = m;
      });
      const without = set.update({ filter: (from) => from !== v.pos });
      if (v.kind === 'remove') set = without;
      else if (v.kind === 'toggle') {
        set = existing ? without : set.update({ add: [new BreakpointMarker('', true).range(v.pos)] });
      } else {
        const old = existing as BreakpointMarker | null;
        const marker = new BreakpointMarker(v.condition ?? old?.condition ?? '', v.enabled ?? old?.enabled ?? true);
        set = without.update({ add: [marker.range(v.pos)] });
      }
    }
    return set;
  },
});

class SpacerMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'bp-dot spacer';
    return el;
  }
}

// ------------------------------------------------------------- completion

function completions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[A-Za-z_]\w*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options: Completion[] = [];
  const seen = new Set<string>();
  const add = (c: Completion) => {
    if (!seen.has(c.label)) {
      seen.add(c.label);
      options.push(c);
    }
  };
  const text = ctx.state.doc.toString();
  for (const m of text.matchAll(/\b(?:let|for)\s+([A-Za-z_]\w*)|\bfn\s+([A-Za-z_]\w*)|catch\s+([A-Za-z_]\w*)/g)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) add({ label: name, type: m[2] ? 'function' : 'variable', boost: 2 });
  }
  for (const m of text.matchAll(/\bfn\s*[A-Za-z_]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) add({ label: name, type: 'variable', boost: 1 });
    }
  }
  for (const name of [...BUILTIN_NAMES, ...STDLIB_NAMES]) {
    add({ label: name, type: name === 'PI' ? 'constant' : 'function', info: BUILTIN_DOCS[name] });
  }
  for (const kw of KEYWORDS) add({ label: kw, type: 'keyword', info: KEYWORD_DOCS[kw] });
  return { from: word.from, options, validFor: /^\w*$/ };
}

// ------------------------------------------------------------------ hover

/** The identifier chain (a, a.b, a[i].c) under the pointer, cut after the hovered segment. */
function expressionAt(lineText: string, offset: number): { text: string; from: number; to: number; word: string } | null {
  const chain = /[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*|\[[^\[\]]*\])*/g;
  for (const m of lineText.matchAll(chain)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (offset < start || offset > end) continue;
    let cut = end;
    let word = '';
    for (const s of m[0].matchAll(/[A-Za-z_]\w*|\[[^\[\]]*\]/g)) {
      const s0 = start + s.index!;
      const s1 = s0 + s[0].length;
      if (offset >= s0 && offset <= s1) {
        cut = s1;
        word = s[0];
        break;
      }
    }
    return { text: lineText.slice(start, cut), from: start, to: cut, word };
  }
  return null;
}

// ----------------------------------------------------------------- API

export interface LoomEditor {
  view: EditorView;
  getCode(): string;
  setCode(code: string): void;
  setMarks(marks: ExecMarks): void;
  setHeat(hits: Map<number, number>, selected: number | null): void;
  flash(line: number): void;
  revealLine(line: number): void;
  breakpoints(): Breakpoint[];
  updateBreakpoint(line: number, change: { condition?: string; enabled?: boolean }): void;
  removeBreakpoint(line: number): void;
  clearBreakpoints(): void;
}

export interface EditorHandlers {
  onChange: () => void;
  onRun: () => void;
  onHeatClick: (line: number, backwards: boolean) => void;
  onBreakpointsChange: () => void;
  diagnostics: (code: string) => Diagnostic[];
  /** value of an expression at the current moment, or null if not available */
  hover: (expression: string) => string | null;
}

export function createEditor(parent: HTMLElement, doc: string, handlers: EditorHandlers): LoomEditor {
  const heatGutter = gutter({
    class: 'cm-heat-gutter',
    lineMarker(view, line) {
      const { hits, selected } = view.state.field(heatField);
      const n = view.state.doc.lineAt(line.from).number;
      const count = hits.get(n);
      if (!count) return null;
      let max = 1;
      for (const c of hits.values()) if (c > max) max = c;
      return new HeatMarker(count, max, selected === n);
    },
    lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setHeat))),
    domEventHandlers: {
      mousedown(view, line, event) {
        handlers.onHeatClick(view.state.doc.lineAt(line.from).number, (event as MouseEvent).shiftKey);
        return true;
      },
    },
  });

  const bpGutter = gutter({
    class: 'cm-bp-gutter',
    markers: (v) => v.state.field(bpField),
    initialSpacer: () => new SpacerMarker(),
    domEventHandlers: {
      mousedown(view, line) {
        view.dispatch({ effects: bpEffect.of({ kind: 'toggle', pos: line.from }) });
        handlers.onBreakpointsChange();
        return true;
      },
    },
  });

  const lint = linter(
    (view) => {
      const d = view.state.doc;
      return handlers.diagnostics(d.toString()).map((x): CmDiagnostic => {
        const line = d.line(Math.min(Math.max(1, x.line), d.lines));
        const from = Math.min(line.to, line.from + Math.max(0, x.col - 1));
        const to = x.length < 0 ? line.to : Math.min(line.to, from + Math.max(1, x.length));
        return { from, to: Math.max(to, from), severity: x.severity, message: x.message };
      });
    },
    { delay: 300 },
  );

  const hover = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const hit = expressionAt(line.text, pos - line.from);
    if (!hit || KEYWORDS.has(hit.word)) return null;
    const value = handlers.hover(hit.text);
    const doc = BUILTIN_DOCS[hit.text];
    if (value === null && !doc) return null;
    return {
      pos: line.from + hit.from,
      end: line.from + hit.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-value-tip';
        if (value !== null) {
          const v = document.createElement('div');
          v.className = 'mono';
          v.textContent = `${hit.text} = ${value}`;
          dom.append(v);
        }
        if (doc) {
          const d = document.createElement('div');
          d.className = 'doc';
          d.textContent = doc;
          dom.append(d);
        }
        return { dom };
      },
    };
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        bpField,
        bpGutter,
        heatField,
        heatGutter,
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        loomLanguage,
        syntaxHighlighting(highlight),
        marksField,
        lint,
        hover,
        autocompletion({ override: [completions], icons: false }),
        EditorState.tabSize.of(2),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              handlers.onRun();
              return true;
            },
          },
          ...completionKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.onChange();
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'Loom source code', spellcheck: 'false' }),
      ],
    }),
  });

  let flashTimer: number | undefined;
  const lineStart = (line: number) => view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from;

  return {
    view,
    getCode: () => view.state.doc.toString(),
    setCode(code) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        effects: bpEffect.of({ kind: 'clear', pos: 0 }),
      });
    },
    setMarks(marks) {
      view.dispatch({ effects: setMarks.of(marks) });
    },
    setHeat(hits, selected) {
      view.dispatch({ effects: setHeat.of({ hits, selected }) });
    },
    flash(line) {
      view.dispatch({ effects: flashLine.of(line) });
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => view.dispatch({ effects: flashLine.of(-1) }), 900);
    },
    revealLine(line) {
      if (line < 1 || line > view.state.doc.lines) return;
      view.dispatch({ effects: EditorView.scrollIntoView(lineStart(line), { y: 'nearest', yMargin: 60 }) });
    },
    breakpoints() {
      const out: Breakpoint[] = [];
      const d = view.state.doc;
      view.state.field(bpField).between(0, d.length, (from, _to, m) => {
        out.push({ line: d.lineAt(from).number, condition: m.condition, enabled: m.enabled });
      });
      return out;
    },
    updateBreakpoint(line, change) {
      view.dispatch({ effects: bpEffect.of({ kind: 'update', pos: lineStart(line), ...change }) });
      handlers.onBreakpointsChange();
    },
    removeBreakpoint(line) {
      view.dispatch({ effects: bpEffect.of({ kind: 'remove', pos: lineStart(line) }) });
      handlers.onBreakpointsChange();
    },
    clearBreakpoints() {
      view.dispatch({ effects: bpEffect.of({ kind: 'clear', pos: 0 }) });
      handlers.onBreakpointsChange();
    },
  };
}
