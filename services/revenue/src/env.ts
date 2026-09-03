import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('revenue'),
  PORT: z.coerce.number().default(5428),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_revenue'),
  JURISDICTION: z.string().default('AE'),
  /** Invoice numbers read `${INVOICE_PREFIX}-YYYY-NNNNN`, one atomic series per calendar year. */
  INVOICE_PREFIX: z.string().default('INV'),
  /** Days from issue to due date when the finance module settings carry no term. */
  PAYMENT_TERMS_DAYS: z.coerce.number().default(30),
  /** Raise a pro-forma draft as soon as a vessel berths; the draft is finalised and issued when she sails. */
  PROFORMA_ON_BERTHING: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Days an issued invoice may run past its due date before the overdue sweep announces it again. */
  OVERDUE_REMINDER_DAYS: z.coerce.number().default(7),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
