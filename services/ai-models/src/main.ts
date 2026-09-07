import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'AI models — the model server: fits the platform’s tabular models on its own records with gradient-boosted trees, keeps every fit as a versioned artefact with the metrics read off held-out rows, reports each to the model platform’s registry, and serves an approved version on the contract the platform calls' }).catch((err) => { console.error(err); process.exit(1); });
