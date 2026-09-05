import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('seafarers'),
  PORT: z.coerce.number().default(5422),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_seafarers'),
  JURISDICTION: z.string().default('AE'),
  /** How many days before expiry a document reads EXPIRING rather than VALID. */
  CERT_EXPIRING_DAYS: z.coerce.number().default(30),
  /** The crew desk watches medical certificates on a longer horizon than the rest — a medical cannot be renewed at sea. */
  MEDICAL_EXPIRING_DAYS: z.coerce.number().default(45),
  /** Whether a certificate of competency is checked at sign-on as well as the medical and basic safety training. */
  COC_VERIFY_ON_SIGN_ON: z.coerce.boolean().default(true),
  /** A tour that would outlast a document by fewer than this many days fails the sign-on gate. */
  SIGN_ON_MARGIN_DAYS: z.coerce.number().default(30),
  /** Crew-list numbering: `${prefix}-${year}-${sequence}`. */
  CREW_LIST_PREFIX: z.string().default('CL'),
  /** A crew list short of the safe manning scale cannot be cleared without a written override when this is on. */
  MANNING_STRICT_CLEARANCE: z.coerce.boolean().default(true),
  /** A foreign officer seen on this many national-flag calls without a flag state endorsement is put on watch. */
  FOREIGN_WATCH_APPEARANCES: z.coerce.number().default(3),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
