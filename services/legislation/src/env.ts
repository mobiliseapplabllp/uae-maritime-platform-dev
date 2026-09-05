import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('legislation'),
  PORT: z.coerce.number().default(5423),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_legislation'),
  JURISDICTION: z.string().default('AE'),
  /** Reference numbers the register allocates read `${prefix}-NN/YYYY`, one atomic series per type per calendar year; the prefix is the type master's. */
  REF_PAD: z.coerce.number().default(2),
  /** How long a recipient has to acknowledge a mandatory instrument when it does not set its own period. */
  ACK_DUE_DAYS: z.coerce.number().default(14),
  /** An instrument whose effective or expiry date falls inside this window is reported as coming up on the register dashboard. */
  HORIZON_DAYS: z.coerce.number().default(60),
  /** Where the public portal is served from: the citable address of an instrument is `${base}${path}/${slug}`. */
  PUBLIC_BASE_URL: z.string().default('https://maritime.example'),
  PUBLIC_PORTAL_PATH: z.string().default('/law'),
  /** How long a public answer may be cached by a browser or a proxy; the ETag lets a client revalidate for free. */
  PORTAL_CACHE_SECONDS: z.coerce.number().int().min(0).default(300),
  /** The public change feed covers this many days back. */
  PORTAL_FEED_DAYS: z.coerce.number().int().min(1).default(90),
  /** The integration hub, through which the IMO sources are read; and the adapter that reads them. */
  INTEGRATION_HUB_URL: z.string().default('http://127.0.0.1:5412'),
  IMO_SOURCE_ADAPTER: z.string().default('gisis'),
  /** A source polled for the first time is read this far back. */
  IMO_DEFAULT_SINCE_DAYS: z.coerce.number().int().min(1).default(90),
  /** How long the desk has to assess a new watch item before it reads as overdue. */
  IMO_ASSESS_DAYS: z.coerce.number().int().min(1).default(30),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
