import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Actor, TenancyScope } from '@maritime/contracts';

export interface RequestContext { correlationId: string; causationId?: string; actor?: Actor; scope?: TenancyScope; ip?: string; language: string }
const storage = new AsyncLocalStorage<RequestContext>();

export const getContext = (): RequestContext | undefined => storage.getStore();
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
export function setActor(actor: Actor, scope?: TenancyScope) {
  const ctx = storage.getStore();
  if (ctx) { ctx.actor = actor; if (scope) ctx.scope = scope; }
}

/** Express middleware: correlation id in, correlation id out, language negotiated from Accept-Language. */
export function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-correlation-id');
  const correlationId = incoming && /^[A-Za-z0-9._:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  const language = (req.header('accept-language') || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const ctx: RequestContext = { correlationId, causationId: req.header('x-causation-id') || undefined, ip: req.ip, language };
  res.setHeader('x-correlation-id', correlationId);
  storage.run(ctx, () => next());
}
