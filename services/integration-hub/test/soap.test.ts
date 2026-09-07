import { describe, expect, it } from 'vitest';
import { parseSoapAnswer, parseXml, toData } from '../src/soap';

/* The one counterpart that mandates SOAP answers with an envelope; the services that called it read fields. */
const env = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

describe('integration-hub — reading a SOAP answer', () => {
  it('reads the answer element into fields, a repeated child into a list, and decodes entities', () => {
    const a = parseSoapAnswer(env('<reviewStatusResponse><reference>ICP-REV-2026-A1B2C3</reference><status>CLEARED_WITH_CONDITIONS</status><decidedAt>2026-09-11T09:20:00Z</decidedAt><conditions><condition>Gate &amp; fence to be repaired</condition><condition>Drill records on request</condition></conditions></reviewStatusResponse>'));
    expect(a).toEqual({ reference: 'ICP-REV-2026-A1B2C3', status: 'CLEARED_WITH_CONDITIONS', decidedAt: '2026-09-11T09:20:00Z', conditions: ['Gate & fence to be repaired', 'Drill records on request'] });
  });
  it('keeps a plural field a list when it holds one entry or none, and reads an empty leaf as an empty string', () => {
    expect(parseSoapAnswer(env('<r><conditions><condition>One</condition></conditions><decidedAt></decidedAt></r>'))).toEqual({ conditions: ['One'], decidedAt: '' });
    expect(parseSoapAnswer(env('<r><status>SUBMITTED</status><conditions/></r>'))).toEqual({ status: 'SUBMITTED', conditions: [] });
    expect(parseSoapAnswer(env('<r><status>SUBMITTED</status><conditions></conditions></r>'))).toEqual({ status: 'SUBMITTED', conditions: [] });
  });
  it('reads a fault as a fault, ignores prefixes and attributes, and answers null to anything that is not an envelope', () => {
    expect(parseSoapAnswer(env('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>facilityId is required</faultstring></soap:Fault>'))).toEqual({ fault: { code: 'soap:Client', text: 'facilityId is required' } });
    expect(parseSoapAnswer(env('<ns2:requestReviewResponse xmlns:ns2="urn:icp"><ns2:reference id="7">R-1</ns2:reference></ns2:requestReviewResponse>'))).toEqual({ reference: 'R-1' });
    expect(parseSoapAnswer('{"json": true}')).toBeNull();
    expect(parseSoapAnswer('plain text')).toBeNull();
    expect(parseSoapAnswer(env(''))).toEqual({});
  });
  it('is a small parser, not an XML engine: nesting is bounded and nothing inside a CDATA or a comment is read as markup', () => {
    const deep = `${'<a>'.repeat(80)}x${'</a>'.repeat(80)}`;
    expect(parseXml(deep)).toBeNull();
    const node = parseXml('<r><!-- <secret>no</secret> --><note><![CDATA[<b>bold</b> & more]]></note></r>')!;
    expect(toData(node)).toEqual({ note: '<b>bold</b> & more' });
  });
});
