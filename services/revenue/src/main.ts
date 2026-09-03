import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Revenue — tariff master with revision history, invoices raised from vessel calls, pro-forma estimates, issue, payments and cancellation' }).catch((err) => { console.error(err); process.exit(1); });
