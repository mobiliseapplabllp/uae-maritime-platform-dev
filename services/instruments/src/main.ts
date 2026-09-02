import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Instruments — licences, permits, certificates, accreditations and endorsements on one lifecycle, Ed25519-signed with public verification' }).catch((err) => { console.error(err); process.exit(1); });
