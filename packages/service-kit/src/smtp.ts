import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/*
 * A small SMTP client — enough to hand a plain-text message to a relay the administration runs, with STARTTLS or
 * implicit TLS and PLAIN/LOGIN authentication, and to prove a profile works before anyone relies on it. It carries no
 * dependency: the platform's mail is short notices, not newsletters, and the relay does the delivery.
 */
export interface SmtpConfig {
  host: string; port?: number;
  /** TLS from the first byte on 465; STARTTLS after the greeting on any other port. Off means plain text, for a lab relay only. */
  secure?: boolean;
  user?: string; password?: string; from?: string; timeoutMs?: number;
  /** Whether the relay's certificate must chain to a trusted authority. Off only for a lab relay with a self-signed certificate. */
  rejectUnauthorized?: boolean;
}
export interface SmtpMessage { to: string; subject: string; text: string; from?: string; replyTo?: string }
export interface SmtpVerifyResult { ok: boolean; detail: string; tls: boolean; authenticated: boolean; durationMs: number }
export interface SmtpSendResult { messageId: string; response: string; tls: boolean; durationMs: number }

export class SmtpError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly stage = '') { super(message); this.name = 'SmtpError'; }
}

/** `Name <addr>` → `addr`; a bare address is returned as is. */
export const addressOf = (v: string) => { const m = /<([^>]+)>/.exec(v); return (m ? m[1] : v).trim(); };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`);
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n');

class Session {
  private sock!: Socket | TLSSocket;
  private buffer = '';
  private pending: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void } | null = null;
  tls = false;
  constructor(private readonly cfg: SmtpConfig) {}
  private get timeout() { return this.cfg.timeoutMs ?? 8000; }

  private attach(sock: Socket | TLSSocket) {
    this.sock = sock; this.buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => { this.buffer += chunk; this.drain(); });
    sock.on('error', (e: Error) => this.pending?.reject(new SmtpError(e.message, null, 'socket')));
    sock.on('close', () => this.pending?.reject(new SmtpError('the relay closed the connection', null, 'socket')));
    sock.setTimeout(this.timeout, () => { this.pending?.reject(new SmtpError(`no answer from the relay within ${this.timeout} ms`, null, 'timeout')); sock.destroy(); });
  }
  /** One SMTP reply: every line reads `NNN-text` until the last, which reads `NNN text`. */
  private drain() {
    for (;;) {
      const end = this.buffer.indexOf('\r\n'); if (end < 0) return;
      const lines = this.buffer.split('\r\n');
      let done = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { done = i; break; }
      if (done < 0) return;
      const reply = lines.slice(0, done + 1); this.buffer = lines.slice(done + 1).join('\r\n');
      const code = Number(reply[done].slice(0, 3));
      const p = this.pending; this.pending = null;
      p?.resolve({ code, lines: reply.map((l) => l.slice(4)) });
      if (!this.pending) return;
    }
  }
  private read(): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.drain(); });
  }
  private async command(line: string, ok: number[], stage: string) {
    const reply = this.read(); this.sock.write(`${line}\r\n`);
    const r = await reply;
    if (!ok.includes(r.code)) throw new SmtpError(`${stage}: ${r.code} ${r.lines.join(' ')}`.trim(), r.code, stage);
    return r;
  }

  async open() {
    const port = this.cfg.port ?? (this.cfg.secure ? 465 : 587);
    const implicit = !!this.cfg.secure && port === 465;
    const sock = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const onError = (e: Error) => reject(new SmtpError(`cannot reach ${this.cfg.host}:${port} — ${e.message}`, null, 'connect'));
      const s = implicit
        ? tlsConnect({ host: this.cfg.host, port, servername: this.cfg.host, rejectUnauthorized: this.cfg.rejectUnauthorized ?? true }, () => resolve(s))
        : netConnect({ host: this.cfg.host, port }, () => resolve(s));
      s.once('error', onError);
      s.setTimeout(this.timeout, () => { reject(new SmtpError(`no connection to ${this.cfg.host}:${port} within ${this.timeout} ms`, null, 'connect')); s.destroy(); });
    });
    this.tls = implicit; this.attach(sock);
    const greeting = await this.read();
    if (greeting.code !== 220) throw new SmtpError(`greeting: ${greeting.code} ${greeting.lines.join(' ')}`, greeting.code, 'greeting');
    let ehlo = await this.command(`EHLO ${hostname() || 'maritime'}`, [250], 'EHLO');
    if (this.cfg.secure && !implicit) {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new SmtpError('the relay does not offer STARTTLS', null, 'STARTTLS');
      await this.command('STARTTLS', [220], 'STARTTLS');
      const plain = this.sock; plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
      const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket: plain, servername: this.cfg.host, rejectUnauthorized: this.cfg.rejectUnauthorized ?? true }, () => resolve(t));
        t.once('error', (e) => reject(new SmtpError(`TLS: ${e.message}`, null, 'STARTTLS')));
      });
      this.tls = true; this.attach(upgraded);
      ehlo = await this.command(`EHLO ${hostname() || 'maritime'}`, [250], 'EHLO');
    }
    return ehlo.lines;
  }
  async authenticate(ehlo: string[]) {
    if (!this.cfg.user) return false;
    const auth = ehlo.find((l) => /^AUTH\b/i.test(l)) ?? '';
    const mechanisms = auth.toUpperCase().split(/[\s=]+/).slice(1);
    if (mechanisms.includes('PLAIN') || !mechanisms.includes('LOGIN')) {
      await this.command(`AUTH PLAIN ${b64(`\0${this.cfg.user}\0${this.cfg.password ?? ''}`)}`, [235], 'AUTH');
    } else {
      await this.command('AUTH LOGIN', [334], 'AUTH');
      await this.command(b64(this.cfg.user), [334], 'AUTH');
      await this.command(b64(this.cfg.password ?? ''), [235], 'AUTH');
    }
    return true;
  }
  async send(m: SmtpMessage) {
    const from = m.from || this.cfg.from || `${this.cfg.user ?? 'maritime'}@${this.cfg.host}`;
    const id = `<${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${addressOf(from).split('@')[1] ?? this.cfg.host}>`;
    await this.command(`MAIL FROM:<${addressOf(from)}>`, [250], 'MAIL FROM');
    await this.command(`RCPT TO:<${addressOf(m.to)}>`, [250, 251], 'RCPT TO');
    await this.command('DATA', [354], 'DATA');
    const headers = [
      `From: ${from}`, `To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`,
      ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    ];
    const body = wrap76(b64(m.text));
    const r = await this.command(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, [250], 'message');
    return { messageId: id, response: r.lines.join(' ') };
  }
  async quit() { try { await this.command('QUIT', [221], 'QUIT'); } catch { /* the relay may have hung up already */ } this.sock.destroy(); }
  close() { this.sock?.destroy(); }
}

/** Connects, negotiates TLS as configured and authenticates, then leaves — the proof a profile is usable. */
export async function smtpVerify(cfg: SmtpConfig): Promise<SmtpVerifyResult> {
  const started = Date.now(); const s = new Session(cfg);
  try {
    const ehlo = await s.open();
    const authenticated = await s.authenticate(ehlo);
    await s.quit();
    const port = cfg.port ?? (cfg.secure ? 465 : 587);
    return { ok: true, tls: s.tls, authenticated, durationMs: Date.now() - started, detail: `Connected to ${cfg.host}:${port}${s.tls ? ' over TLS' : ' in plain text'}${authenticated ? ` and authenticated as ${cfg.user}` : ' without authentication'}.` };
  } catch (e) {
    s.close();
    return { ok: false, tls: s.tls, authenticated: false, durationMs: Date.now() - started, detail: (e as Error).message };
  }
}

/** Hands one message to the relay. Throws an SmtpError naming the stage that refused. */
export async function smtpSend(cfg: SmtpConfig, m: SmtpMessage): Promise<SmtpSendResult> {
  const started = Date.now(); const s = new Session(cfg);
  try {
    const ehlo = await s.open();
    await s.authenticate(ehlo);
    const r = await s.send(m);
    await s.quit();
    return { ...r, tls: s.tls, durationMs: Date.now() - started };
  } catch (e) { s.close(); throw e; }
}
