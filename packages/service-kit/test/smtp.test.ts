import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { smtpSend, smtpVerify, addressOf } from '../src/smtp';

/* A relay that speaks just enough SMTP to be believed: greeting, EHLO with AUTH, PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT.
 * It refuses one password so the client's error reporting is exercised too. */
let server: Server; let port = 0; const received: string[] = [];
beforeAll(async () => {
  server = createServer((sock: Socket) => {
    let data = false; let payload = '';
    sock.write('220 relay.maritime.example ESMTP ready\r\n');
    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (data) {
        payload += text;
        if (payload.includes('\r\n.\r\n')) { data = false; received.push(payload); payload = ''; sock.write('250 2.0.0 queued as 4B1\r\n'); }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-relay.maritime.example\r\n250-SIZE 10485760\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (up.startsWith('AUTH PLAIN')) { const [, user, pass] = Buffer.from(line.split(' ')[2], 'base64').toString('utf8').split('\0'); sock.write(user === 'notifier' && pass === 'right-one' ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n'); }
        else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
        else if (up.startsWith('RCPT TO')) sock.write(up.includes('NOBODY@') ? '550 5.1.1 No such user\r\n' : '250 2.1.5 Ok\r\n');
        else if (up === 'DATA') { data = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (up === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
        else sock.write('502 5.5.2 Command not implemented\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

describe('the SMTP client', () => {
  it('proves a profile by connecting and authenticating, and says exactly what it did', async () => {
    const ok = await smtpVerify({ host: '127.0.0.1', port, secure: false, user: 'notifier', password: 'right-one', timeoutMs: 2000 });
    expect(ok).toMatchObject({ ok: true, tls: false, authenticated: true }); expect(ok.detail).toMatch(/Connected to 127\.0\.0\.1:\d+ in plain text and authenticated as notifier/);
    const anon = await smtpVerify({ host: '127.0.0.1', port, secure: false, timeoutMs: 2000 });
    expect(anon).toMatchObject({ ok: true, authenticated: false });
    const wrong = await smtpVerify({ host: '127.0.0.1', port, secure: false, user: 'notifier', password: 'wrong-one', timeoutMs: 2000 });
    expect(wrong.ok).toBe(false); expect(wrong.detail).toMatch(/AUTH: 535/);
    const nobody = await smtpVerify({ host: '127.0.0.1', port: 1, secure: false, timeoutMs: 1500 });
    expect(nobody.ok).toBe(false); expect(nobody.detail).toMatch(/cannot reach 127\.0\.0\.1:1/);
  });
  it('hands a message over as base64 UTF-8 with the headers a relay expects, and names the stage that refused one', async () => {
    const r = await smtpSend({ host: '127.0.0.1', port, secure: false, user: 'notifier', password: 'right-one', from: 'Maritime Platform <notifications@maritime.example>', timeoutMs: 2000 },
      { to: 'officer@maritime.example', subject: 'Certificate expiring — الشهادة', text: 'Load Line certificate of Ajman Pioneer expires in 12 days.' });
    expect(r.messageId).toMatch(/^<.+@maritime\.example>$/); expect(r.response).toMatch(/queued/);
    const mail = received.at(-1)!;
    expect(mail).toContain('From: Maritime Platform <notifications@maritime.example>'); expect(mail).toContain('To: officer@maritime.example');
    expect(mail).toContain('Subject: =?UTF-8?B?'); expect(mail).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(mail.split('\r\n\r\n')[1].replace(/\r\n\.\r\n[\s\S]*$/, '').replace(/\r\n/g, ''), 'base64').toString('utf8')).toContain('Ajman Pioneer');
    await expect(smtpSend({ host: '127.0.0.1', port, secure: false, timeoutMs: 2000 }, { to: 'nobody@maritime.example', subject: 'x', text: 'y' })).rejects.toThrow(/RCPT TO: 550/);
    expect(addressOf('Maritime Platform <notifications@maritime.example>')).toBe('notifications@maritime.example'); expect(addressOf('a@b.example')).toBe('a@b.example');
  });
});
