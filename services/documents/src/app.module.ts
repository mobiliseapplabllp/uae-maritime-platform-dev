import { Module, type Provider } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { DocumentsController } from './documents.controller';
import { FilesController } from './files.controller';
import { InternalDocumentsController } from './internal.controller';
import { DocumentsService } from './documents.service';
import { RetentionConsumer } from './retention';
import { STORAGE, createStorage } from './storage';
import { SCANNER, createScanner } from './scanner';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver }), MulterModule.register({ storage: memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 } })],
    controllers: [DocumentsController, FilesController, InternalDocumentsController],
    providers: [{ provide: STORAGE, useFactory: () => createStorage(env) }, { provide: SCANNER, useFactory: () => createScanner(env) }, DocumentsService, RetentionConsumer],
  })
  class AppModule {}
  return AppModule;
}
