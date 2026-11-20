// Utilidades mínimas de interfaz: crear elementos, iconos, menús, diálogos y avisos.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any> | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const P: Record<string, string> = {
  select: '<path d="M5 3l14 8-6.5 1.8L10 19z"/>',
  wall: '<path d="M3 6h18v12H3zM3 12h18M9 6v6M15 12v6"/>',
  room: '<path d="M4 4h16v16H4z"/><path d="M4 12h7v8"/>',
  door: '<path d="M4 20h16M6 20V4h8v16"/><path d="M14 4c4 2 6 6 6 12" stroke-dasharray="2 2"/><circle cx="11.5" cy="12" r=".6"/>',
  window: '<path d="M4 5h16v14H4zM12 5v14M4 12h16"/>',
  gap: '<path d="M3 8h5v8H3M21 8h-5v8h5"/><path d="M8 8h8M8 16h8" stroke-dasharray="2 2"/>',
  sofa: '<path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 12a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3zM6 17v2M18 17v2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  dim: '<path d="M4 7v10M20 7v10M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>',
  line: '<path d="M4 18L10 8l5 6 5-9"/><circle cx="4" cy="18" r="1.3"/><circle cx="20" cy="5" r="1.3"/>',
  measure: '<path d="M3 16L16 3l5 5L8 21z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6 7-3 0-4.5-1.5-6-4l-2-3.5a1.4 1.4 0 0 1 2.4-1.4L8 14"/>',
  undo: '<path d="M8 5L3 10l5 5"/><path d="M3 10h11a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M16 5l5 5-5 5"/><path d="M21 10H10a6 6 0 0 0 0 12h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  save: '<path d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.2A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.2 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4-.9"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
  copy: '<path d="M8 8h12v12H8z"/><path d="M16 8V4H4v12h4"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>',
  flip: '<path d="M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  image: '<path d="M4 5h16v14H4z"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  split: '<path d="M4 12h6M14 12h6M12 5v14"/>',
  lock: '<path d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3"/>',
  spark: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  calibrate: '<path d="M4 20L20 4M4 20v-5M4 20h5M20 4v5M20 4h-5"/>',
  grid: '<path d="M4 4h16v16H4zM4 10h16M4 16h16M10 4v16M16 4v16"/>',
};

export function icon(name: string, size = 20): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return t.content.firstChild as SVGSVGElement;
}

// ───────────── menú desplegable ─────────────

export interface MenuItem { label?: string; icon?: string; hint?: string; action?: () => void; sep?: boolean; header?: string; disabled?: boolean }

export function openMenu(anchor: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    menu.append(h('button', { class: 'menu-item', role: 'menuitem', disabled: it.disabled, onclick: () => { close(); it.action?.(); } },
      it.icon ? icon(it.icon, 17) : h('span', { class: 'menu-noicon' }), h('span', { class: 'menu-label' }, it.label || ''), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  if (align === 'right') menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  else menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  const onDoc = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); });
}

// ───────────── diálogos ─────────────

export interface ModalButton { label: string; primary?: boolean; danger?: boolean; value?: any; onClick?: () => any | Promise<any> }

export function modal<T = any>(title: string, body: Node | string, buttons: ModalButton[] = [{ label: 'Cerrar', value: null }], opts: { wide?: boolean; dismissable?: boolean; size?: 'xl' } = {}): Promise<T | null> {
  return new Promise(resolve => {
    const done = (v: any) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const footer = h('div', { class: 'modal-footer' });
    for (const b of buttons) {
      footer.append(h('button', {
        class: 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : ''),
        onclick: async () => { if (b.onClick) { const r = await b.onClick(); if (r === false) return; done(r === undefined ? b.value ?? true : r); } else done(b.value === undefined ? true : b.value); },
      }, b.label));
    }
    const box = h('div', { class: 'modal' + (opts.wide ? ' modal-wide' : '') + (opts.size === 'xl' ? ' modal-xl' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), opts.dismissable === false ? null : h('button', { class: 'icon-btn', title: 'Cerrar', onclick: () => done(null) }, icon('close', 18))),
      h('div', { class: 'modal-body' }, typeof body === 'string' ? h('p', null, body) : body),
      buttons.length ? footer : null);
    const back = h('div', { class: 'modal-backdrop', onpointerdown: (e: Event) => { if (e.target === back && opts.dismissable !== false) done(null); } }, box);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && opts.dismissable !== false) { e.stopPropagation(); done(null); }
      // en diálogos con vista previa, Enter dentro de un campo sólo aplica el valor
      if (e.key === 'Enter' && (e.target as HTMLElement).closest?.('[data-noenter]') && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); (e.target as HTMLElement).blur(); return; }
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'BUTTON') { const p = footer.querySelector('.btn-primary') as HTMLButtonElement | null; if (p) { e.preventDefault(); p.click(); } }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    const first = box.querySelector('input, select, textarea, .btn-primary') as HTMLElement | null;
    setTimeout(() => { first?.focus(); if (first instanceof HTMLInputElement) first.select(); }, 30);
  });
}

export async function confirmDialog(title: string, message: string, okLabel = 'Aceptar', danger = false): Promise<boolean> {
  return !!(await modal(title, message, [{ label: 'Cancelar', value: false }, { label: okLabel, primary: !danger, danger, value: true }]));
}

export async function promptDialog(title: string, value = '', help = ''): Promise<string | null> {
  const input = h('input', { class: 'input', type: 'text', value });
  const body = h('div', { class: 'stack' }, help ? h('p', { class: 'muted' }, help) : null, input);
  const ok = await modal(title, body, [{ label: 'Cancelar', value: false }, { label: 'Aceptar', primary: true, value: true }]);
  return ok ? input.value : null;
}

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.querySelector('.toast') as HTMLElement | null;
  if (!el) { el = h('div', { class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg;
  el.className = 'toast show' + (kind === 'error' ? ' toast-error' : '');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.className = 'toast'; }, kind === 'error' ? 6000 : 2800);
}
