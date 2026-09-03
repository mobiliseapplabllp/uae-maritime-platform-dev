import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Facilities — the regulated-company directory and the port-facility register: standing and the reasons it changed, compliance audits and the rating they move, outstanding obligations, and the renewal work list built from the instruments each subject holds' }).catch((err) => { console.error(err); process.exit(1); });
