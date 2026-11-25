/** Variables, call stack and status banner. */

import { isRef, type HeapObj, type Multiverse, type Timeline, type Value, type VMState } from '../core';
import { h, ICONS, truncate, valueClass } from './dom';

export interface InspectContext {
  mv: Multiverse;
  tl: Timeline;
  pos: number;
  state: VMState;
  frameIndex: number;
  chartVar: string | null;
  /** true when we arrived here by a small step, so changes are worth highlighting */
  highlight: boolean;
}

export interface VarActions {
  prevChange(name: string, envId: number, value: Value): void;
  nextChange(name: string, envId: number, value: Value): void;
  chart(name: string): void;
  fork(name: string, source: string): string | null; // returns an error message or null
}

const SCOPE_LABEL: Record<string, string> = {
  globals: 'globals',
  locals: 'locals',
  block: 'block',
  closure: 'closure',
};

/** Find the function-call environment of a frame (holds its parameters). */
function callEnv(state: VMState, envId: number): Extract<HeapObj, { t: 'env' }> | null {
  let id: number | null = envId;
  while (id !== null) {
    const env = state.heap.get(id) as Extract<HeapObj, { t: 'env' }> | undefined;
    if (!env) return null;
    if (env.c) return env;
    id = env.p;
  }
  return null;
}

export class VariablesPanel {
  private prev = new Map<string, string>();
  private editing: { envId: number; name: string } | null = null;
  private lastKey = '';

  constructor(
    private root: HTMLElement,
    private banner: HTMLElement,
    private actions: VarActions,
  ) {}

  isEditing(): boolean {
    return this.editing !== null;
  }

  cancelEdit(): void {
    this.editing = null;
  }

  render(ctx: InspectContext): void {
    const { mv, tl, pos, state } = ctx;
    const vm = mv.vm;
    const atEnd = pos >= tl.endPos;

    // ----- banner
    this.banner.replaceChildren();
    if (atEnd) {
      if (tl.end.kind === 'error') {
        this.banner.append(
          h('div', { class: 'banner error' }, 'Error on line ', h('b', null, String(tl.end.error.line)), ': ', tl.end.error.message),
        );
      } else if (tl.end.kind === 'limit') {
        this.banner.append(
          h('div', { class: 'banner limit' }, `Stopped after ${tl.endPos.toLocaleString()} steps (step limit reached). The program may contain an infinite loop.`),
        );
      } else {
        this.banner.append(
          h('div', { class: 'banner done' }, `Program finished after ${tl.endPos.toLocaleString()} steps.`),
        );
      }
    }

    const key = `${tl.id}:${pos}:${ctx.frameIndex}`;
    if (this.editing && key !== this.lastKey) this.editing = null;
    this.lastKey = key;

    const scopes = vm.scopes(state, ctx.frameIndex);
    const nodes: Node[] = [];
    const seen = new Map<string, string>();

    for (const scope of scopes) {
      if (scope.vars.length === 0 && scope.kind !== 'globals') continue;
      const tag = SCOPE_LABEL[scope.kind];
      nodes.push(
        h(
          'div',
          { class: 'scope-title' },
          h('span', { class: `tag ${scope.kind === 'closure' ? 'closure' : ''}` }, tag),
        ),
      );
      if (scope.vars.length === 0) {
        nodes.push(h('div', { class: 'empty', style: { padding: '2px 14px 6px' } }, '(empty)'));
      }
      const wrap = h('div', { class: 'scope' });
      for (const [name, value] of scope.vars) {
        const id = `${scope.envId}:${name}`;
        const shown = vm.format(state, value, true);
        seen.set(id, shown);
        const changed = ctx.highlight && (this.prev.has(id) ? this.prev.get(id) !== shown : this.prev.size > 0);
        const isNum = typeof value === 'number';
        const o = isRef(value) ? state.heap.get(value.r) : undefined;
        const isFn = o?.t === 'fn' || o?.t === 'bi';

        const row = h(
          'div',
          { class: `var ${changed ? 'changed' : ''}` },
          h('span', { class: 'name' }, name),
          h('span', { class: `value ${valueClass(state, value)}`, title: truncate(shown, 2000) }, truncate(shown, 120)),
          h(
            'span',
            { class: 'actions' },
            h('button', {
              class: 'icon-btn',
              title: `Go to previous change of ${name}`,
              html: ICONS.prev,
              onclick: () => this.actions.prevChange(name, scope.envId, value),
            }),
            h('button', {
              class: 'icon-btn',
              title: `Go to next change of ${name}`,
              html: ICONS.next,
              onclick: () => this.actions.nextChange(name, scope.envId, value),
            }),
            h('button', {
              class: `icon-btn ${ctx.chartVar === name ? 'active' : ''}`,
              title: isNum ? `Plot values of ${name}` : 'Only numbers can be plotted',
              html: ICONS.chart,
              disabled: !isNum,
              onclick: () => this.actions.chart(name),
            }),
            h('button', {
              class: 'icon-btn fork',
              title: atEnd ? 'Not available at the end of the program' : `Set ${name} to a different value from this step`,
              html: ICONS.fork,
              disabled: atEnd || isFn,
              onclick: () => {
                this.editing = { envId: scope.envId, name };
                this.render(ctx);
              },
            }),
          ),
        );

        if (this.editing && this.editing.envId === scope.envId && this.editing.name === name) {
          const input = h('input', { value: shown, spellcheck: 'false', 'aria-label': `New value for ${name}` });
          const err = h('div', { class: 'ferr' });
          const submit = () => {
            const msg = this.actions.fork(name, input.value);
            if (msg) err.textContent = msg;
            else this.editing = null;
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') {
              this.editing = null;
              this.render(ctx);
            }
            e.stopPropagation();
          });
          row.append(
            h(
              'div',
              { class: 'fork-editor' },
              h('div', { class: 'row' }, input, h('button', { onclick: submit, text: 'Fork' })),
              h(
                'div',
                { class: 'explain' },
                `Re-runs the program from step ${pos.toLocaleString()} with this value as a new timeline. The current timeline is kept.`,
              ),
              err,
            ),
          );
          queueMicrotask(() => {
            input.focus();
            input.select();
          });
        }
        wrap.append(row);
      }
      nodes.push(wrap);
    }

    if (scopes.length === 0) nodes.push(h('div', { class: 'empty' }, 'No variables.'));
    this.root.replaceChildren(...nodes);
    this.prev = seen;
  }
}

