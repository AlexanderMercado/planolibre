// Plano de ejemplo: un departamento de 2 dormitorios. Sirve de demostración
// y como base de las pruebas automáticas.

import type { Project } from './model';
import { newProject } from './model';
import { addWall, computeRooms } from './topology';
import { addItem, addOpeningAt, nameRoomAt } from './ops';

export function sampleProject(): Project {
  const p = newProject('Departamento de ejemplo');
  const lv = p.levels[0];
  const ext = 0.2, int = 0.1, H = 2.4;
  const W = (x1: number, y1: number, x2: number, y2: number, t: number) => addWall(lv, { x: x1, y: y1 }, { x: x2, y: y2 }, t, H);
  W(0, 0, 9, 0, ext); W(9, 0, 9, 7, ext); W(9, 7, 0, 7, ext); W(0, 7, 0, 0, ext);
  W(0, 4, 9, 4, int); W(5, 0, 5, 4, int); W(3, 4, 3, 7, int); W(3, 5.2, 9, 5.2, int); W(6, 5.2, 6, 7, int);

  addOpeningAt(lv, { x: 0, y: 3.2 }, 'door', 0.9, 'single', false, true);          // acceso
  addOpeningAt(lv, { x: 4.2, y: 4 }, 'door', 0.8, 'single', false, false);          // living → pasillo
  addOpeningAt(lv, { x: 1.5, y: 4 }, 'gap', 1.4);                                   // living ↔ cocina
  addOpeningAt(lv, { x: 5.7, y: 4 }, 'door', 0.8, 'single', true, true);            // dormitorio principal
  addOpeningAt(lv, { x: 4.4, y: 5.2 }, 'door', 0.7, 'single', false, false);        // baño
  addOpeningAt(lv, { x: 6.7, y: 5.2 }, 'door', 0.8, 'single', true, false);         // dormitorio 2
  addOpeningAt(lv, { x: 2.5, y: 0 }, 'window', 2.2, 'sliding');
  addOpeningAt(lv, { x: 7, y: 0 }, 'window', 1.6, 'sliding');
  addOpeningAt(lv, { x: 9, y: 2 }, 'window', 1.2, 'single');
  addOpeningAt(lv, { x: 1.5, y: 7 }, 'window', 1.2, 'single');
  addOpeningAt(lv, { x: 4.5, y: 7 }, 'window', 0.6, 'fixed');
  addOpeningAt(lv, { x: 7.5, y: 7 }, 'window', 1.4, 'sliding');

  nameRoomAt(lv, { x: 2.5, y: 2 }, 'Living comedor');
  nameRoomAt(lv, { x: 7, y: 2 }, 'Dormitorio principal');
  nameRoomAt(lv, { x: 1.5, y: 5.5 }, 'Cocina');
  nameRoomAt(lv, { x: 6, y: 4.6 }, 'Pasillo');
  nameRoomAt(lv, { x: 4.5, y: 6.1 }, 'Baño');
  nameRoomAt(lv, { x: 7.5, y: 6.1 }, 'Dormitorio 2');

  addItem(lv, 'sofa3', 1.35, 0.62, 0);
  addItem(lv, 'coffee', 1.35, 1.65, 0);
  addItem(lv, 'tv', 1.35, 3.68, 180);
  addItem(lv, 'table4', 3.75, 1.5, 90);
  addItem(lv, 'plant', 4.55, 0.45, 0);
  addItem(lv, 'bed2', 7.0, 1.15, 0);
  addItem(lv, 'nightstand', 5.9, 0.35, 0);
  addItem(lv, 'nightstand', 8.1, 0.35, 0);
  addItem(lv, 'wardrobe', 7.9, 3.62, 180, 1.6, 0.55);
  addItem(lv, 'counter', 0.42, 5.2, 90, 1.5, 0.6);
  addItem(lv, 'stove', 0.42, 6.25, 90);
  addItem(lv, 'sink', 1.55, 6.58, 180, 0.9, 0.6);
  addItem(lv, 'fridge', 2.57, 6.52, 180);
  addItem(lv, 'toilet', 3.45, 6.45, -90);
  addItem(lv, 'basin', 3.4, 5.65, -90);
  addItem(lv, 'shower', 5.52, 6.52, 0, 0.85, 0.85);
  addItem(lv, 'bed1', 8.4, 6.0, 0, 0.9, 1.7);
  addItem(lv, 'desk', 6.75, 6.6, 180, 1.1, 0.55);

  // los nombres quedan anclados al centro real de cada recinto
  for (const r of computeRooms(lv)) if (r.meta) { r.meta.x = r.center.x; r.meta.y = r.center.y; }
  return p;
}
