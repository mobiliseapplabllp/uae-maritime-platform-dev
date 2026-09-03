import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'Maritime centre — the incident desk with its guarded case-file lifecycle, communications, response tasks, documents and root-cause record, and the surveillance picture with live positions, tracks, MDA alerts and restriction proposals' }).catch((err) => { console.error(err); process.exit(1); });
