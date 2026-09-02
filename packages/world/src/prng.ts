/** Deterministic PRNG (mulberry32). The same seed always produces the same world. */
export class Prng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number { let t = (this.s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number): boolean { return this.next() < p; }
  shuffle<T>(arr: readonly T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}
export const DEFAULT_SEED = 20260823;
export const HIST_START = new Date(Date.UTC(2023, 0, 1));
export const H = 3600_000; export const D = 24 * H;
/** Deterministic pseudo-UUID (v4-shaped) from a namespace and key so cross-service references agree without a shared database. */
export function stableId(namespace: string, key: string): string {
  const s = `${namespace}:${key}`;
  const words: number[] = [];
  for (let w = 0; w < 4; w++) {
    let h = (0x811c9dc5 ^ (w * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    words.push(h >>> 0);
  }
  const hex = words.map((x) => x.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
