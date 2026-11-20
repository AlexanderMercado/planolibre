import type { Units } from './model';

export const UNIT_NAMES: Record<Units, string> = { m: 'Metros (m)', cm: 'Centímetros (cm)', mm: 'Milímetros (mm)', ft: 'Pies y pulgadas' };
export const UNIT_FACTOR: Record<Units, number> = { m: 1, cm: 100, mm: 1000, ft: 1 / 0.3048 };

function num(v: number, decimals: number): string {
  return v.toFixed(decimals).replace('.', ',');
}

/** Formatea una longitud en metros según las unidades del proyecto. */
export function fmtLen(m: number, units: Units, suffix = false): string {
  switch (units) {
    case 'm': return num(m, 2) + (suffix ? ' m' : '');
    case 'cm': return num(m * 100, Math.abs(m * 100 - Math.round(m * 100)) < 0.05 ? 0 : 1) + (suffix ? ' cm' : '');
    case 'mm': return Math.round(m * 1000).toString() + (suffix ? ' mm' : '');
    case 'ft': {
      const totalIn = Math.round(Math.abs(m) / 0.0254);
      const ft = Math.floor(totalIn / 12), inch = totalIn % 12;
      return `${m < 0 ? '-' : ''}${ft}' ${inch}"`;
    }
  }
}

export function fmtArea(m2: number, units: Units): string {
  if (units === 'ft') return num(m2 * 10.7639104, 1) + ' ft²';
  return num(m2, 2) + ' m²';
}

export function unitSuffix(units: Units): string {
  return units === 'ft' ? 'ft' : units;
}

/** Convierte lo que escribe el usuario a metros. Acepta "3,5", "3.5", "350cm", "3.5 m", 12'6". */
export function parseLen(text: string, units: Units): number | null {
  let s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const feet = s.match(/^(-?[\d.,]+)\s*(?:'|ft|pies?)\s*(?:([\d.,]+)\s*(?:"|in|''|pulg)?)?$/);
  if (feet) {
    const f = parseFloat(feet[1].replace(',', '.')), i = feet[2] ? parseFloat(feet[2].replace(',', '.')) : 0;
    if (isNaN(f) || isNaN(i)) return null;
    return f * 0.3048 + i * 0.0254;
  }
  const m = s.match(/^(-?[\d.,]+)\s*(mm|cm|m|"|in)?$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  if (isNaN(v)) return null;
  const u = m[2];
  if (u === 'mm') return v / 1000;
  if (u === 'cm') return v / 100;
  if (u === 'm') return v;
  if (u === '"' || u === 'in') return v * 0.0254;
  return v / UNIT_FACTOR[units];
}

/** Valor numérico simple para campos de formulario (sin sufijo). */
export function toUnit(m: number, units: Units): string {
  if (units === 'ft') return fmtLen(m, units);
  const v = m * UNIT_FACTOR[units];
  const d = units === 'm' ? 3 : units === 'cm' ? 1 : 0;
  return String(parseFloat(v.toFixed(d))).replace('.', ',');
}
