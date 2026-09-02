import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { Public } from './auth/guard';
import { Raw } from './http/envelope';

@Controller()
export class HealthController {
  private readonly started = Date.now();
  constructor(@Inject('KIT_SERVICE_NAME') private readonly name: string, @Inject('KIT_POOL') private readonly pool: Pool) {}
  @Public() @Get('health')
  health() { return { status: 'ok', service: this.name, uptimeSec: Math.round((Date.now() - this.started) / 1000), time: new Date().toISOString() }; }
  @Public() @Get('ready')
  async ready() {
    try { await this.pool.query('SELECT 1'); return { status: 'ready', service: this.name }; }
    catch (e) { return new Raw({ success: false, message: `not ready: ${(e as Error).message}` }); }
  }
}
