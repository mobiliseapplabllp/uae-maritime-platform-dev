import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-platform'),
  PORT: z.coerce.number().default(5503),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_platform'),
  JURISDICTION: z.string().default('AE'),
  /**
   * Serving mode. `stub` computes from the platform's own features so the pipelines are exercisable and
   * demonstrable without a model server; `live` calls the configured endpoint. Same shape as the
   * integration hub, and for the same reason: a stub that answers is testable, a stub that throws is not.
   */
  SERVING_MODE: z.enum(['stub', 'live']).default('stub'),
  SERVING_ENDPOINT: z.string().optional(),
  SERVING_TOKEN: z.string().optional(),
  /**
   * The platform's own model server. A deployment whose endpoint is `ai-models://<key>` is served from it, on the
   * service token; it fits the tabular models on the platform's records and answers from a versioned artefact.
   */
  AI_MODELS_URL: z.string().default('http://127.0.0.1:5505'),
  /** Where a document or a recording is read from, as the person asking. */
  DOCUMENTS_URL: z.string().default('http://127.0.0.1:5410'),
  /** The tool gateway, through which a document read may be refined by the hosted provider Settings → AI names — masked and fenced there. */
  AI_TOOL_GATEWAY_URL: z.string().default('http://127.0.0.1:5504'),
  /**
   * Vision: the OCR languages (tesseract's names, joined with `+`; the data ships with the service's dependencies), where the
   * engine keeps its language data, the time one page may take, and whether what stayed unread is sent through the gateway.
   */
  VISION_LANGS: z.string().default('eng+ara'),
  VISION_CACHE_PATH: z.string().default(''),
  VISION_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  VISION_REFINE: z.enum(['off', 'when-unread', 'always']).default('when-unread'),
  /**
   * Speech: a speech model installed on the host, reached as a command. The command and its arguments come from here and
   * nowhere else; `{file}`, `{language}` and `{dir}` are filled in; the command runs without a shell. Unset, the stub answers.
   */
  AI_SPEECH_COMMAND: z.string().default(''),
  AI_SPEECH_ARGS: z.string().default('{file}'),
  AI_SPEECH_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** The RFP's commitment. A request past this is abandoned and recorded as a breach rather than left hanging. */
  INFERENCE_SLA_MS: z.coerce.number().int().positive().default(5000),
  /**
   * Where inference is permitted to happen for a production deployment. A model whose residency is not on
   * this list cannot be deployed to PROD — which turns "UAE-hosted" from a sentence in a proposal into a
   * condition the service enforces.
   */
  ALLOWED_PROD_RESIDENCY: z.string().default('AE'),
  /** The window a drift run looks at, and how many inferences it needs before it will say anything at all. */
  DRIFT_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  DRIFT_MIN_SAMPLE: z.coerce.number().int().positive().default(30),
  /** Population Stability Index thresholds. The conventional reading: below 0.1 stable, 0.25 and above significant. */
  DRIFT_PSI_MODERATE: z.coerce.number().default(0.1),
  DRIFT_PSI_SIGNIFICANT: z.coerce.number().default(0.25),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
export const allowedResidency = (e: Env): string[] => e.ALLOWED_PROD_RESIDENCY.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
