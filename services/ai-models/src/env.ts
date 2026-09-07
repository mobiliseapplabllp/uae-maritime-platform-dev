import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-models'),
  PORT: z.coerce.number().default(5505),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_models'),
  /** The model platform this server registers a trained version with; the governance of that version stays there. */
  AI_PLATFORM_URL: z.string().default('http://127.0.0.1:5503'),
  /**
   * The learner's defaults. Gradient-boosted trees fit the platform's tabular questions and fit on a laptop in seconds;
   * a training request may narrow any of these, and each run records the parameters it used.
   */
  TRAIN_ROUNDS: z.coerce.number().int().min(1).max(2000).default(150),
  TRAIN_DEPTH: z.coerce.number().int().min(1).max(8).default(3),
  TRAIN_LEARNING_RATE: z.coerce.number().min(0.001).max(1).default(0.1),
  TRAIN_MIN_LEAF: z.coerce.number().int().min(1).default(5),
  /** The share of rows held out to measure the fit; the metrics a version carries are read off these rows, never the fitted ones. */
  TRAIN_HOLDOUT: z.coerce.number().min(0.05).max(0.5).default(0.2),
  TRAIN_SEED: z.coerce.number().int().default(7),
  /** Rounds without the held-out loss improving before a fit stops and keeps its best round; zero fits every round. */
  TRAIN_PATIENCE: z.coerce.number().int().min(0).default(20),
  /** The fewest rows a dataset needs before a fit is attempted at all. */
  TRAIN_MIN_ROWS: z.coerce.number().int().min(10).default(30),
  /** The jurisdiction whose clock the arrival features are read on (the home port's hour and weekday). */
  JURISDICTION: z.string().default('AE'),
  /**
   * The registry is told about every artefact this server holds, on boot and after every fit, so the platform's
   * versions carry the metrics that were actually measured. Boot-time attempts are spaced out while the platform
   * comes up; zero attempts turns the boot-time push off (tests).
   */
  REGISTRY_SYNC_ATTEMPTS: z.coerce.number().int().min(0).default(8),
  REGISTRY_SYNC_INTERVAL_MS: z.coerce.number().int().min(100).default(10_000),
  /** A scheduled retraining fits a model again only when its dataset has grown by at least this many rows. */
  RETRAIN_MIN_NEW_ROWS: z.coerce.number().int().min(1).default(25),
  /** The bands a classification score is read into, the same cut points the platform's own reading uses. */
  BAND_HIGH: z.coerce.number().min(0).max(1).default(0.66),
  BAND_MEDIUM: z.coerce.number().min(0).max(1).default(0.33),
  /** What the targeting model learns to find: a detention, or at least this many deficiencies. */
  TARGETING_POSITIVE_FINDINGS: z.coerce.number().int().min(1).default(3),
  /** The arrival model's label is the hours from the reported ETA to berthing, clipped here so one stranded call does not steer the fit. */
  ETA_LABEL_MAX_HOURS: z.coerce.number().min(1).default(72),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
