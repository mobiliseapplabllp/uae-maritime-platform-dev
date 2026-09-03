import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Ports — vessel calls, berth allocation and conflicts, cargo operations, statements of facts, pro-forma disbursement accounts, berth estate and outages, quay twin, day schedule and marine craft' }).catch((err) => { console.error(err); process.exit(1); });
