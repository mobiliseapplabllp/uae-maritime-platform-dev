/* Tiny event bus for the global network-activity loader. */
let count = 0;
const listeners = new Set<(busy: boolean) => void>();
const emit = () => listeners.forEach((l) => l(count > 0));
export const busyStart = () => { count += 1; emit(); };
export const busyEnd = () => { count = Math.max(0, count - 1); emit(); };
export const onBusy = (fn: (busy: boolean) => void) => { listeners.add(fn); fn(count > 0); return () => { listeners.delete(fn); }; };
