import { z } from 'zod';

/** Environment schema shared by every service; services extend it with their own keys. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('service'),
  PORT: z.coerce.number().int().positive().default(5400),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_dev'),
  NATS_URL: z.string().optional(),
  EVENT_BUS: z.enum(['nats', 'memory']).default('memory'),
  AUTH_MODE: z.enum(['local', 'keycloak']).default('local'),
  JWT_SECRET: z.string().min(8).default('development-only-secret-change-me'),
  JWT_ISSUER: z.string().default('maritime-platform'),
  JWT_EXPIRES_IN_SEC: z.coerce.number().default(12 * 3600),
  JWT_REFRESH_EXPIRES_IN_SEC: z.coerce.number().default(7 * 24 * 3600),
  KEYCLOAK_ISSUER: z.string().optional(),
  KEYCLOAK_JWKS_URI: z.string().optional(),
  KEYCLOAK_AUDIENCE: z.string().optional(),
  SERVICE_TOKEN: z.string().default('development-service-token'),
  IDENTITY_URL: z.string().default('http://127.0.0.1:5401'),
  MDM_URL: z.string().default('http://127.0.0.1:5402'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5300,http://127.0.0.1:5300'),
  JSON_LIMIT: z.string().default('2mb'),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(600),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export function loadEnv<S extends z.ZodTypeAny>(schema: S, source: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