export class StackPanel {
  constructor(
    private root: HTMLElement,
    private onSelect: (frameIndex: number) => void,
  ) {}

  render(ctx: InspectContext): void {
    const { mv, state } = ctx;
    const vm = mv.vm;
    const rows: Node[] = [];
    for (let i = state.frames.length - 1; i >= 0; i--) {
      const f = state.frames[i];
      const proto = vm.program.protos[f.f];
      let args = '';
      if (i > 0) {
        const env = callEnv(state, f.env);
        if (env) {
          args = proto.params
            .map((p) => `${p}=${truncate(vm.format(state, env.v[p] ?? null, true), 14)}`)
            .join(', ');
        }
      }
      const name = i === 0 ? '<main>' : proto.name;
      rows.push(
        h(
          'div',
          {
            class: `frame ${i === ctx.frameIndex ? 'selected' : ''} ${i === state.frames.length - 1 ? 'top' : ''}`,
            title: 'Inspect this frame',
            onclick: () => this.onSelect(i),
          },
          h('span', { class: 'fname' }, name, i > 0 ? h('em', null, `(${args})`) : null),
          h('span', { class: 'fline' }, `line ${vm.frameLine(state, i)}`),
        ),
      );
    }
    if (rows.length === 0) rows.push(h('div', { class: 'empty' }, 'Empty stack.'));
    this.root.replaceChildren(...rows);
  }
}

/** Compact "name = value" hints for identifiers on the current line. */
export function inlineHints(ctx: InspectContext, sourceLine: string): string {
  const { mv, state } = ctx;
  const top = state.frames.length - 1;
  if (top < 0) return '';
  const visible = new Map<string, Value>();
  for (const scope of mv.vm.scopes(state, top)) {
    for (const [k, v] of scope.vars) if (!visible.has(k)) visible.set(k, v);
  }
  const code = sourceLine.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  const names = [...new Set(code.match(/[A-Za-z_]\w*/g) ?? [])];
  const parts: string[] = [];
  for (const n of names) {
    if (!visible.has(n)) continue;
    const v = visible.get(n)!;
    if (isRef(v)) {
      const o = state.heap.get(v.r);
      if (o?.t === 'fn' || o?.t === 'bi') continue;
    }
    parts.push(`${n} = ${truncate(mv.vm.format(state, v, true), 28)}`);
    if (parts.length >= 4) break;
  }
  return parts.join('   ');
}
