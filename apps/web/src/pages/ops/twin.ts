/* Pure layout maths for the quay twin — terminals become rows of berth slots, ships are drawn to scale against their berth. */
import type { TwinBerth } from './types';

export const SLOT_W = 150;
export const SLOT_GAP = 10;
export const QUAY_H = 16;
export const SHIP_H = 30;
export interface TerminalGroup { terminal: string; berths: TwinBerth[]; x: number; w: number }
export interface TwinLayout { rows: TerminalGroup[][]; width: number }

/** Container quays sit on the top row, SPMs offshore on the bottom, every other terminal in between. */
export const rowFor = (g: { berths: TwinBerth[] }) => (g.berths[0].berthType === 'CONTAINER' ? 0 : g.berths[0].berthType === 'SPM' ? 2 : 1);

export function twinLayout(berths: TwinBerth[]): TwinLayout {
  const groups: { terminal: string; berths: TwinBerth[] }[] = [];
  for (const b of berths) {
    let g = groups.find((x) => x.terminal === b.terminal);
    if (!g) { g = { terminal: b.terminal, berths: [] }; groups.push(g); }
    g.berths.push(b);
  }
  const rows: { terminal: string; berths: TwinBerth[] }[][] = [[], [], []];
  for (const g of groups) rows[rowFor(g)].push(g);
  let maxW = 0;
  const placed = rows.map((row) => {
    let x = 24;
    const out = row.map((g) => { const gx = x; const w = g.berths.length * (SLOT_W + SLOT_GAP) + 14; x += w + 26; return { ...g, x: gx, w }; });
    maxW = Math.max(maxW, x);
    return out;
  });
  return { rows: placed, width: Math.max(1500, maxW + 10) };
}
/** Hull length as a share of the berth's maximum LOA, never narrower than a legible hull. */
export const shipWidth = (b: TwinBerth) => {
  const scale = (b.loaMax ? Math.min(1, (b.occupiedBy?.loa || 0) / b.loaMax) : 0.8) || 0.8;
  return Math.max(56, (SLOT_W - 14) * scale);
};
/** The label painted on a hull — the ship's first name without its prefix. */
export const shortName = (name?: string | null) => String(name || '').replace(/^M[VT] /, '').split(' ')[0];
