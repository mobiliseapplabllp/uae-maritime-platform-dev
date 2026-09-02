import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Rules — versioned eligibility, validation, fee and SLA rule sets' }).catch((err) => { console.error(err); process.exit(1); });
