import { z } from 'zod';
import { DEFAULT_BODY_LIMIT, HEALTH_TIMEOUT_MS, UPLOAD_BODY_LIMIT, UPSTREAM_TIMEOUT_MS } from './routes';

/**
 * Gateway environment. Upstream URLs (IDENTITY_URL, MDM_URL, ... see SERVICES in routes.ts) pass
 * through untouched, which is why the schema is not strict.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SERVICE_NAME: z.string().default('gateway'),
    PORT: z.coerce.number().int().nonnegative().default(5200),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.string().default('info'),
    CORS_ORIGIN: z.string().default('http://localhost:5300,http://127.0.0.1:5300'),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(DEFAULT_BODY_LIMIT),
    UPLOAD_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(UPLOAD_BODY_LIMIT),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(UPSTREAM_TIMEOUT_MS),
    CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(HEALTH_TIMEOUT_MS),
    /** false (default), true, or a comma-separated list of trusted proxy addresses/CIDRs. */
    TRUST_PROXY: z.string().default('false'),
  })
  .passthrough();
export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function parseTrustProxy(value: string): boolean | string[] {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no') return false;
  if (v === 'true' || v === 'yes' || v === '1') return true;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
