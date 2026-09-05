import { digestsMatch, hmacSha256Hex } from '@maritime/service-kit';

/*
 * A delivery the counterpart pushes to us carries three headers: when it was signed, a delivery id, and a signature
 * over the timestamp and the exact bytes of the body. The timestamp is inside the signature, so a captured delivery
 * cannot be replayed later with a fresh clock; the delivery id makes a retried delivery land once; and the signature
 * is checked in constant time against the adapter's own sealed key.
 */
export interface InboundHeaders { signature?: string; timestamp?: string; delivery?: string; event?: string }

export const INBOUND_HEADERS = { signature: 'x-hub-signature', timestamp: 'x-hub-timestamp', delivery: 'x-hub-delivery', event: 'x-hub-event' } as const;

export function signInbound(secret: string, timestamp: number | string, raw: string | Buffer): string {
  return `sha256=${hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.isBuffer(raw) ? raw : Buffer.from(raw)]))}`;
}

/** The reason a delivery is refused, or null when it is genuine and current. */
export function inboundProblem(raw: Buffer | undefined, h: InboundHeaders, secret: string, opts: { now?: number; skewSec?: number } = {}): string | null {
  if (!raw || !raw.length) return 'a signed delivery needs a body';
  const ts = Number(h.timestamp);
  if (!h.timestamp || !Number.isFinite(ts)) return `${INBOUND_HEADERS.timestamp} is required (unix seconds)`;
  const skew = opts.skewSec ?? 300;
  if (Math.abs((opts.now ?? Date.now()) / 1000 - ts) > skew) return 'the delivery timestamp is outside the accepted window';
  if (!h.delivery || h.delivery.length > 120) return `${INBOUND_HEADERS.delivery} is required`;
  if (!h.signature || !h.signature.startsWith('sha256=')) return `${INBOUND_HEADERS.signature} is required (sha256=<hex>)`;
  if (!digestsMatch(h.signature, signInbound(secret, h.timestamp, raw))) return 'the signature does not match';
  return null;
}
