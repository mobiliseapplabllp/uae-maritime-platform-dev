import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Agentic runtime — the mandated agent registry, the autonomy ladder the runtime enforces, the append-only decision register with its explainability and human review, the escalation queue, and drift, bias and service-level monitoring' }).catch((err) => { console.error(err); process.exit(1); });
