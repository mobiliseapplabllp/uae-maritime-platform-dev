import type { SettingsClient } from '@maritime/service-kit';
import type { Env } from './env';

/* Settings → AI assistant, read at the moment a question is asked.
 *
 * The switch stops the assistant answering at all; the provider and profile choose which completion client composes and
 * which profile key it reports; grounded-only pins composition to the deterministic composer that writes from the record and
 * nothing else; the temperature is passed to a gateway client and ignored by the composer, which has none; the daily token
 * budget is a ceiling on estimated spend, and the key is handed to the gateway without ever being logged or returned. */

export interface AiSettings { enabled: boolean; provider: 'local' | 'gateway' | string; profile: string; groundedOnly: boolean; temperature: number; dailyTokenBudget: number; apiKey?: string }

const off = (v: unknown) => v === false || String(v).toLowerCase() === 'false';

export async function aiSettingsOf(settings: SettingsClient, env: Env): Promise<AiSettings> {
  const v = await settings.get<Record<string, unknown>>('ai', {});
  const temperature = Number(v.temperature);
  const budget = Number(v.dailyTokenBudget);
  return {
    enabled: !off(v.enabled),
    provider: String(v.provider ?? '').trim() || 'local',
    profile: String(v.model ?? '').trim() || env.COMPLETION_PROFILE,
    groundedOnly: !off(v.groundedOnly ?? true),
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.2,
    dailyTokenBudget: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0,
    apiKey: String(v.apiKey ?? '').trim() || undefined,
  };
}

/** A rough count of what a turn cost: four characters to a token, plus the passages that were retrieved for it. */
export const estimateTokens = (question: string, reply: string, citations: number) => Math.ceil((question.length + reply.length) / 4) + citations * 150;
