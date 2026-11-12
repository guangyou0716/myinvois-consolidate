import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { consolidate } from '../src/consolidate.js';
import { InputError } from '../src/errors.js';
import { parseReceipts } from '../src/receipts.js';
import { parseOriginal, refundNote, refundTextReport } from '../src/refund.js';
import { csv, example, NOV_3, root, supplier } from './helpers.js';

const UUID = 'F9D425P6DS7D8IU5ABCDEF1234';
const NOV_20 = new Date('2026-11-20T02:00:00Z');
const refunds = () => parseReceipts(example('refunds-2026-10.csv'));
const originalJson = () =>
  JSON.stringify(consolidate(parseReceipts(example('receipts-2026-10.csv')), supplier(), { month: '2026-10', method: 'chain', issuedAt: NOV_3 }).documents[0].json);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('refundNote', () => {
  it('builds a type 04 refund note referencing the original ID and UUID', () => {
    const result = refundNote(refunds(), supplier(), { month: '2026-10', original: { id: 'CONS-202610-001', uuid: UUID }, issuedAt: NOV_20 });
    const inv = (result.json as Json).Invoice[0];
    expect(result.id).toBe('RN-CONS-202610-001');
    expect(inv.InvoiceTypeCode[0]).toEqual({ _: '04', listVersionID: '1.0' });
    expect(inv.BillingReference).toEqual([{ InvoiceDocumentReference: [{ ID: [{ _: 'CONS-202610-001' }], UUID: [{ _: UUID }] }] }]);
    expect(Object.keys(inv).indexOf('BillingReference')).toBe(Object.keys(inv).indexOf('InvoicePeriod') + 1);
    expect(inv.AccountingCustomerParty[0].Party[0].PartyLegalEntity[0].RegistrationName[0]._).toBe('General Public');
    expect(inv.InvoiceLine.map((l: Json) => l.Item[0].Description[0]._)).toEqual(['Refund of receipt K-0101', 'Refund of receipt R-0003']);
    expect(inv.LegalMonetaryTotal[0].PayableAmount[0]._).toBe(141.3);
    expect(result.totals).toEqual({ subtotal: '133.30', tax: '8.00', total: '141.30' });
    expect(result.checkedAgainstOriginal).toBe(false);
    expect(result.warnings.join(' ')).toContain('Not checked against the original document');
  });

  it('an invoice built by consolidate stays type 01 without BillingReference', () => {
    const inv = (JSON.parse(originalJson()) as Json).Invoice[0];
    expect(inv.InvoiceTypeCode[0]._).toBe('01');
    expect(inv.BillingReference).toBeUndefined();
  });

  it('checks against the original document', () => {
    const doc = parseOriginal(originalJson());
    expect(doc).toMatchObject({ id: 'CONS-202610-001', periodStart: '2026-10-01', periodEnd: '2026-10-31', payable: 37109n });
    const result = refundNote(refunds(), supplier(), { month: '2026-10', original: { id: doc.id, uuid: UUID }, originalDocument: doc, issuedAt: NOV_20 });
    expect(result.checkedAgainstOriginal).toBe(true);
    expect(result.warnings).toEqual([]);
    const opts = (over: Partial<typeof doc>) => ({ month: '2026-10', original: { id: doc.id, uuid: UUID }, originalDocument: { ...doc, ...over }, issuedAt: NOV_20 });
    expect(() => refundNote(refunds(), supplier(), opts({ payable: 14129n }))).toThrow(/more than the original e-Invoice payable amount RM141.29/);
    expect(() => refundNote(refunds(), supplier(), opts({ supplierTin: 'C9999999999' }))).toThrow(/supplier TIN/);
    expect(() => refundNote(refunds(), supplier(), opts({ periodStart: '2026-09-01', periodEnd: '2026-09-30' }))).toThrow(/covers 2026-09-01/);
  });

  it('rejects originals that are not a MYR Invoice', () => {
    const doc = JSON.parse(originalJson()) as Json;
    doc.Invoice[0].InvoiceTypeCode[0]._ = '04';
    expect(() => parseOriginal(JSON.stringify(doc))).toThrow(/must refer to an Invoice \(01\)/);
    expect(() => parseOriginal('<Invoice/>')).toThrow(/use --original-id/);
    expect(() => parseOriginal('{}')).toThrow(/no Invoice element/);
  });

  it('validates the reference, ID, month and amounts', () => {
    const base = { month: '2026-10', original: { id: 'CONS-202610-001', uuid: UUID }, issuedAt: NOV_20 };
    expect(() => refundNote(refunds(), supplier(), { ...base, original: { id: 'X', uuid: 'has space' } })).toThrow(/UUID must be 1 to 26/);
    expect(() => refundNote(refunds(), supplier(), { ...base, original: { id: 'X', uuid: 'A'.repeat(27) } })).toThrow(/UUID must be 1 to 26/);
    expect(() => refundNote(refunds(), supplier(), { ...base, id: 'CONS-202610-001' })).toThrow(/must differ/);
    expect(() => refundNote(refunds(), supplier(), { ...base, id: 'R'.repeat(51) })).toThrow(/1 to 50/);
    expect(() => refundNote(refunds(), supplier(), { ...base, month: '2026-11' })).toThrow(/outside 2026-11, the month of the original/);
    const zero = parseReceipts(csv([['R-1', '2026-10-01', '0', '06', '0']]));
    expect(() => refundNote(zero, supplier(), base)).toThrow(InputError);
    expect(() => refundNote(refunds(), supplier(), { ...base, documentBytes: 1000 })).toThrow(/split the refunds CSV/);
  });

  it('warns when issued inside the consolidated month', () => {
    const r = refundNote(refunds(), supplier(), { month: '2026-10', original: { id: 'C', uuid: UUID }, issuedAt: new Date('2026-10-31T01:00:00Z') });
    expect(r.warnings[0]).toContain('before 2026-10 is over');
    // 00:30 MYT on 1 November is still 31 October in UTC, but the month is over.
    const ok = refundNote(refunds(), supplier(), { month: '2026-10', original: { id: 'C', uuid: UUID }, issuedAt: new Date('2026-10-31T16:30:00Z') });
    expect(ok.warnings.some((w) => w.includes('is over'))).toBe(false);
  });

  it('carries one exemption reason and rejects two', () => {
    const one = parseReceipts(example('receipts-2026-10-exempt.csv'));
    const r = refundNote(one, supplier(), { month: '2026-10', original: { id: 'C', uuid: UUID }, issuedAt: NOV_20 });
    expect(r.exemptionReason).toContain('EXM-2026-001');
    expect(JSON.stringify(r.json)).toContain('TaxExemptionReason');
    const two = parseReceipts(example('receipts-2026-10-exempt-multi.csv'));
    expect(() => refundNote(two, supplier(), { month: '2026-10', original: { id: 'C', uuid: UUID }, issuedAt: NOV_20 })).toThrow(/different exemption reason/);
  });

  it('encodes as XML with BillingReference', () => {
    const r = refundNote(refunds(), supplier(), { month: '2026-10', original: { id: 'C-1', uuid: UUID }, issuedAt: NOV_20, format: 'xml' });
    expect(r.body).toContain('<cbc:InvoiceTypeCode listVersionID="1.0">04</cbc:InvoiceTypeCode>');
    expect(r.body).toContain(`</cac:InvoicePeriod><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>C-1</cbc:ID><cbc:UUID>${UUID}</cbc:UUID>`);
  });
});

