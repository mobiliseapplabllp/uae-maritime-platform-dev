import pino, { Logger } from 'pino';
import { LoggerService } from '@nestjs/common';

export type AppLogger = Logger;
export const createLogger = (name: string, level = 'info'): AppLogger => pino({ name, level, base: { service: name } });

/** Adapts pino to Nest's LoggerService so framework logs share the structured stream. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly pino: AppLogger) {}
  log(message: unknown, ctx?: string) { this.pino.info({ ctx }, String(message)); }
  error(message: unknown, trace?: string, ctx?: string) { this.pino.error({ ctx, trace }, String(message)); }
  warn(message: unknown, ctx?: string) { this.pino.warn({ ctx }, String(message)); }
  debug(message: unknown, ctx?: string) { this.pino.debug({ ctx }, String(message)); }
  verbose(message: unknown, ctx?: string) { this.pino.trace({ ctx }, String(message)); }
}
