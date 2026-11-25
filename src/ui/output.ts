/**
 * Program output. Lines printed before the current moment are solid, lines
 * from "the future" are ghosted. In a forked timeline, lines that differ
 * from the parent timeline are tinted.
 */

import type { Timeline } from '../core';
import { h, truncate } from './dom';

const MAX_LINES = 2000;

export class OutputPanel {
  private tl: Timeline | null = null;
  private rows: HTMLElement[] = [];
  private sep: HTMLElement | null = null;
  private errEl: HTMLElement | null = null;
  private visible = -1;

  constructor(
    private root: HTMLElement,
    private counter: HTMLElement,
    private onSeek: (pos: number) => void,
  ) {}

  reset(): void {
    this.tl = null;
    this.root.replaceChildren();
    this.counter.textContent = '';
  }

  render(tl: Timeline, pos: number): void {
    if (tl !== this.tl) this.build(tl);
    const visible = tl.outputsBefore(pos);
    if (visible !== this.visible) {
      const n = this.rows.length;
      for (let i = 0; i < n; i++) {
        const r = this.rows[i];
        r.classList.toggle('future', i >= visible);
        r.classList.toggle('latest', i === visible - 1);
      }
      if (this.sep) {
        this.sep.remove();
        if (visible < n) this.root.insertBefore(this.sep, this.rows[visible]);
      }
      this.visible = visible;
      const anchor = this.rows[Math.max(0, visible - 1)];
      if (anchor) {
        const top = anchor.offsetTop - this.root.offsetTop;
        if (top < this.root.scrollTop || top > this.root.scrollTop + this.root.clientHeight - 30) {
          this.root.scrollTop = top - this.root.clientHeight / 2;
        }
      }
    }
    if (this.errEl) this.errEl.style.display = pos >= tl.endPos ? '' : 'none';
    const total = tl.outputs.length;
    this.counter.textContent = total ? `${visible} / ${total} lines` : '';
  }

  private build(tl: Timeline): void {
    this.tl = tl;
    this.visible = -1;
    const div = tl.divergence();
    const lines = tl.outputs.slice(0, MAX_LINES);
    this.rows = lines.map((o, i) =>
      h(
        'div',
        {
          class: `out-line ${div !== null && i >= div ? 'diverged' : ''}`,
          title: `Printed at step ${o.pos}`,
          onclick: () => this.onSeek(o.pos),
        },
        h('span', { class: 'n' }, String(i + 1)),
        h('span', { class: 't' }, truncate(o.text, 4000)),
      ),
    );
    this.sep = h('div', { class: 'out-sep' }, 'not printed yet');
    const children: Node[] = [...this.rows];
    if (tl.outputs.length > MAX_LINES) {
      children.push(h('div', { class: 'out-sep' }, `… ${tl.outputs.length - MAX_LINES} more lines not shown`));
    }
    this.errEl = null;
    if (tl.end.kind === 'error') {
      this.errEl = h('div', { class: 'out-err' }, `Error on line ${tl.end.error.line}: ${tl.end.error.message}`);
      children.push(this.errEl);
    } else if (tl.end.kind === 'limit') {
      this.errEl = h('div', { class: 'out-err', style: { color: 'var(--warn)' } }, 'Stopped: step limit reached');
      children.push(this.errEl);
    }
    if (tl.outputs.length === 0 && tl.end.kind === 'done') {
      children.push(h('div', { class: 'empty' }, 'No output.'));
    }
    this.root.replaceChildren(...children);
  }
}
