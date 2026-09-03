import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Inspection — PSC, flag state, ISM, ISPS and MLC surveys with their findings, deficiencies and detentions, versioned checklist templates and the weighted compliance score that closes a survey' }).catch((err) => { console.error(err); process.exit(1); });
