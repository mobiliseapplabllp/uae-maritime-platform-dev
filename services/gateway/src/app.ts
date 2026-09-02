import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Readable, Transform } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest, type RawServerBase, type RequestGenericInterface, type RouteGenericInterface } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import httpProxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import pino, { type Logger } from 'pino';
import { aggregateHealth } from './health';
import { type Env, parseTrustProxy } from './env';
import { DEFAULT_BODY_LIMIT, type ResolvedRoute, resolveRoutes, resolveServices } from './routes';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Upstream service name for proxied routes. */
    service?: string;
    /** Request body limit in bytes for this route. */
    bodyLimit?: number;
  }
}

export interface GatewayOptions { logger?: Logger }
type HttpError = Error & { statusCode?: number; code?: string };

export const createLogger = (name: string, level = 'info'): Logger => pino({ name, level, base: { service: name } });
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const NOT_FOUND = { success: false, message: 'API route not found' } as const;
const httpError = (statusCode: number, message: string, code?: string): HttpError => Object.assign(new Error(message), { statusCode, code });

/** Client IP chain forwarded upstream; inbound X-Forwarded-For is only honoured when the proxy in front is trusted. */
type ProxiedRequest = FastifyRequest<RequestGenericInterface, RawServerBase>;
type ProxiedReply = FastifyReply<RouteGenericInterface, RawServerBase>;

function forwardedFor(req: ProxiedRequest, trusted: boolean): string {
  const socketIp = req.socket.remoteAddress ?? '';
  const inbound = req.headers['x-forwarded-for'];
  const chain = trusted && inbound ? (Array.isArray(inbound) ? inbound.join(', ') : inbound) : '';
  return chain ? `${chain}, ${socketIp}` : socketIp;
}

/** Counts a chunked request body as it streams through and fails it once the route limit is exceeded. */
function guardBody(body: Readable, limit: number): Readable {
  let seen = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(httpError(413, 'Payload too large', 'FST_GATEWAY_BODY_TOO_LARGE'));
      else callback(null, chunk);
    },
  });
  body.on('error', (err) => guard.destroy(err));
  return body.pipe(guard);
}

export async function buildGateway(env: Env, opts: GatewayOptions = {}): Promise<FastifyInstance> {
  const logger = opts.logger ?? createLogger(env.SERVICE_NAME, env.LOG_LEVEL);
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const routes = resolveRoutes(env as Record<string, string | undefined>);
  const services = resolveServices(env as Record<string, string | undefined>);
  const origins = env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy,
    // Fastify checks declared lengths against this ceiling; the tighter per-route limits are enforced by the hooks below.
    bodyLimit: Math.max(env.BODY_LIMIT_BYTES, env.UPLOAD_BODY_LIMIT_BYTES),
    requestIdHeader: false,
    genReqId: (raw: IncomingMessage) => {
      const inbound = raw.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
    forceCloseConnections: 'idle',
  });

  // The gateway never parses bodies: everything streams through so limits apply uniformly and payloads are untouched.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: origins.includes('*') ? '*' : origins,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-request-id', 'x-correlation-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MIN,
    timeWindow: 60_000,
    errorResponseBuilder: (_req, ctx) => httpError(ctx.statusCode, `Rate limit exceeded, retry in ${ctx.after}`, 'FST_GATEWAY_RATE_LIMITED'),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const limit = req.routeOptions.config.bodyLimit ?? env.BODY_LIMIT_BYTES;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reply.header('connection', 'close');
      await reply.code(413).send({ success: false, message: 'Payload too large' });
      return reply;
    }
  });
  app.addHook('preHandler', async (req) => {
    if (req.headers['content-length'] !== undefined || !(req.body instanceof Readable)) return;
    req.body = guardBody(req.body, req.routeOptions.config.bodyLimit ?? env.BODY_LIMIT_BYTES);
  });
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // Handlers are set before any route context is created so every encapsulated proxy inherits them.
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?');
    return reply.code(404).send(isApi ? NOT_FOUND : { success: false, message: 'Not found' });
  });
  app.setErrorHandler((error: HttpError, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) req.log.error({ err: error }, 'gateway error');
    const message = status === 413 ? 'Payload too large' : status >= 500 ? 'Internal error' : error.message;
    if (status === 413) reply.header('connection', 'close');
    return reply.code(status).send({ success: false, message });
  });

  const started = Date.now();
  app.get('/health', async () => ({ success: true, data: { status: 'ok', service: env.SERVICE_NAME, uptimeSec: Math.round((Date.now() - started) / 1000), time: new Date().toISOString() } }));
  app.get('/api/health', async () => ({ success: true, data: await aggregateHealth(services, env.HEALTH_TIMEOUT_MS) }));

  const blocked = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send(NOT_FOUND);
  const rewriteRequestHeaders = (req: ProxiedRequest, headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const out: IncomingHttpHeaders = { ...headers };
    delete out['x-service-token'];
    out['x-request-id'] = req.id;
    if (!out['x-correlation-id']) out['x-correlation-id'] = req.id;
    out['x-forwarded-for'] = forwardedFor(req, trustProxy !== false);
    out['x-forwarded-proto'] = req.protocol;
    out['x-forwarded-host'] = req.host;
    return out;
  };
  const onError = (reply: ProxiedReply, { error }: { error: Error }) => {
    const err = error as HttpError;
    const service = reply.request.routeOptions.config.service ?? 'unknown';
    if (err.statusCode === 413 || /payload too large/i.test(err.message)) {
      reply.header('connection', 'close');
      void reply.code(413).send({ success: false, message: 'Payload too large' });
      return;
    }
    if (err.statusCode === 504) {
      reply.log.warn({ service, code: err.code }, 'upstream timeout');
      void reply.code(504).send({ success: false, message: 'Upstream timeout', service });
      return;
    }
    reply.log.warn({ service, code: err.code, reason: err.message }, 'upstream unavailable');
    void reply.code(503).send({ success: false, message: 'Service unavailable', service });
  };

  for (const route of routes) await registerRoute(app, route, { rewriteRequestHeaders, onError, blocked, env });

  return app;
}

interface RouteDeps {
  env: Env;
  blocked: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  rewriteRequestHeaders: (req: ProxiedRequest, headers: IncomingHttpHeaders) => IncomingHttpHeaders;
  onError: (reply: ProxiedReply, error: { error: Error }) => void;
}

async function registerRoute(app: FastifyInstance, route: ResolvedRoute, deps: RouteDeps) {
  const config = { service: route.service, bodyLimit: route.bodyLimit > DEFAULT_BODY_LIMIT ? deps.env.UPLOAD_BODY_LIMIT_BYTES : deps.env.BODY_LIMIT_BYTES };
  if (route.blocked) {
    app.all(route.prefix, { config }, deps.blocked);
    app.all(`${route.prefix}/*`, { config }, deps.blocked);
    return;
  }
  await app.register(httpProxy, {
    upstream: route.url,
    prefix: route.prefix,
    rewritePrefix: route.rewritePrefix,
    http2: false,
    config,
    disableRequestLogging: true,
    undici: { connect: { timeout: deps.env.CONNECT_TIMEOUT_MS }, headersTimeout: deps.env.UPSTREAM_TIMEOUT_MS, bodyTimeout: deps.env.UPSTREAM_TIMEOUT_MS },
    replyOptions: { rewriteRequestHeaders: deps.rewriteRequestHeaders, onError: deps.onError },
  });
}
