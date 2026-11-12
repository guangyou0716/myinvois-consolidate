import { describe, expect, it } from 'vitest';
import { consolidate } from '../src/consolidate.js';
import { parseReceipts } from '../src/receipts.js';
import { csv, example, NOV_3, supplier } from './helpers.js';

const october = () => parseReceipts(example('receipts-2026-10.csv'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inv = (doc: { json: Record<string, unknown> }) => (doc.json.Invoice as any[])[0];

describe('consolidate', () => {
  it('builds one document with General Public buyer, class 004 and reconciled totals', () => {
    const result = consolidate(october(), supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3 });
    expect(result.documents).toHaveLength(1);
    expect(result.reconciled).toBe(true);
    expect(result.totalsFromReceipts).toEqual({ subtotal: '352.95', tax: '18.14', total: '371.09' });
    expect(result.totalsFromDocuments).toEqual(result.totalsFromReceipts);
    expect(result.submitBy).toBe('2026-11-07');
    expect(result.warnings).toEqual([]);
    const doc = result.documents[0];
    expect(doc.id).toBe('CONS-202610-001');
    const invoice = inv(doc);
    expect(invoice.InvoiceTypeCode[0]).toEqual({ _: '01', listVersionID: '1.0' });
    expect(invoice.IssueDate[0]._).toBe('2026-11-03');
    expect(invoice.IssueTime[0]._).toBe('01:00:00Z');
    expect(invoice.InvoicePeriod[0].StartDate[0]._).toBe('2026-10-01');
    expect(invoice.InvoicePeriod[0].EndDate[0]._).toBe('2026-10-31');
    const buyer = invoice.AccountingCustomerParty[0].Party[0];
    expect(buyer.PartyLegalEntity[0].RegistrationName[0]._).toBe('General Public');
    expect(buyer.PartyIdentification[0].ID[0]).toEqual({ _: 'EI00000000010', schemeID: 'TIN' });
    expect(invoice.LegalMonetaryTotal[0].PayableAmount[0]).toEqual({ _: 371.09, currencyID: 'MYR' });
    // K-0101..K-0102, R-0001..R-0004, R-0007..R-0008
    expect(invoice.InvoiceLine.map((l: { Item: { Description: { _: string }[] }[] }) => l.Item[0].Description[0]._)).toEqual([
      'Receipts K-0101 - K-0102',
      'Receipts R-0001 - R-0004',
      'Receipts R-0007 - R-0008',
    ]);
    for (const line of invoice.InvoiceLine) {
      expect(line.Item[0].CommodityClassification[0].ItemClassificationCode[0]).toEqual({ _: '004', listID: 'CLASS' });
    }
    const taxTypes = invoice.TaxTotal[0].TaxSubtotal.map((s: { TaxCategory: { ID: { _: string }[] }[] }) => s.TaxCategory[0].ID[0]._);
    expect(taxTypes).toEqual(['02', '06']);
    expect(invoice.TaxTotal[0].TaxAmount[0]._).toBe(18.14);
  });

  it('receipt method lists every receipt, by-branch gives one series per branch', () => {
    const result = consolidate(october(), supplier(), { month: '2026-10', method: 'receipt', byBranch: true, issuedAt: NOV_3 });
    expect(result.documents.map((d) => d.id)).toEqual(['CONS-202610-KL1-001', 'CONS-202610-PG1-001']);
    expect(result.documents.map((d) => d.lines)).toEqual([2, 6]);
    expect(result.lines).toBe(8);
    expect(result.reconciled).toBe(true);
  });

  it('by-branch needs a branch on every receipt', () => {
    const receipts = parseReceipts(csv([['A1', '2026-10-01', '1', '06', '0']]));
    expect(() => consolidate(receipts, supplier(), { month: '2026-10', method: 'chain', byBranch: true, issuedAt: NOV_3 })).toThrow(
      /no branch/,
    );
  });

  it('rejects receipts outside the month and a bad month', () => {
    expect(() => consolidate(october(), supplier(), { month: '2026-09', method: 'chain', issuedAt: NOV_3 })).toThrow(
      /8 receipt\(s\) are outside 2026-09: R-0001 \(2026-10-01\), .* and 3 more\.$/,
    );
    expect(() => consolidate(october(), supplier(), { month: '2026-13', method: 'chain', issuedAt: NOV_3 })).toThrow(/YYYY-MM/);
    expect(() => consolidate(october(), supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3, idPrefix: 'a b' })).toThrow(
      /prefix/,
    );
  });

  it('warns when issued before month end or after the 7-day deadline (Malaysia time)', () => {
    const run = (iso: string) => consolidate(october(), supplier(), { month: '2026-10', method: 'chain', issuedAt: new Date(iso) }).warnings;
    expect(run('2026-10-31T15:59:59Z')[0]).toMatch(/before 2026-10 is over/);
    expect(run('2026-10-31T16:00:00Z')).toEqual([]);
    expect(run('2026-11-07T15:59:59Z')).toEqual([]);
    expect(run('2026-11-07T16:00:00Z')[0]).toMatch(/due by 2026-11-07/);
  });

  it('handles December (deadline in January) and February', () => {
    const dec = parseReceipts(csv([['A1', '2026-12-31', '1', '06', '0']]));
    const r = consolidate(dec, supplier(), { month: '2026-12', method: 'chain', issuedAt: new Date('2027-01-02T00:00:00Z') });
    expect([r.periodEnd, r.submitBy]).toEqual(['2026-12-31', '2027-01-07']);
    const feb = parseReceipts(csv([['A1', '2028-02-29', '1', '06', '0']]));
    expect(consolidate(feb, supplier(), { month: '2028-02', method: 'chain', issuedAt: NOV_3 }).periodEnd).toBe('2028-02-29');
  });

  it('splits into several documents under the size limit and keeps totals', () => {
    const rows: string[][] = [];
    for (let i = 1; i <= 400; i++) {
      rows.push([`R-${String(i * 2).padStart(5, '0')}`, '2026-10-10', '1.01', '02', '0.08']);
    }
    const receipts = parseReceipts(csv(rows));
    const result = consolidate(receipts, supplier(), {
      month: '2026-10',
      method: 'chain',
      issuedAt: NOV_3,
      limits: { documentBytes: 60_000, batchDocuments: 3 },
    });
    expect(result.lines).toBe(400); // every other number: no chains
    expect(result.documents.length).toBeGreaterThan(3);
    for (const doc of result.documents) {
      expect(doc.bytes).toBeLessThanOrEqual(60_000);
      expect(Buffer.byteLength(JSON.stringify(doc.json))).toBe(doc.bytes);
    }
    expect(result.documents.map((d) => d.id).slice(0, 2)).toEqual(['CONS-202610-001', 'CONS-202610-002']);
    expect(result.batches.every((b) => b.length <= 3)).toBe(true);
    expect(result.batches.flat()).toEqual(result.documents.map((d) => d.id));
    expect(result.documents.reduce((n, d) => n + d.receipts, 0)).toBe(400);
    expect(result.totalsFromDocuments).toEqual({ subtotal: '404.00', tax: '32.00', total: '436.00' });
    expect(result.reconciled).toBe(true);
  });

  it('fails clearly when one line cannot fit', () => {
    const receipts = parseReceipts(csv([['A1', '2026-10-01', '1', '06', '0']]));
    expect(() =>
      consolidate(receipts, supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3, limits: { documentBytes: 3000 } }),
    ).toThrow(/alone does not fit/);
  });
});
