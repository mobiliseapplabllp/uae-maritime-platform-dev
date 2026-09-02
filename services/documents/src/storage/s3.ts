import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { StorageObjectNotFound, assertKey, type Storage } from './storage';

/** AWS Signature Version 4 for S3 (header-based, single chunk) implemented on Node crypto — no SDK. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 requires: unreserved characters kept, every other byte percent-encoded with upper-case hex; `/` kept in paths. */
export function awsEncode(value: string, keepSlash = false): string {
  const out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/gi, '/') : out;
}
export const amzDate = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const safeDecode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
export const canonicalPath = (url: URL): string => (url.pathname || '/').split('/').map((seg) => awsEncode(safeDecode(seg))).join('/') || '/';
export function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((v, k) => pairs.push([awsEncode(k), awsEncode(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SigV4Input {
  method: string; url: URL; headers?: Record<string, string>; payloadHash: string; region: string; service?: string;
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; date?: Date;
}
export interface SigV4Output { headers: Record<string, string>; canonicalRequest: string; stringToSign: string; signature: string; signedHeaders: string; credentialScope: string }

/** Signs a request: returns the headers to send (host, x-amz-date, x-amz-content-sha256, authorization, plus the caller's) and the intermediate strings for verification. */
export function signV4(input: SigV4Input): SigV4Output {
  const service = input.service ?? 's3';
  const date = input.date ?? new Date();
  const xAmzDate = amzDate(date);
  const dateStamp = xAmzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers.host = headers.host ?? input.url.host;
  headers['x-amz-date'] = xAmzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(input.url), canonicalQuery(input.url), canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { headers: { ...headers, authorization }, canonicalRequest, stringToSign, signature, signedHeaders, credentialScope };
}

export interface S3Options {
  bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string;
  /** Path-style addressing (`<endpoint>/<bucket>/<key>`) for MinIO and most self-hosted stores; virtual-host style otherwise. */
  forcePathStyle?: boolean;
  fetchImpl?: typeof fetch;
}

/** S3-compatible object storage over the REST API with SigV4 signing; works against AWS, MinIO and the UAE-region stores. */
export class S3Storage implements Storage {
  constructor(private readonly opts: S3Options) {
    if (!opts.bucket) throw new Error('S3 storage needs a bucket');
    if (!opts.accessKeyId || !opts.secretAccessKey) throw new Error('S3 storage needs credentials');
  }
  objectUrl(key: string): URL {
    const encoded = key.split('/').map((s) => awsEncode(s)).join('/');
    if (this.opts.endpoint) {
      const base = new URL(this.opts.endpoint);
      const prefix = base.pathname.replace(/\/+$/, '');
      if (this.opts.forcePathStyle) return new URL(`${base.origin}${prefix}/${this.opts.bucket}/${encoded}`);
      return new URL(`${base.protocol}//${this.opts.bucket}.${base.host}${prefix}/${encoded}`);
    }
    return this.opts.forcePathStyle
      ? new URL(`https://s3.${this.opts.region}.amazonaws.com/${this.opts.bucket}/${encoded}`)
      : new URL(`https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com/${encoded}`);
  }
  private async request(method: string, key: string, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const url = this.objectUrl(key);
    const signed = signV4({ method, url, headers: extra, payloadHash: body ? sha256Hex(body) : EMPTY_SHA256, region: this.opts.region, accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, sessionToken: this.opts.sessionToken });
    const headers = { ...signed.headers };
    delete headers.host; // fetch derives Host from the URL; the signed value is identical
    return (this.opts.fetchImpl ?? fetch)(url, { method, headers, body });
  }
  async put(key: string, body: Buffer, mime: string): Promise<void> {
    const res = await this.request('PUT', assertKey(key), body, { 'content-type': mime });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`S3 PUT failed (${res.status}): ${text.slice(0, 300)}`);
  }
  async get(key: string): Promise<Readable> {
    const res = await this.request('GET', assertKey(key));
    if (res.status === 404) { await res.text().catch(() => ''); throw new StorageObjectNotFound(key); }
    if (!res.ok || !res.body) { const text = await res.text().catch(() => ''); throw new Error(`S3 GET failed (${res.status}): ${text.slice(0, 300)}`); }
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', assertKey(key));
    const text = await res.text().catch(() => '');
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed (${res.status}): ${text.slice(0, 300)}`);
  }
}
