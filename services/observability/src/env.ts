import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('observability'),
  PORT: z.coerce.number().default(5411),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_observability'),
  /** How often every target is probed. 0 disables the collector (tests, one-off tooling). */
  OBSERVABILITY_TICK_MS: z.coerce.number().int().min(0).default(15000),
  /** Per-probe timeout. Generous enough not to call a slow service dead, short enough that one
   *  unresponsive target cannot stall the whole sweep. */
  OBSERVABILITY_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).default(4000),
  /** Raw samples older than this are deleted after each rollup. Rollups are kept indefinitely. */
  OBSERVABILITY_RAW_RETENTION_HOURS: z.coerce.number().int().min(1).default(48),
  /** Connection to the cluster, used to read database sizes and connection counts. The maintenance
   *  database is enough — sizes come from pg_database, which is cluster-wide. */
  OBSERVABILITY_PG_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/postgres'),
  /** NATS monitoring endpoint (not the client port): /healthz, /varz and /jsz live here. */
  OBSERVABILITY_NATS_MONITOR_URL: z.string().default('http://127.0.0.1:8222'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
