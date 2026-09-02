import { Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, ServiceOnly, zod } from '@maritime/service-kit';
import type { Env } from './env';
import { RuleEvaluator } from './rules.controller';

const schema = z.object({ key: z.string().optional(), version: z.coerce.number().int().positive().optional(), expr: z.unknown().optional(), context: z.record(z.unknown()).optional().default({}), parameters: z.record(z.unknown()).optional(), now: z.string().datetime().optional() })
  .refine((b) => b.key !== undefined || b.expr !== undefined, { message: 'key or expr is required' });

/** Other services evaluate rule sets (by key) or ad-hoc guard expressions here with the service token; the workflow engine is the main caller. */
@Controller('internal/rules')
export class InternalRulesController {
  private readonly ev: RuleEvaluator;
  constructor(@Inject(KIT_POOL) pool: Pool, @Inject(KIT_ENV) env: Env) { this.ev = new RuleEvaluator(pool, env); }
  @ServiceOnly() @Post('evaluate')
  async evaluate(@Body(zod(schema)) b: z.infer<typeof schema>) {
    if (b.key !== undefined) return this.ev.evaluateByKey(b.key, b.version, b.context, b.now);
    return this.ev.evaluateExpr(b.expr, b.context, b.parameters, b.now);
  }
}
