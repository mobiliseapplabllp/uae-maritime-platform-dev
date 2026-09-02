import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Service engine — catalogue, versioned low-code definitions (DEV → UAT → PROD) and the service-request register' }).catch((err) => { console.error(err); process.exit(1); });
