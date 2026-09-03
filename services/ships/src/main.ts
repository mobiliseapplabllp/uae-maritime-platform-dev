import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Ships — the fleet record and its certificates, the national ship register with its registration, amendment and closure journeys, and the explainable vessel risk model' }).catch((err) => { console.error(err); process.exit(1); });
