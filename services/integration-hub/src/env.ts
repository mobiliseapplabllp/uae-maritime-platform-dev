import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('integration-hub'),
  PORT: z.coerce.number().default(5412),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_integration_hub'),
  /** Base delay for the retry backoff; each attempt doubles it and adds jitter. */
  HUB_RETRY_BASE_MS: z.coerce.number().int().min(10).default(250),
  /** Ceiling on the backoff, so a long outage does not push a retry hours out. */
  HUB_RETRY_MAX_MS: z.coerce.number().int().min(100).default(8000),
  /** Forces every adapter to stub regardless of its stored mode. Set in CI, where no counterpart exists. Read as a
   *  word, so `HUB_FORCE_STUB=false` means what it says rather than "a non-empty string". */
  HUB_FORCE_STUB: z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : v), z.boolean()).default(false),
  /** Seals counterpart credentials and inbound signing keys at rest; the token secret stands in when unset. */
  HUB_KEY: z.string().min(16).optional(),
  /** How far a delivery's signed timestamp may sit from this clock. */
  HUB_INBOUND_SKEW_SEC: z.coerce.number().int().min(30).default(300),
  /** The address counterparts are given for their deliveries, printed beside an adapter's inbound key. */
  PUBLIC_API_URL: z.string().default('http://127.0.0.1:5200/api'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
