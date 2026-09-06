import type { Provider } from '@nestjs/common';
import { serviceByName, urlOf } from '@maritime/contracts';
import { AiGatewayClient, KIT_ENV } from '@maritime/service-kit';
import type { Env } from './env';

export const GATEWAY_CLIENT = Symbol('GATEWAY_CLIENT');

/* The one path from an agent to a record: the tool gateway. Injected so a test hands in a fake, and so the
 * runtime can be told to conclude without acting (ACTIONS_MODE=off) for a deployment that wants exactly that. */
export const agentProviders: Provider[] = [
  { provide: GATEWAY_CLIENT, useFactory: (env: Env) => new AiGatewayClient(env.AI_TOOL_GATEWAY_URL?.trim() || urlOf(serviceByName('ai-tool-gateway')!, process.env), env.SERVICE_TOKEN, env.AI_TOOL_GATEWAY_TIMEOUT_MS), inject: [KIT_ENV] },
];
/** The gateway the runtime acts through, or nothing when acting is switched off. */
export const actingGateway = (env: Env, gateway: AiGatewayClient) => (env.ACTIONS_MODE === 'gateway' ? gateway : undefined);
