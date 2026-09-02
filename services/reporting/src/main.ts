import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Reporting — dashboard, stat cards, search, hover cards and MIS reports over event-fed read models' }).catch((err) => { console.error(err); process.exit(1); });
