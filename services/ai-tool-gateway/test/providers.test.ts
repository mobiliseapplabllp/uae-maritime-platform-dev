import { describe, expect, it } from 'vitest';
import { buildPrompt, callAnthropic, callCli, callOpenAiCompatible, callProvider, selectProvider, type ChatRequest, type FetchLike } from '../src/providers';

const defaults = { timeoutMs: 1000, maxOutputTokens: 300, anthropicVersion: '2023-06-01', anthropicBaseUrl: 'https://api.anthropic.com/' };
const req: ChatRequest = {
  contract: 'You are the platform assistant.', question: 'How long did MV Example wait?', language: 'en',
  grounding: [{ marker: 'R1', label: 'Port call', kind: 'port call', text: 'Waited 3.5 h' }], findings: ['Berth 7 is free'], refusals: ['Invoices: needs invoices.view'],
  history: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hello. How may I help?' }],
};

describe('choosing the provider', () => {
  it('composes locally until a hosted provider is configured', () => {
    expect(selectProvider({}, defaults)).toMatchObject({ provider: 'local', residency: 'AE', profile: 'platform-local' });
    expect(selectProvider({ provider: 'anthropic', model: 'profile-a' }, defaults)).toMatchObject({ provider: 'local' });
  });
  it('answers through the hosted provider when a key and a profile are entered, and trims the base address', () => {
    const cfg = selectProvider({ provider: 'anthropic', apiKey: ' k-1 ', model: ' profile-a ' }, defaults);
    expect(cfg).toMatchObject({ provider: 'anthropic', profile: 'profile-a', apiKey: 'k-1', endpoint: 'https://api.anthropic.com', residency: 'GLOBAL', maxOutputTokens: 300 });
    expect(selectProvider({ provider: 'gateway', apiKey: 'k', model: 'p' }, defaults).provider).toBe('anthropic');
  });
  it('prefers the UAE slot once it is entered and residency is preferred, or asked for by name', () => {
    const s = { provider: 'anthropic', apiKey: 'k', model: 'p', uaeEndpoint: 'https://models.example.ae/v1/', uaeModel: 'resident-a', uaeKey: 'u' };
    expect(selectProvider(s, defaults).provider).toBe('anthropic');
    expect(selectProvider({ ...s, preferResident: 'true' }, defaults)).toMatchObject({ provider: 'uae', profile: 'resident-a', endpoint: 'https://models.example.ae/v1', residency: 'AE', apiKey: 'u' });
    expect(selectProvider({ ...s, provider: 'uae' }, defaults).provider).toBe('uae');
    expect(selectProvider({ ...s, provider: 'uae-hosted' }, defaults).provider).toBe('uae');
  });
  it('sends nothing abroad when residency is required and no resident endpoint exists', () => {
    expect(selectProvider({ provider: 'anthropic', apiKey: 'k', model: 'p', residencyRequired: true }, defaults)).toMatchObject({ provider: 'local', residency: 'AE' });
    expect(selectProvider({ provider: 'anthropic', apiKey: 'k', model: 'p', residencyRequired: 'true', uaeEndpoint: 'https://m.example.ae', uaeModel: 'r' }, defaults).provider).toBe('uae');
  });
});

describe('the prompt', () => {
  it('puts the contract and the fence rule in the system part and everything known in the user part', () => {
    const p = buildPrompt(req);
    expect(p.system).toContain('You are the platform assistant.'); expect(p.system).toContain('BEGIN RECORD'); expect(p.system).toContain('Answer in English');
    expect(p.user).toContain('User: Hello'); expect(p.user).toContain('- Berth 7 is free'); expect(p.user).toContain('Invoices: needs invoices.view'); expect(p.user).toContain('BEGIN RECORD R1'); expect(p.user.endsWith('Question: How long did MV Example wait?')).toBe(true);
    expect(buildPrompt({ ...req, language: 'ar' }).system).toContain('Answer in Arabic');
  });
});

const fakeFetch = (reply: unknown, status = 200): { calls: { url: string; init: Parameters<FetchLike>[1] }[]; fetch: FetchLike } => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => reply, text: async () => JSON.stringify(reply) }; };
  return { calls, fetch };
};

