import { LocalStorage, type Storage } from './storage';
import { S3Storage } from './s3';
import type { Env } from '../env';

export const STORAGE = 'DOCUMENTS_STORAGE';
export function createStorage(env: Env): Storage {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Storage({ bucket: env.S3_BUCKET ?? '', region: env.S3_REGION, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '', sessionToken: env.S3_SESSION_TOKEN, forcePathStyle: env.S3_FORCE_PATH_STYLE });
  }
  return new LocalStorage(env.STORAGE_DIR);
}
export * from './storage';
export * from './s3';
