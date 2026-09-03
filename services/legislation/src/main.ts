import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Legislation — the legal-instrument register: acts, rules, circulars, notices, orders and conventions, their drafting and approval chain, supersession and amendment links, and the acknowledgement roll' }).catch((err) => { console.error(err); process.exit(1); });
