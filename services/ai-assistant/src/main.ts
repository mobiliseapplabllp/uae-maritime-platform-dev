import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Operator assistant — conversations scoped to the asking user, retrieval over the platform\'s own records with citations, permission-bounded tool calls, prompt-injection resistance, and drafting of notices, decision letters and inspection summaries' }).catch((err) => { console.error(err); process.exit(1); });
