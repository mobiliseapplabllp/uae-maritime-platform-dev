import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { contextMiddleware } from './context';
import { ApiExceptionFilter } from './http/envelope';
import { runMigrations } from './db';
import { KIT_LOGGER, KIT_POOL } from './kit.module';
import type { AppLogger } from './logger';
import { NestPinoLogger } from './logger';
import type { BaseEnv } from './config';

export interface BootstrapOptions { env: BaseEnv; module: unknown; migrationsDir?: string; description?: string; version?: string }

/** Standard security headers for an API (no HTML is served by services). */
export function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.removeHeader('X-Powered-By');
  next();
}

export async function createApp(opts: BootstrapOptions): Promise<INestApplication> {
  const app = await NestFactory.create(opts.module as never, { bufferLogs: true, bodyParser: false });
  const logger: AppLogger = app.get(KIT_LOGGER);
  app.useLogger(new NestPinoLogger(logger));
  const httpAdapter = app.getHttpAdapter().getInstance() as Express;
  httpAdapter.disable('x-powered-by');
  httpAdapter.set('trust proxy', 1);
  app.use(securityHeaders);
  // The raw bytes are kept beside the parsed body: a signed inbound delivery is verified over what was sent, not
  // over a re-serialisation of it.
  app.use(express.json({ limit: opts.env.JSON_LIMIT, verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: opts.env.JSON_LIMIT }));
  app.use(contextMiddleware);
  app.enableCors({ origin: opts.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean), credentials: false, exposedHeaders: ['x-correlation-id'] });
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle(opts.env.SERVICE_NAME).setDescription(opts.description ?? '').setVersion(opts.version ?? '0.1.0').addBearerAuth().build());
  httpAdapter.get('/openapi.json', (_req, res) => res.json(doc));
  if (opts.migrationsDir) {
    const pool: Pool = app.get(KIT_POOL);
    await runMigrations(pool, opts.migrationsDir, logger);
  }
  return app;
}

export async function bootstrap(opts: BootstrapOptions): Promise<INestApplication> {
  const app = await createApp(opts);
  await app.listen(opts.env.PORT, '0.0.0.0');
  const logger: AppLogger = app.get(KIT_LOGGER);
  logger.info({ port: opts.env.PORT, authMode: opts.env.AUTH_MODE, bus: opts.env.EVENT_BUS }, `${opts.env.SERVICE_NAME} listening`);
  return app;
}