describe('the adapters', () => {
  const anthropic = selectProvider({ provider: 'anthropic', apiKey: 'k-1', model: 'profile-a' }, defaults);
  const uae = selectProvider({ provider: 'uae', uaeEndpoint: 'https://models.example.ae/v1', uaeModel: 'resident-a', uaeKey: 'u-1' }, defaults);
  it('speaks the Messages API with the key in the header and the profile as the model', async () => {
    const f = fakeFetch({ content: [{ type: 'text', text: 'Three and a half hours [R1].' }], usage: { input_tokens: 120, output_tokens: 9 } });
    const r = await callAnthropic(anthropic, buildPrompt(req), 0.2, f.fetch);
    expect(r).toEqual({ text: 'Three and a half hours [R1].', tokensIn: 120, tokensOut: 9 });
    expect(f.calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(f.calls[0].init.headers['x-api-key']).toBe('k-1'); expect(f.calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(f.calls[0].init.body ?? ''); expect(body).toMatchObject({ model: 'profile-a', max_tokens: 300, temperature: 0.2 }); expect(body.messages[0].role).toBe('user');
  });
  it('speaks the OpenAI-compatible chat API with a bearer token', async () => {
    const f = fakeFetch({ choices: [{ message: { content: ' Resident answer ' } }], usage: { prompt_tokens: 50, completion_tokens: 4 } });
    const r = await callOpenAiCompatible(uae, buildPrompt(req), undefined, f.fetch);
    expect(r).toEqual({ text: 'Resident answer', tokensIn: 50, tokensOut: 4 });
    expect(f.calls[0].url).toBe('https://models.example.ae/v1/chat/completions'); expect(f.calls[0].init.headers.authorization).toBe('Bearer u-1');
    const body = JSON.parse(f.calls[0].init.body ?? ''); expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']); expect(body.temperature).toBeUndefined();
  });
  it('fails plainly on a provider error or an empty reply, and never for the local composer', async () => {
    await expect(callAnthropic(anthropic, buildPrompt(req), undefined, fakeFetch({ error: 'bad' }, 429).fetch)).rejects.toThrow('Provider answered 429');
    await expect(callOpenAiCompatible(uae, buildPrompt(req), undefined, fakeFetch({ choices: [] }).fetch)).rejects.toThrow('no text');
    await expect(callProvider(selectProvider({}, defaults), buildPrompt(req), undefined, fakeFetch({}).fetch)).rejects.toThrow('No hosted provider');
    expect((await callProvider(uae, buildPrompt(req), undefined, fakeFetch({ choices: [{ message: { content: 'ok' } }] }).fetch)).text).toBe('ok');
  });
});

describe('the command-line provider', () => {
  const cli = { ...defaults, cliCommand: 'node', cliArgs: ['-e', "process.stdout.write('cli:' + process.argv[1].length)"], cliTimeoutMs: 5000 };
  it('exists only where the gateway host names a command, sits abroad for residency, and yields to the residency rule', () => {
    expect(selectProvider({ provider: 'cli' }, defaults).provider).toBe('local');
    expect(selectProvider({ provider: 'cli', model: 'laptop' }, cli)).toMatchObject({ provider: 'cli', profile: 'laptop', endpoint: 'node', cliArgs: cli.cliArgs, residency: 'GLOBAL', timeoutMs: 5000 });
    expect(selectProvider({ provider: 'cli' }, cli).profile).toBe('local-cli');
    expect(selectProvider({ provider: 'cli', residencyRequired: 'true' }, cli).provider).toBe('local');
  });
  it('runs the command without a shell, hands it the prompt as the last argument and reads its output', async () => {
    const cfg = selectProvider({ provider: 'cli' }, cli);
    const prompt = buildPrompt(req);
    const r = await callProvider(cfg, prompt, undefined, (() => { throw new Error('no fetch for a command'); }) as unknown as FetchLike);
    expect(r.text).toBe(`cli:${prompt.system.length + 2 + prompt.user.length}`);
    expect(r.tokensIn).toBeGreaterThan(0); expect(r.tokensOut).toBeGreaterThan(0);
  });
  it('reports a command that fails or says nothing as a failure, never as an answer', async () => {
    await expect(callCli({ ...selectProvider({ provider: 'cli' }, cli), cliArgs: ['-e', 'process.exit(3)'] }, buildPrompt(req))).rejects.toThrow('Command-line provider failed');
    await expect(callCli({ ...selectProvider({ provider: 'cli' }, cli), cliArgs: ['-e', ''] }, buildPrompt(req))).rejects.toThrow('returned no text');
  });
});