describe('cli refund-note', () => {
  afterEach(() => vi.restoreAllMocks());
  const capture = () => {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true));
    return { out: () => out, err: () => err };
  };
  const ex = (n: string) => join(root, 'examples', n);
  const common = ['--supplier', ex('supplier.json'), '--month', '2026-10', '--issued-at', '2026-11-20T10:00:00+08:00'];

  it('writes the refund note checked against the original, then refuses to overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-'));
    capture();
    expect(main(['build', ex('receipts-2026-10.csv'), ...common.slice(0, 4), '--issued-at', '2026-11-03T09:00:00+08:00', '--out', join(dir, 'cons')])).toBe(0);
    const io = capture();
    const args = ['refund-note', ex('refunds-2026-10.csv'), ...common, '--original', join(dir, 'cons', 'CONS-202610-001.json'), '--original-uuid', UUID, '--out', join(dir, 'rn')];
    expect(main(args)).toBe(0);
    expect(io.out()).toContain('Refund total: RM133.30 + tax RM8.00 = RM141.30');
    expect(io.out()).toContain('Checked against the original document.');
    expect(readdirSync(join(dir, 'rn'))).toEqual(['RN-CONS-202610-001.json']);
    expect(JSON.parse(readFileSync(join(dir, 'rn', 'RN-CONS-202610-001.json'), 'utf8')).Invoice[0].InvoiceTypeCode[0]._).toBe('04');
    expect(main(args)).toBe(2);
    expect(io.err()).toContain('refusing to overwrite');
  });

  it('prints a JSON summary with --original-id', () => {
    const io = capture();
    expect(main(['refund-note', ex('refunds-2026-10.csv'), ...common, '--original-id', 'CONS-202610-001', '--original-uuid', UUID, '--id', 'RN-1', '--json'])).toBe(0);
    const summary = JSON.parse(io.out());
    expect(summary).toMatchObject({ id: 'RN-1', file: 'RN-1.json', checkedAgainstOriginal: false, totals: { total: '141.30' } });
    expect(summary.body).toBeUndefined();
  });

  it('rejects bad flag combinations', () => {
    const io = capture();
    const rn = ['refund-note', ex('refunds-2026-10.csv'), ...common];
    expect(main([...rn, '--original-uuid', UUID])).toBe(2);
    expect(main([...rn, '--original-id', 'C', '--original', 'x.json', '--original-uuid', UUID])).toBe(2);
    expect(main([...rn, '--original-id', 'C'])).toBe(2);
    expect(main([...rn, '--original-id', 'C', '--original-uuid', UUID, '--method', 'receipt'])).toBe(2);
    expect(main([...rn, '--original-id', 'C', '--original-uuid', UUID, '--by-branch'])).toBe(2);
    expect(main(['build', ex('receipts-2026-10.csv'), ...common, '--original-uuid', UUID])).toBe(2);
    expect(io.err()).toContain('exactly one of --original');
    expect(io.err()).toContain('needs --original-uuid');
    expect(io.err()).toContain('for build only');
    expect(io.err()).toContain('for refund-note and credit-note only');
  });
});

