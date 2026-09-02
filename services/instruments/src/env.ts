import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('instruments'),
  PORT: z.coerce.number().default(5409),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_instruments'),
  JURISDICTION: z.string().default('AE'),
  /** PKCS#8 PEM of the Ed25519 signing key held in a key store. When absent the key is derived from CERT_SIGNING_SECRET, which must therefore never change once an instrument has been signed. */
  CERT_SIGNING_KEY: z.string().optional(),
  CERT_SIGNING_SECRET: z.string().optional(),
  /** Days before expiry at which the reminder sweep starts notifying. */
  EXPIRY_REMINDER_DAYS: z.coerce.number().default(30),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => {
  const e = loadEnv(envSchema);
  if (e.NODE_ENV === 'production' && !e.CERT_SIGNING_KEY && (e.CERT_SIGNING_SECRET ?? '').length < 32) throw new Error('Unsafe production configuration: CERT_SIGNING_KEY (PEM) or a CERT_SIGNING_SECRET of at least 32 characters is required to sign instruments');
  return e;
};
