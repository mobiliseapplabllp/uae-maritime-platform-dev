/** Small shapes shared by several registers. */
export interface WorldHistoryEntry { from: string; to: string; at: string; by: string; note: string }
export interface WorldCheck { check: string; passed: boolean; blocking: boolean; detail: string }
export interface WorldPersonRef { userId: string | null; name: string }
export const hist = (from: string, to: string, at: Date | number | string, by: string, note = ''): WorldHistoryEntry => ({ from, to, at: new Date(at).toISOString(), by, note });
export const check = (name: string, passed: boolean, blocking: boolean, detail: string): WorldCheck => ({ check: name, passed, blocking, detail });
