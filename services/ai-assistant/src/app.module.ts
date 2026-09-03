import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { AssistantController } from './assistant.controller';
import { ConversationsController } from './conversations.controller';
import { DraftsController } from './drafts.controller';
import { AssistantConsumer } from './consumer';
import { assistantProviders } from './providers';

/* The conversation and draft controllers are registered before the assistant's own surface so their literal
 * prefixes are matched first and never shadowed. */
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver })],
    controllers: [ConversationsController, DraftsController, AssistantController],
    providers: [...assistantProviders, AssistantConsumer],
  })
  class AppModule {}
  return AppModule;
}
