import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('identity-access'),
  PORT: z.coerce.number().default(5401),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_identity'),
  KEYCLOAK_BASE_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().default('maritime'),
  KEYCLOAK_CLIENT_ID: z.string().default('web'),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(10),
  LOGIN_WINDOW_MIN: z.coerce.number().default(15),
  BCRYPT_ROUNDS: z.coerce.number().default(10),
  /** Key material for the authenticator secrets at rest; the JWT secret stands in when unset. */
  MFA_KEY: z.string().optional(),
  /** The issuer name an authenticator app shows beside the account. */
  MFA_ISSUER: z.string().default('Maritime Platform'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
