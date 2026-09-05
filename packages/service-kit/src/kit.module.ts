import { DynamicModule, Global, Module, OnApplicationShutdown, Provider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import type { Pool } from 'pg';
import { createDb, type DbHandle } from './db';
import { createLogger, type AppLogger } from './logger';
import { MemoryBus, NatsBus, type EventBus, type Subscription } from './events/bus';
import { OutboxRelay } from './events/outbox';
import { AuditClient } from './audit';
import { AuthGuard } from './auth/guard';
import { EnvelopeInterceptor } from './http/envelope';
import { HttpPrincipalResolver, PRINCIPAL_RESOLVER, TOKEN_VERIFIER, type PrincipalResolver, type TokenVerifier } from './auth/principal';
import { JwksCache, verifyJwt } from './auth/jwt';
import { HealthController } from './health';
import { TelemetryController } from './telemetry';
import { SettingsClient } from './settings-client';
import { IntegrationClient } from './integration-client';
import { createCache, type Cache } from './cache';
import { createSearch, type SearchAdapter } from './search';
import type { BaseEnv } from './config';
import { EVENTS, subjectFor } from '@maritime/contracts';

export interface KitOptions { env: BaseEnv; principalResolver?: Provider; tokenVerifier?: Provider; extraProviders?: Provider[] }

export const KIT_ENV = 'KIT_ENV';
export const KIT_LOGGER = 'KIT_LOGGER';
export const KIT_POOL = 'KIT_POOL';
export const KIT_DB = 'KIT_DB';
export const KIT_BUS = 'KIT_BUS';
export const KIT_RELAY = 'KIT_RELAY';
export const KIT_SETTINGS = 'KIT_SETTINGS';
export const KIT_CACHE = 'KIT_CACHE';
export const KIT_SEARCH = 'KIT_SEARCH';

/**
 * What a service keeps in memory about other services has to be dropped the moment those services say it changed.
 * The principal cache holds a person's permissions and scope for a short while; a role edit or a deactivation must
 * reach every instance at once, not on the next expiry. The settings cache is the same story for a module setting.
 */
export async function startKitWatches(bus: EventBus, resolver: PrincipalResolver, settings: SettingsClient, log: AppLogger): Promise<Subscription[]> {
  const out: Subscription[] = [];
  if (resolver instanceof HttpPrincipalResolver) {
    out.push(await bus.watch([subjectFor(EVENTS.identity.userChanged), subjectFor(EVENTS.identity.roleChanged), subjectFor(EVENTS.identity.sessionRevoked)], async (event) => {
      const d = (event.data ?? {}) as { userId?: string; subject?: string };
      // a role change may touch every account holding it, so the whole cache goes; a user change touches one person
      if (event.type === EVENTS.identity.roleChanged) resolver.invalidate();
      else { if (d.userId) resolver.invalidate(String(d.userId)); if (d.subject) resolver.invalidate(String(d.subject)); if (!d.userId && !d.subject) resolver.invalidate(); }
      log.debug({ type: event.type }, 'principal cache invalidated');
    }));
  }
  out.push(await bus.watch([subjectFor(EVENTS.mdm.settingsChanged)], async (event) => {
    const key = (event.data as { key?: string } | undefined)?.key;
    settings.invalidate(key ? String(key) : undefined);
  }));
  return out;
}

class KitLifecycle implements OnApplicationShutdown {
  private watches: Subscription[] = [];
  constructor(private readonly relay: OutboxRelay, private readonly bus: EventBus, private readonly pool: Pool, private readonly cache: Cache) {}
  attach(watches: Subscription[]) { this.watches = watches; }
  async onApplicationShutdown() {
    for (const w of this.watches) await w.stop().catch(() => undefined);
    this.relay.stop();
    await this.bus.close().catch(() => undefined);
    await this.cache.close().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }
}

/** Wires the shared runtime into a service: config, logger, database, event bus + outbox relay, auth guard, envelope, audit, health. */
@Global()
@Module({})
export class KitModule {
  static forRoot(opts: KitOptions): DynamicModule {
    const { env } = opts;
    const logger = createLogger(env.SERVICE_NAME, env.LOG_LEVEL);
    const handle = createDb(env.DATABASE_URL);
    const tokenVerifier: Provider = opts.tokenVerifier ?? {
      provide: TOKEN_VERIFIER,
      useFactory: (): TokenVerifier => {
        const jwks = env.AUTH_MODE === 'keycloak' && env.KEYCLOAK_JWKS_URI ? new JwksCache(env.KEYCLOAK_JWKS_URI) : undefined;
        return { verify: (token) => verifyJwt(token, env.AUTH_MODE === 'keycloak' ? { jwks, issuer: env.KEYCLOAK_ISSUER, audience: env.KEYCLOAK_AUDIENCE } : { hsSecret: env.JWT_SECRET, issuer: env.JWT_ISSUER }) };
      },
    };
    const principalResolver: Provider = opts.principalResolver ?? {
      provide: PRINCIPAL_RESOLVER,
      useFactory: (): PrincipalResolver => new HttpPrincipalResolver(env.IDENTITY_URL, env.SERVICE_TOKEN),
    };
    const providers: Provider[] = [
      { provide: KIT_ENV, useValue: env },
      { provide: 'KIT_SERVICE_NAME', useValue: env.SERVICE_NAME },
      { provide: 'KIT_SERVICE_TOKEN', useValue: env.SERVICE_TOKEN },
      { provide: KIT_LOGGER, useValue: logger },
      { provide: KIT_POOL, useValue: handle.pool },
      { provide: KIT_DB, useValue: handle.db },
      { provide: KIT_BUS, useFactory: async (): Promise<EventBus> => (env.EVENT_BUS === 'nats' && env.NATS_URL ? NatsBus.connect(env.NATS_URL, logger) : new MemoryBus()) },
      { provide: KIT_RELAY, useFactory: (bus: EventBus) => { const r = new OutboxRelay(handle.pool, bus, logger); r.start(); return r; }, inject: [KIT_BUS] },
      { provide: KIT_SETTINGS, useFactory: () => new SettingsClient(env.MDM_URL, env.SERVICE_TOKEN) },
      { provide: IntegrationClient, useFactory: () => new IntegrationClient(env.INTEGRATION_HUB_URL, env.SERVICE_TOKEN) },
      { provide: KIT_CACHE, useFactory: (): Promise<Cache> => createCache(env, (err) => logger.warn({ err: err.message }, 'cache backend error')) },
      { provide: KIT_SEARCH, useFactory: (): SearchAdapter => createSearch(env, handle.pool, (err) => logger.warn({ err: err.message }, 'search engine unavailable, answering from PostgreSQL')) },
      { provide: KitLifecycle, useFactory: async (relay: OutboxRelay, bus: EventBus, cache: Cache, resolver: PrincipalResolver, settings: SettingsClient) => {
        const life = new KitLifecycle(relay, bus, handle.pool, cache);
        life.attach(await startKitWatches(bus, resolver, settings, logger).catch((e) => { logger.warn({ err: (e as Error).message }, 'kit watches not started'); return []; }));
        return life;
      }, inject: [KIT_RELAY, KIT_BUS, KIT_CACHE, PRINCIPAL_RESOLVER, KIT_SETTINGS] },
      tokenVerifier, principalResolver, AuditClient, Reflector,
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      ...(opts.extraProviders ?? []),
    ];
    return {
      module: KitModule,
      controllers: [HealthController, TelemetryController],
      providers,
      exports: [KIT_ENV, 'KIT_SERVICE_NAME', 'KIT_SERVICE_TOKEN', KIT_LOGGER, KIT_POOL, KIT_DB, KIT_BUS, KIT_RELAY, KIT_SETTINGS, KIT_CACHE, KIT_SEARCH, TOKEN_VERIFIER, PRINCIPAL_RESOLVER, AuditClient, IntegrationClient],
    };
  }
}
export type { DbHandle, AppLogger };