describe('credit notes (type 02)', () => {
  afterEach(() => vi.restoreAllMocks());
  const credits = () => parseReceipts(example('credits-2026-10.csv'));
  const base = { kind: 'credit' as const, month: '2026-10', original: { id: 'CONS-202610-001', uuid: UUID }, issuedAt: NOV_20 };

  it('builds a type 02 credit note with the same original reference, CN- ID and credit line descriptions', () => {
    const r = refundNote(credits(), supplier(), base);
    const inv = (r.json as Json).Invoice[0];
    expect(r).toMatchObject({ kind: 'credit', typeCode: '02', id: 'CN-CONS-202610-001', receipts: 2, lines: 2, totals: { subtotal: '12.00', tax: '0.80', total: '12.80' } });
    expect(inv.InvoiceTypeCode[0]).toEqual({ _: '02', listVersionID: '1.0' });
    expect(inv.BillingReference[0].InvoiceDocumentReference[0]).toEqual({ ID: [{ _: 'CONS-202610-001' }], UUID: [{ _: UUID }] });
    expect(inv.InvoiceLine.map((l: Json) => l.Item[0].Description[0]._)).toEqual(['Credit for receipt R-0001', 'Credit for receipt R-0007']);
    expect(inv.LegalMonetaryTotal[0].PayableAmount[0]._).toBe(12.8);
  });

  it('refund stays the default kind (type 04, RN-)', () => {
    const r = refundNote(credits(), supplier(), { ...base, kind: undefined });
    expect(r).toMatchObject({ kind: 'refund', typeCode: '04', id: 'RN-CONS-202610-001' });
  });

  it('uses credit wording in errors and the text report', () => {
    expect(() => refundNote(credits(), supplier(), { ...base, id: 'CONS-202610-001' })).toThrow(/credit note ID must differ/);
    expect(() => refundNote(credits(), supplier(), { ...base, documentBytes: 1000 })).toThrow(/split the credits CSV/);
    expect(() => refundNote(credits(), supplier(), { ...base, month: '2026-11' })).toThrow(/in the credits CSV are outside 2026-11/);
    const doc = { id: 'CONS-202610-001', supplierTin: supplier().tin, periodStart: '2026-10-01', periodEnd: '2026-10-31', payable: 1279n };
    expect(() => refundNote(credits(), supplier(), { ...base, originalDocument: doc })).toThrow(/credit note total RM12.80 is more than .* RM12.79/);
    const text = refundTextReport(refundNote(credits(), supplier(), base));
    expect(text).toContain('Credit note CN-CONS-202610-001 (type 02) against consolidated e-Invoice CONS-202610-001');
    expect(text).toContain('Credit total: RM12.00 + tax RM0.80 = RM12.80');
    expect(text).toContain('The credit note is unsigned v1.0 JSON');
  });

  it('writes XML with type 02', () => {
    const r = refundNote(credits(), supplier(), { ...base, format: 'xml' });
    expect(r.body).toContain('<cbc:InvoiceTypeCode listVersionID="1.0">02</cbc:InvoiceTypeCode>');
    expect(r.body).toContain('<cbc:UUID>' + UUID + '</cbc:UUID>');
  });

  it('cli credit-note writes CN-<original>.json checked against the original', () => {
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true));
    const ex = (n: string) => join(root, 'examples', n);
    const dir = mkdtempSync(join(tmpdir(), 'cn-'));
    const common = ['--supplier', ex('supplier.json'), '--month', '2026-10'];
    expect(main(['build', ex('receipts-2026-10.csv'), ...common, '--issued-at', '2026-11-03T09:00:00+08:00', '--out', join(dir, 'cons')])).toBe(0);
    const args = ['credit-note', ex('credits-2026-10.csv'), ...common, '--issued-at', '2026-11-20T10:00:00+08:00', '--original', join(dir, 'cons', 'CONS-202610-001.json'), '--original-uuid', UUID];
    expect(main([...args, '--out', join(dir, 'cn')])).toBe(0);
    expect(out).toContain('Credit total: RM12.00 + tax RM0.80 = RM12.80');
    expect(readdirSync(join(dir, 'cn'))).toEqual(['CN-CONS-202610-001.json']);
    expect(JSON.parse(readFileSync(join(dir, 'cn', 'CN-CONS-202610-001.json'), 'utf8')).Invoice[0].InvoiceTypeCode[0]._).toBe('02');
    expect(main([...args, '--by-branch'])).toBe(2);
    expect(err).toContain('a credit note has one line per receipt');
    expect(main(['credit-note', ex('credits-2026-10.csv'), ...common, '--original-id', 'C'])).toBe(2);
    expect(err).toContain('credit-note needs --original-uuid');
  });
});
