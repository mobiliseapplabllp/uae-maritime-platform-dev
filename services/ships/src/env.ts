import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ships'),
  PORT: z.coerce.number().default(5421),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ships'),
  JURISDICTION: z.string().default('AE'),
  /** Ledger transactions read `${TRANSACTION_PREFIX}-YYYY-NNNNN`; transcripts `${TRANSCRIPT_PREFIX}-YYYY-NNNNN` — one chronological series each per calendar year. */
  TRANSACTION_PREFIX: z.string().default('RTX'),
  TRANSCRIPT_PREFIX: z.string().default('TOR'),
  /** Registry application numbers read `${REG_PREFIX}-YYYY-NNNNN`, one atomic series per calendar year. */
  REG_PREFIX: z.string().default('REG'),
  /** How many days before expiry a certificate reads EXPIRING rather than VALID. */
  CERT_EXPIRING_DAYS: z.coerce.number().default(30),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
