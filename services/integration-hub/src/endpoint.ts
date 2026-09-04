/**
 * What counts as an acceptable counterpart endpoint.
 *
 * Switching an adapter to live writes a caller-supplied URL into the row the outbound client reads its host
 * from. `z.string().url()` was the only check, which accepts `http://169.254.169.254/latest/meta-data/` and
 * every other address inside the cluster — a request-forgery pivot dressed as an administrative setting, and
 * the permission that opens it (settings.manage) is not a reason to skip the check: an operator can be
 * phished, and a government integration pointed at the metadata service is the worst version of that.
 *
 * A counterpart is a named public service reached over TLS. That is what this enforces, and it names each
 * refusal so an operator with a legitimate endpoint can see what is wrong with it.
 */

/** Reserved and private ranges an outbound integration must never be aimed at. */
const BLOCKED_V4 = [
  { name: 'loopback', test: (o: number[]) => o[0] === 127 },
  { name: 'this network', test: (o: number[]) => o[0] === 0 },
  { name: 'private (10/8)', test: (o: number[]) => o[0] === 10 },
  { name: 'private (172.16/12)', test: (o: number[]) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { name: 'private (192.168/16)', test: (o: number[]) => o[0] === 192 && o[1] === 168 },
  { name: 'carrier-grade NAT', test: (o: number[]) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
  { name: 'link-local — the cloud metadata service lives here', test: (o: number[]) => o[0] === 169 && o[1] === 254 },
  { name: 'multicast', test: (o: number[]) => o[0] >= 224 && o[0] <= 239 },
  { name: 'reserved', test: (o: number[]) => o[0] >= 240 },
];
/** Ports the platform itself listens on; a "local stub" pointed at one of these is not a stub. */
const INFRASTRUCTURE_PORTS = new Set([5432, 5433, 4222, 6222, 8222, 8180, 6379, 9000, 9090, 3000, 5300]);
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localdomain', '.cluster.local', '.svc', '.svc.cluster.local'];

export interface EndpointOptions {
  /** Outside production a counterpart may be a stub on this machine, so plain HTTP to localhost is allowed. */
  allowLocal?: boolean;
}

/** The reason this URL is unacceptable, or null when it is fine. */
export function endpointProblem(raw: string, opts: EndpointOptions = {}): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return 'baseUrl must be an absolute URL'; }

  if (url.username || url.password) return 'baseUrl must not carry credentials; configure them as adapter secrets';
  if (url.hash || url.search) return 'baseUrl must be a bare origin and path, with no query string or fragment';

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const isLocalName = host === 'localhost' || host === '::1' || host === '127.0.0.1';
  if (url.protocol !== 'https:') {
    if (!(opts.allowLocal && url.protocol === 'http:' && isLocalName)) return 'a counterpart must be reached over https';
  }
  if (isLocalName) {
    if (!opts.allowLocal) return 'baseUrl must not point at this machine';
    // A local stub is a stub, not a way to reach the platform's own back end. A privileged port, the
    // database, the message bus or a service port is refused even here, because "it is only development"
    // is how a development convenience becomes the shape of the production configuration.
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (port < 1024) return 'a local stub must listen on an unprivileged port';
    if (INFRASTRUCTURE_PORTS.has(port)) return `port ${port} belongs to the platform's own infrastructure`;
    if (port >= 5200 && port <= 5599) return `port ${port} is in the platform's own service range`;
    return null;
  }

  // An IPv4 literal is refused outright: a counterpart is a named service, and a literal is how an internal
  // address gets past a host allow-list.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return 'baseUrl is not a valid address';
    const blocked = BLOCKED_V4.find((b) => b.test(octets));
    return blocked ? `baseUrl points into a reserved range (${blocked.name})` : 'baseUrl must name a host, not an IP address';
  }
  if (host.includes(':') || url.hostname.startsWith('[')) return 'baseUrl must name a host, not an IP address';
  if (!host.includes('.')) return 'baseUrl must be a fully qualified host name';
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return 'baseUrl must not name an internal cluster address';
  if (raw.length > 300) return 'baseUrl is too long';
  return null;
}

export const endpointAcceptable = (raw: string, opts: EndpointOptions = {}): boolean => endpointProblem(raw, opts) === null;
