import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { ZodError } from 'zod';
import type { PageMeta } from '@maritime/contracts';
import type { AppLogger } from '../logger';

/** Wrap a list with its page meta so the interceptor emits { success, data, meta }. */
export class Paged<T> { constructor(public readonly data: T[], public readonly meta: PageMeta) {} }
export const paged = <T>(data: T[], meta: PageMeta) => new Paged(data, meta);
/** Return exactly this body (used by public endpoints that must not be wrapped). */
export class Raw { constructor(public readonly body: unknown) {} }

export class ApiError extends HttpException {
  constructor(status: number, message: string, public readonly extra?: Record<string, unknown>) { super({ success: false, message, ...(extra ?? {}) }, status); }
}
export const badRequest = (m: string, extra?: Record<string, unknown>) => new ApiError(400, m, extra);
export const notFound = (m = 'Not found') => new ApiError(404, m);
export const conflict = (m: string) => new ApiError(409, m);
export const forbidden = (m = 'Forbidden') => new ApiError(403, m);
export const unprocessable = (m: string, extra?: Record<string, unknown>) => new ApiError(422, m, extra);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((result) => {
      if (result instanceof Raw) return result.body;
      if (result instanceof Paged) return { success: true, data: result.data, meta: result.meta };
      if (result && typeof result === 'object' && 'success' in (result as object)) return result;
      return { success: true, data: result === undefined ? null : result };
    }));
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly log: AppLogger) {}
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { success: false, message: 'Internal error' };
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'string') body = { success: false, message: r };
      else {
        const o = r as Record<string, unknown>;
        const msg = Array.isArray(o.message) ? (o.message as string[]).join('; ') : (o.message as string) || exception.message;
        body = { ...o, success: false, message: status === 404 && /^Cannot [A-Z]+ /.test(String(msg)) ? 'API route not found' : msg };
        delete body.statusCode; delete body.error;
      }
    } else if (isZodError(exception)) {
      status = 400;
      body = { success: false, message: exception.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
    } else if (isPgError(exception)) {
      const pg = exception as { code: string; constraint?: string; detail?: string };
      if (pg.code === '23505') { status = 409; body = { success: false, message: `Duplicate value${pg.constraint ? ` (${pg.constraint})` : ''}` }; }
      else if (pg.code === '23503') { status = 409; body = { success: false, message: 'Record is referenced by other records' }; }
      else if (pg.code === '22P02' || pg.code === '22007') { status = 400; body = { success: false, message: 'Invalid value' }; }
      else { this.log.error({ err: exception }, 'database error'); }
    } else {
      this.log.error({ err: exception }, 'unhandled error');
    }
    res.status(status).json(body);
  }
}
/** Duck-typed: a ZodError raised by a service's own zod instance (ESM under vitest) must still map to 400. */
const isZodError = (e: unknown): e is ZodError => e instanceof ZodError || (!!e && typeof e === 'object' && (e as { name?: unknown }).name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues));
const isPgError = (e: unknown): boolean => !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);
