import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('facilities'),
  PORT: z.coerce.number().default(5427),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_facilities'),
  JURISDICTION: z.string().default('AE'),
  /** Audit numbers read `${AUDIT_PREFIX}-YYYY-NNNN`, one atomic series per calendar year. */
  AUDIT_PREFIX: z.string().default('AUD'),
  /** Facility codes the register allocates when an applicant brings none read `${FACILITY_PREFIX}-NNNN`. */
  FACILITY_PREFIX: z.string().default('PF'),
  /** Visit numbers read `${VISIT_PREFIX}-YYYY-NNNN`, one atomic series per calendar year. */
  VISIT_PREFIX: z.string().default('VIS'),
  /** Days before a cycle ends at which a renewal is reminded, when the scheme's master carries none. */
  ACCREDITATION_REMINDER_DAYS: z.string().default('90,30,7'),
  /** An instrument expiring inside this window is on the renewal work list. */
  RENEWAL_WINDOW_DAYS: z.coerce.number().default(90),
  /** How long a company has to clear an obligation raised against it when none is set. */
  OBLIGATION_DUE_DAYS: z.coerce.number().default(30),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
