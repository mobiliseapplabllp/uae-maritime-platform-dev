import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'AI/ML infrastructure — the model registry with training runs and versioned approval, serving under a latency budget, drift detection against a registered baseline, and the vision and speech pipelines' }).catch((err) => { console.error(err); process.exit(1); });
