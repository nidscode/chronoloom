/** Tiny DOM helpers — no framework needed. */

import { isRef, type Value, type VMState } from '../core';

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  ...children: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function valueClass(state: VMState, v: Value): string {
  if (v === null) return 'v-nil';
  if (typeof v === 'number') return 'v-number';
  if (typeof v === 'string') return 'v-string';
  if (typeof v === 'boolean') return 'v-bool';
  if (isRef(v)) {
    const o = state.heap.get(v.r);
    if (o?.t === 'fn' || o?.t === 'bi') return 'v-fn';
  }
  return '';
}

let toastTimer: number | undefined;
export function toast(message: string, kind: '' | 'fork' = ''): void {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = 'toast'), 2800);
}

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;

/** Small stroke icons used across the panels. */
export const ICONS = {
  prev: svg('<path d="M2.5 2.5v4h4"/><path d="M3 6.5a5.2 5.2 0 1 1 1.4 5.3"/>'),
  next: svg('<path d="M13.5 2.5v4h-4"/><path d="M13 6.5a5.2 5.2 0 1 0-1.4 5.3"/>'),
  chart: svg('<path d="M2 13.5h12"/><path d="M2.5 10.5l3.2-4 3 2.2 4.8-6"/>'),
  fork: svg('<path d="M2.5 13.5l.8-3.2 7.4-7.4 2.4 2.4-7.4 7.4z"/><path d="M9.2 4.4l2.4 2.4"/>'),
  find: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.5 3.5"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  clear: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>'),
  prevMatch: svg('<path d="M4 10l4-4 4 4"/>'),
  nextMatch: svg('<path d="M4 6l4 4 4-4"/>'),
};
