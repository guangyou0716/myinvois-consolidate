import { describe, expect, it } from 'vitest';
import { consolidate } from '../src/consolidate.js';
import { InputError } from '../src/errors.js';
import { parseReceipts } from '../src/receipts.js';
import { elementXml, UBL_NAMESPACES, ublJsonToXml } from '../src/xml.js';
import { csv, example, NOV_3, supplier } from './helpers.js';

const doc = (invoice: Record<string, unknown>) => ({ ...UBL_NAMESPACES, Invoice: [invoice] });

describe('ublJsonToXml', () => {
  it('maps basic components to cbc with attributes and aggregates to cac, in key order', () => {
    const xml = ublJsonToXml(
      doc({
        ID: [{ _: 'A-1' }],
        InvoiceTypeCode: [{ _: '01', listVersionID: '1.0' }],
        InvoicePeriod: [{ StartDate: [{ _: '2026-10-01' }], Description: [{ _: 'Monthly' }] }],
        LegalMonetaryTotal: [{ PayableAmount: [{ _: 12.3, currencyID: 'MYR' }] }],
      }),
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<Invoice xmlns="${UBL_NAMESPACES._D}" xmlns:cac="${UBL_NAMESPACES._A}" xmlns:cbc="${UBL_NAMESPACES._B}">` +
        '<cbc:ID>A-1</cbc:ID><cbc:InvoiceTypeCode listVersionID="1.0">01</cbc:InvoiceTypeCode>' +
        '<cac:InvoicePeriod><cbc:StartDate>2026-10-01</cbc:StartDate><cbc:Description>Monthly</cbc:Description></cac:InvoicePeriod>' +
        '<cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="MYR">12.3</cbc:PayableAmount></cac:LegalMonetaryTotal>' +
        '</Invoice>',
    );
  });

  it('writes repeated occurrences and escapes text and attributes', () => {
    expect(elementXml('AddressLine', [{ Line: [{ _: 'Lot 1 & 2 <A>' }] }, { Line: [{ _: 'Jalan "B"' }] }])).toBe(
      '<cac:AddressLine><cbc:Line>Lot 1 &amp; 2 &lt;A&gt;</cbc:Line></cac:AddressLine>' +
        '<cac:AddressLine><cbc:Line>Jalan "B"</cbc:Line></cac:AddressLine>',
    );
    expect(elementXml('IndustryClassificationCode', [{ _: '1', name: 'Tom & "Jerry"\n<x>' }])).toBe(
      '<cbc:IndustryClassificationCode name="Tom &amp; &quot;Jerry&quot;&#10;&lt;x&gt;">1</cbc:IndustryClassificationCode>',
    );
  });

  it('rejects control characters XML 1.0 cannot carry as an input error', () => {
    expect(() => elementXml('Description', [{ _: 'bad\u0001' }])).toThrow(InputError);
  });

  it('rejects malformed documents', () => {
    expect(() => ublJsonToXml({ Invoice: [{}] })).toThrow(/_D must be/);
    expect(() => ublJsonToXml({ ...UBL_NAMESPACES, CreditNote: [{}] })).toThrow(/root element, Invoice/);
    expect(() => ublJsonToXml({ ...UBL_NAMESPACES, Invoice: [{}, {}] })).toThrow(/one aggregate/);
    expect(() => elementXml('bad name', [])).toThrow(/not a valid UBL/);
    expect(() => elementXml('ID', { _: 'x' })).toThrow(/must be an array/);
    expect(() => elementXml('ID', ['x'])).toThrow(/must be an object/);
    expect(() => elementXml('ID', [{ _: { a: 1 } }])).toThrow(/not a string/);
  });
});

describe('consolidate --format xml', () => {
  it('encodes the same document as XML with Description before CommodityClassification', () => {
    const receipts = parseReceipts(example('receipts-2026-10-exempt.csv'));
    const json = consolidate(receipts, supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3 });
    const xml = consolidate(receipts, supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3, format: 'xml' });
    expect(json.format).toBe('json');
    expect(xml.format).toBe('xml');
    expect(xml.totalsFromDocuments).toEqual(json.totalsFromDocuments);
    const [jd] = json.documents;
    const [xd] = xml.documents;
    expect(jd.body).toBe(JSON.stringify(jd.json));
    expect(xd.json).toEqual(jd.json);
    expect(xd.body).toBe(ublJsonToXml(xd.json));
    expect(xd.bytes).toBe(Buffer.byteLength(xd.body));
    expect(xd.body).toContain('<cbc:TaxExemptionReason>Exempted goods, example reference EXM-2026-001 (synthetic)</cbc:TaxExemptionReason>');
    expect(xd.body).toMatch(/<cac:Item><cbc:Description>[^<]+<\/cbc:Description><cac:CommodityClassification>/);
    expect(xd.body).toContain('<cbc:ID schemeID="TIN">EI00000000010</cbc:ID>');
  });

  it('measures the size limit on the XML encoding', () => {
    const rows: string[][] = [];
    for (let i = 1; i <= 400; i++) {
      rows.push([`R-${String(i * 2).padStart(5, '0')}`, '2026-10-10', '1.01', '02', '0.08']);
    }
    const receipts = parseReceipts(csv(rows));
    const options = { month: '2026-10', method: 'chain' as const, issuedAt: NOV_3, limits: { documentBytes: 60_000 } };
    const json = consolidate(receipts, supplier(), options);
    const xml = consolidate(receipts, supplier(), { ...options, format: 'xml' });
    expect(xml.documents.length).toBeGreaterThan(json.documents.length); // XML is larger, so it splits more
    for (const doc of xml.documents) {
      expect(doc.bytes).toBeLessThanOrEqual(60_000);
      expect(Buffer.byteLength(doc.body)).toBe(doc.bytes);
    }
    expect(xml.totalsFromDocuments).toEqual({ subtotal: '404.00', tax: '32.00', total: '436.00' });
    expect(xml.reconciled).toBe(true);
  });

  it('rejects an unknown format', () => {
    expect(() =>
      consolidate([], supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3, format: 'yaml' as 'json' }),
    ).toThrow(/format must be json or xml/);
  });
});
