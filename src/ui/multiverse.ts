/**
 * The multiverse panel: one row per timeline. Each track shows the
 * inherited prefix (dim), the timeline's own branch (bright), the fork point
 * and how the timeline ended.
 */

import type { Multiverse, Timeline } from '../core';
import { h, s, truncate } from './dom';

export class MultiversePanel {
  constructor(
    private root: HTMLElement,
    private onSelect: (tl: Timeline) => void,
  ) {}

  render(mv: Multiverse, current: Timeline, pos: number): void {
    const maxEnd = Math.max(1, ...mv.timelines.map((t) => t.endPos));
    const rows: Node[] = [];

    // order timelines depth-first so children sit under their parents
    const ordered: { tl: Timeline; depth: number }[] = [];
    const visit = (tl: Timeline, depth: number) => {
      ordered.push({ tl, depth });
      for (const c of mv.timelines.filter((t) => t.parent === tl)) visit(c, depth + 1);
    };
    visit(mv.root, 0);

    for (const { tl, depth } of ordered) {
      const isCur = tl === current;
      const W = 1000;
      const x = (p: number) => (p / maxEnd) * W;
      const svg = s('svg', { class: 'tl-track', viewBox: `0 0 ${W} 16`, preserveAspectRatio: 'none' });
      // whole span
      const start = tl.parent ? tl.forkPos : 0;
      if (tl.parent) {
        svg.append(s('rect', { x: 0, y: 7, width: x(start), height: 2, class: 't-inherited' }));
      }
      const spanClass = `t-span ${tl.end.kind === 'error' ? 'err' : tl.end.kind === 'limit' ? 'limit' : ''} ${isCur ? '' : 'dim'}`;
      svg.append(s('rect', { x: x(start), y: 5, width: Math.max(2, x(tl.endPos) - x(start)), height: 6, class: spanClass }));
      // children fork points
      for (const c of mv.timelines) {
        if (c.parent === tl) {
          svg.append(s('rect', { x: x(c.forkPos) - 1, y: 1, width: 2, height: 14, class: 't-fork' }));
        }
      }
      if (tl.parent) {
        svg.append(s('rect', { x: x(start) - 1, y: 1, width: 2, height: 14, class: 't-fork' }));
      }
      if (isCur) {
        svg.append(s('rect', { x: x(pos) - 1.5, y: 0, width: 3, height: 16, class: 't-head' }));
      }

      const last = tl.outputs.at(-1)?.text;
      const outcome =
        tl.end.kind === 'error'
          ? `error: ${tl.end.error.message}`
          : tl.end.kind === 'limit'
            ? 'stopped at step limit'
            : last !== undefined
              ? last
              : 'finished';
      const div = tl.divergence();

      rows.push(
        h(
          'div',
          {
            class: `tl-row ${isCur ? 'current' : ''}`,
            onclick: () => this.onSelect(tl),
            title: tl.parent
              ? `Forked from #${tl.parent.id} at step ${tl.forkPos} with ${tl.label}${div !== null ? ` · output diverges at line ${div + 1}` : ' · same output as parent'}`
              : 'Original run',
          },
          h(
            'div',
            { class: 'tl-label', style: { paddingLeft: `${Math.min(depth, 4) * 10}px` } },
            h('span', { class: 'tl-name' }, h('span', { class: 'tid' }, `#${tl.id}`), truncate(tl.label === 'origin' ? 'original' : tl.label, 22)),
            h('span', { class: `tl-outcome ${tl.end.kind === 'error' ? 'err' : ''}` }, truncate(outcome, 40)),
          ),
          svg,
        ),
      );
    }

    if (mv.timelines.length === 1) {
      rows.push(
        h(
          'div',
          { class: 'tl-help' },
          'To create another timeline, go to a step, click the pencil next to a variable and enter a new value. The program re-runs from that step.',
        ),
      );
    }
    this.root.replaceChildren(...rows);
  }
}
