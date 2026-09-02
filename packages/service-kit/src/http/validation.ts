import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';
/** Explicit Zod validation for bodies and queries: `@Body(zod(schema)) body: z.infer<typeof schema>`. */
@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}
  transform(value: unknown, _meta: ArgumentMetadata) { return this.schema.parse(value); }
}
export const zod = (schema: ZodTypeAny) => new ZodPipe(schema);
