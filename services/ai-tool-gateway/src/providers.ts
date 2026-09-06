import { FENCE_RULE, fence, type Block } from './policy';

/* The hosted model providers, behind one interface, chosen by Settings → AI.
 *
 * Nothing here names a model: the profile the operator enters in Settings is the model name the provider sees, and
 * what appears in the reply's engine line and the audit trail is that profile key. Two adapters: one speaks the
 * Anthropic Messages API; the other speaks the OpenAI-compatible chat API that the UAE-hosted platforms expose,
 * so a UAE endpoint is configuration rather than code. The residency rule sits above both. */

export type ProviderKind = 'local' | 'anthropic' | 'uae';
export interface ProviderConfig { provider: ProviderKind; profile: string; apiKey?: string; endpoint?: string; residency: 'AE' | 'GLOBAL'; timeoutMs: number; maxOutputTokens: number; anthropicVersion: string }
export interface ChatRequest {
  contract: string; question: string; grounding: Block[]; findings: string[]; refusals: string[];
  history: { role: 'user' | 'assistant'; text: string }[]; language: 'en' | 'ar'; temperature?: number;
}
export interface ChatResult { text: string; tokensIn: number; tokensOut: number }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** The settings as the gateway reads them — the assistant's section, plus the UAE slot and the residency rule. */
export interface AiProviderSettings { provider?: string; model?: string; apiKey?: string; uaeEndpoint?: string; uaeModel?: string; uaeKey?: string; residencyRequired?: boolean | string; preferResident?: boolean | string; temperature?: number | string }
const on = (v: unknown) => v === true || String(v).toLowerCase() === 'true';

/**
 * Which provider answers. The UAE-hosted slot wins whenever it is configured and residency is preferred or required;
 * a residency requirement with no resident endpoint means no external inference at all, which is the safe reading
 * of "data stays in country". Anthropic answers only with a key and a profile; otherwise the answer is composed locally.
 */
export function selectProvider(s: AiProviderSettings, defaults: { timeoutMs: number; maxOutputTokens: number; anthropicVersion: string; anthropicBaseUrl: string }): ProviderConfig {
  const base = { timeoutMs: defaults.timeoutMs, maxOutputTokens: defaults.maxOutputTokens, anthropicVersion: defaults.anthropicVersion };
  const uaeReady = !!(s.uaeEndpoint && String(s.uaeEndpoint).trim() && s.uaeModel && String(s.uaeModel).trim());
  const wants = String(s.provider ?? 'local').trim().toLowerCase();
  const residencyRequired = on(s.residencyRequired); const preferResident = on(s.preferResident) || residencyRequired;
  if (uaeReady && (wants === 'uae' || wants === 'uae-hosted' || preferResident)) return { ...base, provider: 'uae', profile: String(s.uaeModel).trim(), apiKey: String(s.uaeKey ?? '').trim() || undefined, endpoint: String(s.uaeEndpoint).trim().replace(/\/+$/, ''), residency: 'AE' };
  if (residencyRequired) return { ...base, provider: 'local', profile: String(s.model ?? '').trim() || 'platform-local', residency: 'AE' };
  if ((wants === 'anthropic' || wants === 'gateway') && s.apiKey && String(s.apiKey).trim() && s.model && String(s.model).trim()) {
    return { ...base, provider: 'anthropic', profile: String(s.model).trim(), apiKey: String(s.apiKey).trim(), endpoint: defaults.anthropicBaseUrl.replace(/\/+$/, ''), residency: 'GLOBAL' };
  }
  return { ...base, provider: 'local', profile: String(s.model ?? '').trim() || 'platform-local', residency: 'AE' };
}

/** The prompt as every provider sees it: the contract and the fence rule as the system part, the question and the fenced records as the user part. */
export function buildPrompt(req: ChatRequest): { system: string; user: string } {
  const system = `${req.contract}\n${FENCE_RULE}\nAnswer in ${req.language === 'ar' ? 'Arabic' : 'English'}. Keep every citation marker exactly as it appears in the records.`;
  const parts: string[] = [];
  if (req.history.length) parts.push('Earlier in this conversation:\n' + req.history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n'));
  if (req.findings.length) parts.push('Facts already established from the platform\'s records (permission-checked):\n' + req.findings.map((f) => `- ${f}`).join('\n'));
  if (req.refusals.length) parts.push('Not looked at, because the reader lacks the permission:\n' + req.refusals.map((r) => `- ${r}`).join('\n'));
  if (req.grounding.length) parts.push('Records retrieved for this question:\n' + fence(req.grounding));
  parts.push(`Question: ${req.question}`);
  return { system, user: parts.join('\n\n') };
}

const withTimeout = async <T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
};

/** The Anthropic Messages API. */
export async function callAnthropic(cfg: ProviderConfig, prompt: { system: string; user: string }, temperature: number | undefined, fetchFn: FetchLike): Promise<ChatResult> {
  const res = await withTimeout(cfg.timeoutMs, (signal) => fetchFn(`${cfg.endpoint}/v1/messages`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': cfg.anthropicVersion },
    body: JSON.stringify({ model: cfg.profile, max_tokens: cfg.maxOutputTokens, system: prompt.system, messages: [{ role: 'user', content: prompt.user }], ...(temperature === undefined ? {} : { temperature }) }),
  }));
  if (!res.ok) throw new Error(`Provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  if (!text) throw new Error('Provider returned no text');
  return { text, tokensIn: body.usage?.input_tokens ?? 0, tokensOut: body.usage?.output_tokens ?? 0 };
}

/** The OpenAI-compatible chat API the UAE-hosted platforms expose. */
export async function callOpenAiCompatible(cfg: ProviderConfig, prompt: { system: string; user: string }, temperature: number | undefined, fetchFn: FetchLike): Promise<ChatResult> {
  const res = await withTimeout(cfg.timeoutMs, (signal) => fetchFn(`${cfg.endpoint}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.profile, max_tokens: cfg.maxOutputTokens, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], ...(temperature === undefined ? {} : { temperature }) }),
  }));
  if (!res.ok) throw new Error(`Provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const text = (body.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('Provider returned no text');
  return { text, tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
}

export function callProvider(cfg: ProviderConfig, prompt: { system: string; user: string }, temperature: number | undefined, fetchFn: FetchLike): Promise<ChatResult> {
  if (cfg.provider === 'anthropic') return callAnthropic(cfg, prompt, temperature, fetchFn);
  if (cfg.provider === 'uae') return callOpenAiCompatible(cfg, prompt, temperature, fetchFn);
  return Promise.reject(new Error('No hosted provider is configured'));
}
