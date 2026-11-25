/**
 * Value-history chart: every numeric value a variable (by name) took over
 * time, drawn as a step line. In a forked timeline the parent's history is
 * drawn as a dashed ghost so the two timelines can be compared.
 */

import { formatNumber, type Timeline } from '../core';
import { h, s } from './dom';

export class ChartPanel {
  constructor(
    private root: HTMLElement,
    private title: HTMLElement,
    private onSeek: (pos: number) => void,
  ) {
    new ResizeObserver(() => this.last && this.render(...this.last)).observe(root);
  }

  private last: [Timeline | null, number, string | null] | null = null;

  render(tl: Timeline | null, pos: number, name: string | null): void {
    this.last = [tl, pos, name];
    if (!tl || !name) {
      this.title.textContent = '';
      this.root.replaceChildren(
        h('div', { class: 'chart-empty' }, 'Use the plot button next to a numeric variable to show its values over time.'),
      );
      return;
    }
    const series = tl.numericSeries(name);
    const ghost = tl.parent ? tl.parent.numericSeries(name) : [];
    this.title.textContent = `${name} · ${series.length} writes${ghost.length ? ' · dashed: parent timeline' : ''}`;
    if (series.length === 0) {
      this.root.replaceChildren(h('div', { class: 'chart-empty' }, `${name} is never assigned a number in this timeline.`));
      return;
    }

    const W = Math.max(200, this.root.clientWidth);
    const H = Math.max(100, this.root.clientHeight);
    const pad = { l: 44, r: 12, t: 12, b: 20 };
    const maxX = Math.max(tl.endPos, tl.parent ? tl.parent.endPos : 0, 1);
    const all = [...series, ...ghost].map((p) => p.value);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const X = (p: number) => pad.l + (p / maxX) * (W - pad.l - pad.r);
    const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

    const stepPath = (pts: { pos: number; value: number }[], endPos: number) => {
      let d = '';
      pts.forEach((p, i) => {
        const x = X(p.pos);
        const y = Y(p.value);
        d += i === 0 ? `M${x},${y}` : `H${x}V${y}`;
      });
      d += `H${X(endPos)}`;
      return d;
    };

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}` });
    // axes / grid
    for (const v of [lo, (lo + hi) / 2, hi]) {
      svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'c-grid' }));
      const label = s('text', { x: pad.l - 6, y: Y(v) + 3, 'text-anchor': 'end', class: 'c-label' });
      label.textContent = shortNum(v);
      svg.append(label);
    }
    if (tl.parent) {
      svg.append(s('rect', { x: pad.l, y: pad.t, width: X(tl.forkPos) - pad.l, height: H - pad.t - pad.b, class: 'c-forkzone' }));
    }
    if (ghost.length) {
      svg.append(s('path', { d: stepPath(ghost, tl.parent!.endPos), class: 'c-ghost' }));
    }
    svg.append(s('path', { d: stepPath(series, tl.endPos), class: 'c-series' }));
    if (series.length <= 150) {
      for (const p of series) svg.append(s('circle', { cx: X(p.pos), cy: Y(p.value), r: 2, class: 'c-dot' }));
    }

    // cursor + current value
    const cx = X(Math.min(pos, maxX));
    svg.append(s('line', { x1: cx, x2: cx, y1: pad.t - 4, y2: H - pad.b, class: 'c-cursor' }));
    let cur: number | null = null;
    for (const p of series) {
      if (p.visibleFrom <= pos) cur = p.value;
      else break;
    }
    if (cur !== null) {
      svg.append(s('circle', { cx, cy: Y(cur), r: 3.5, class: 'c-cur-dot' }));
      const t = s('text', {
        x: Math.min(cx + 8, W - 60),
        y: Math.max(pad.t + 10, Y(cur) - 8),
        class: 'c-cur-label',
      });
      t.textContent = `${name} = ${shortNum(cur)}`;
      svg.append(t);
    }
    const axis = s('text', { x: W - pad.r, y: H - 5, 'text-anchor': 'end', class: 'c-label' });
    axis.textContent = 'step →';
    svg.append(axis);

    svg.addEventListener('click', (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const p = Math.round(((x - pad.l) / (W - pad.l - pad.r)) * maxX);
      this.onSeek(Math.max(0, Math.min(tl.endPos, p)));
    });
    this.root.replaceChildren(svg);
  }
}

function shortNum(v: number): string {
  if (Math.abs(v) >= 1e6) return v.toExponential(1);
  return formatNumber(Math.round(v * 1000) / 1000);
}
