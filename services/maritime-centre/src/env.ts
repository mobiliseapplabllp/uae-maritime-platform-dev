import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('maritime-centre'),
  PORT: z.coerce.number().default(5424),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_maritime_centre'),
  JURISDICTION: z.string().default('AE'),
  /** Case numbers read `${INC_PREFIX}-YYYY-NNNN`, one atomic series per calendar year. */
  INC_PREFIX: z.string().default('INC'),
  /** Restriction proposal numbers read `${RESTRICTION_PREFIX}-YYYY-NNN`. */
  RESTRICTION_PREFIX: z.string().default('NTM'),
  /** The watch is expected to acknowledge inside this many minutes and resolve inside this many hours. */
  MTTA_TARGET_MIN: z.coerce.number().default(30),
  MTTR_TARGET_HRS: z.coerce.number().default(24),
  /** How much of the chart the traffic picture covers, and how far back the position history runs. */
  PICTURE_ZOOM_KM: z.coerce.number().default(25),
  TRACK_HISTORY_HOURS: z.coerce.number().default(24),
  /** A fix older than this is stale: the target stays on the picture but the watch is told the feed has gone quiet. */
  POSITION_STALE_MIN: z.coerce.number().default(45),
  /** How often the scheduler reads the AIS/LRIT feed; the traffic screen shows it beside the last read. */
  AIS_POLL_MINUTES: z.coerce.number().int().min(1).default(2),
  /** Forces the geodesic path even where PostGIS is installed. Its reason for existing is that the
   *  two implementations must agree: the test suite runs the same queries both ways over the same
   *  rows, and an operator can do the same to check a result they doubt. */
  MC_FORCE_GEODESIC: z.coerce.boolean().default(false),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
