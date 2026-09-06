import 'reflect-metadata';
import { join } from 'node:path';
import { bootstrap } from '@maritime/service-kit';
import { env } from './env';
import { buildAppModule } from './app.module';

const e = env();
bootstrap({ env: e, module: buildAppModule(e), migrationsDir: join(__dirname, '..', 'migrations'), description: 'The governed choke point between the AI layer and the platform: tools allow-listed and quota\'d by caller and tier, executed as a named principal against the platform\'s own APIs; external inference redacted, fenced, classified, fingerprinted and logged' });
