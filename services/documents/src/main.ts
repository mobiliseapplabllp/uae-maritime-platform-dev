import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Documents — evidence store, virus scanning, audience permissions, signed links, versions, legal hold and retention' }).catch((err) => { console.error(err); process.exit(1); });
