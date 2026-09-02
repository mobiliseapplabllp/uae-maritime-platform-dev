import { join } from 'node:path';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

const flag = (def: boolean) => z.string().optional().transform((v) => (v == null || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('documents'),
  PORT: z.coerce.number().default(5410),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_documents'),
  /** `local` writes under STORAGE_DIR (sharded by the first two hex characters of the key); `s3` talks to any S3-compatible object store over its REST API. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default(join(__dirname, '..', '..', '..', '.local', 'storage')),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('me-central-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_SESSION_TOKEN: z.string().optional(),
  S3_FORCE_PATH_STYLE: flag(false),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(1024).default(25),
  /** Signs `/files/<id>?exp=&sig=` links; rotate together with the gateway secret in production. */
  DOCUMENT_URL_SECRET: z.string().min(8).default('development-only-secret-change-me'),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().min(30).max(86400).default(300),
  /** Public base the signed links are built on — the gateway forwards `/api/files` to this service's `/files`. */
  FILES_BASE_URL: z.string().default('http://localhost:5200/api/files'),
  SCANNER_DRIVER: z.enum(['noop', 'clamav']).default('noop'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().default(30000),
  /** Soft-deleted documents without a retention date are purged by the sweep after this many days. */
  PURGE_DELETED_AFTER_DAYS: z.coerce.number().int().min(1).default(30),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
