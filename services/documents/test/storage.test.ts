import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_SHA256, LocalStorage, S3Storage, StorageObjectNotFound, assertKey, awsEncode, newStorageKey, readAll, sha256Hex, signV4 } from '../src/storage';

// The credentials below are the ones printed in the AWS Signature Version 4 documentation examples; they are not real keys.
const DOC_ACCESS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const DOC_SECRET_KEY = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
const DOC_DATE = new Date('2013-05-24T00:00:00Z');
const base = { region: 'us-east-1', accessKeyId: DOC_ACCESS_KEY, secretAccessKey: DOC_SECRET_KEY, date: DOC_DATE };

describe('SigV4 signer', () => {
  it('reproduces the documented GET Object example (host, range, content hash and date signed)', () => {
    const out = signV4({ ...base, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 });
    expect(out.canonicalRequest).toBe(['GET', '/test.txt', '', 'host:examplebucket.s3.amazonaws.com', 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY_SHA256}`, 'x-amz-date:20130524T000000Z', '', 'host;range;x-amz-content-sha256;x-amz-date', EMPTY_SHA256].join('\n'));
    expect(out.stringToSign).toBe(['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972'].join('\n'));
    expect(out.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(out.headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${DOC_ACCESS_KEY}/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
  });
  it('reproduces the documented PUT Object example, encoding the $ in the key once', () => {
    const body = Buffer.from('Welcome to Amazon S3.');
    expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const out = signV4({ ...base, method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'), headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: sha256Hex(body) });
    expect(out.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(out.stringToSign.split('\n')[3]).toBe('9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d');
    expect(out.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
  it('reproduces the documented GET Bucket Lifecycle example (query parameter without a value)', () => {
    const out = signV4({ ...base, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'), payloadHash: EMPTY_SHA256 });
    expect(out.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(out.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
  it('encodes per RFC 3986 and sorts query parameters', () => {
    expect(awsEncode('test$file.text')).toBe('test%24file.text');
    expect(awsEncode("it's*(1) ok~")).toBe('it%27s%2A%281%29%20ok~');
    expect(awsEncode('a b/c', true)).toBe('a%20b/c');
    const out = signV4({ ...base, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2'), payloadHash: EMPTY_SHA256 });
    expect(out.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
  });
});

describe('local storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maritime-storage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('shards by the first two hex characters, round-trips and reports missing objects', async () => {
    const s = new LocalStorage(dir); const key = newStorageKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(s.pathFor(key)).toBe(join(dir, key.slice(0, 2), key));
    await s.put(key, Buffer.from('hello'), 'text/plain');
    expect(existsSync(join(dir, key.slice(0, 2), key))).toBe(true);
    expect((await readAll(await s.get(key))).toString()).toBe('hello');
    await s.delete(key); await s.delete(key);
    await expect(s.get(key)).rejects.toBeInstanceOf(StorageObjectNotFound);
    expect(() => assertKey('../../etc/passwd')).toThrow('Invalid storage key');
    expect(() => s.pathFor('..')).toThrow('Invalid storage key');
  });
});

describe('S3 storage against an S3-compatible endpoint', () => {
  let server: Server; let port = 0; const objects = new Map<string, { body: Buffer; type: string }>(); const seen: Array<{ method: string; url: string; auth: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks); const auth = String(req.headers.authorization ?? '');
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth });
        const signedOk = /^AWS4-HMAC-SHA256 Credential=minio-access\/\d{8}\/me-central-1\/s3\/aws4_request,SignedHeaders=(content-type;)?host;x-amz-content-sha256;x-amz-date,Signature=[a-f0-9]{64}$/.test(auth);
        if (!signedOk || req.headers['x-amz-content-sha256'] !== sha256Hex(body)) { res.writeHead(403); res.end('SignatureDoesNotMatch'); return; }
        const key = req.url ?? '';
        if (req.method === 'PUT') { objects.set(key, { body, type: String(req.headers['content-type']) }); res.writeHead(200); res.end(); return; }
        if (req.method === 'GET') { const o = objects.get(key); if (!o) { res.writeHead(404); res.end('NoSuchKey'); return; } res.writeHead(200, { 'content-type': o.type }); res.end(o.body); return; }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
        res.writeHead(405); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  it('puts, gets and deletes with path-style URLs and signed headers', async () => {
    const s = new S3Storage({ bucket: 'evidence', region: 'me-central-1', endpoint: `http://127.0.0.1:${port}`, accessKeyId: 'minio-access', secretAccessKey: 'development-only-secret-change-me', forcePathStyle: true });
    const key = newStorageKey();
    expect(s.objectUrl(key).toString()).toBe(`http://127.0.0.1:${port}/evidence/${key}`);
    await s.put(key, Buffer.from('%PDF-1.4 sample'), 'application/pdf');
    expect((await readAll(await s.get(key))).toString()).toBe('%PDF-1.4 sample');
    await s.delete(key);
    await expect(s.get(key)).rejects.toBeInstanceOf(StorageObjectNotFound);
    expect(seen.map((x) => x.method)).toEqual(['PUT', 'GET', 'DELETE', 'GET']);
    expect(seen[0].url).toBe(`/evidence/${key}`);
    expect(seen[0].auth).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
    const virtual = new S3Storage({ bucket: 'evidence', region: 'me-central-1', accessKeyId: 'a', secretAccessKey: 'b' });
    expect(virtual.objectUrl(key).toString()).toBe(`https://evidence.s3.me-central-1.amazonaws.com/${key}`);
  });
});
