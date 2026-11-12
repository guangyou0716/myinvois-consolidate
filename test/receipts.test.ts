import { describe, expect, it } from 'vitest';
import { exemptionReasonOf, isRealDate, parseReceipts } from '../src/receipts.js';
import { csv, example } from './helpers.js';

describe('parseReceipts', () => {
  it('merges rows of one receipt by tax type', () => {
    const receipts = parseReceipts(example('receipts-2026-10.csv'));
    expect(receipts).toHaveLength(8);
    const r3 = receipts.find((r) => r.receipt === 'R-0003');
    expect(r3?.parts.get('02')).toEqual({ subtotal: 10000n, tax: 800n });
    expect(r3?.parts.get('06')).toEqual({ subtotal: 4000n, tax: 0n });
    expect(r3?.branch).toBe('PG1');
  });
  it('accepts columns in any order and case, with a BOM and CRLF', () => {
    const text = '\ufeffTAX,Receipt,Date,Tax_Type,Subtotal\r\n0,A1,2026-10-01,06,1.00\r\n';
    expect(parseReceipts(text)[0]).toMatchObject({ receipt: 'A1', date: '2026-10-01', branch: '' });
  });
  it('names missing columns', () => {
    expect(() => parseReceipts('receipt,date\nA,2026-10-01')).toThrow(/missing: subtotal, tax_type, tax/);
  });
  it('rejects duplicate receipt + tax type rows', () => {
    const text = csv([['A1', '2026-10-01', '1', '06', '0'], ['A1', '2026-10-01', '2', '06', '0']]);
    expect(() => parseReceipts(text)).toThrow(/data row 2: receipt A1 has tax type 06 twice/);
  });
  it('rejects a receipt repeated with another date', () => {
    const text = csv([['A1', '2026-10-01', '1', '06', '0'], ['A1', '2026-10-02', '2', '02', '0.16']]);
    expect(() => parseReceipts(text)).toThrow(/different date or branch/);
  });
  it('rejects bad dates, tax types, tax on 06, and bad branch codes', () => {
    expect(() => parseReceipts(csv([['A', '2026-02-30', '1', '06', '0']]))).toThrow(/not a real YYYY-MM-DD/);
    expect(() => parseReceipts(csv([['A', '2026-10-01', '1', '07', '0']]))).toThrow(/not one of 01, 02/);
    expect(() => parseReceipts(csv([['A', '2026-10-01', '1', '06', '0.10']]))).toThrow(/must have tax 0/);
    expect(() => parseReceipts(csv([['A', '2026-10-01', '1', '06', '0', 'bad branch']], true))).toThrow(/branch "bad branch"/);
  });
  it('accepts tax type E with an exemption reason (quoted, with commas) and keeps it on the receipt', () => {
    const receipts = parseReceipts(example('receipts-2026-10-exempt.csv'));
    const s1 = receipts.find((r) => r.receipt === 'S-0001');
    expect(s1?.parts.get('E')).toEqual({ subtotal: 1500n, tax: 0n });
    expect(s1?.exemptionReason).toBe('Exempted goods, example reference EXM-2026-001 (synthetic)');
    expect(receipts.find((r) => r.receipt === 'S-0004')?.exemptionReason).toBeUndefined();
    const lower = 'receipt,date,subtotal,tax_type,tax,exemption_reason\nA,2026-10-01,1,e,0,Gazette ref (1)';
    expect([...parseReceipts(lower)[0].parts.keys()]).toEqual(['E']);
  });
  it('rejects tax type E without a reason, with tax, with mixed reasons, and reasons on other types', () => {
    const head = 'receipt,date,subtotal,tax_type,tax,exemption_reason\n';
    expect(() => parseReceipts(csv([['A', '2026-10-01', '1', 'E', '0']]))).toThrow(/needs an exemption_reason/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,E,0, `)).toThrow(/data row 1: tax type E .* needs an exemption_reason/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,E,0.10,X`)).toThrow(/tax type E \(exempt\) must have tax 0/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,E,0,X\nB,2026-10-01,1,E,0,Y`)).toThrow(/data row 2: exemption_reason differs from data row 1/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,06,0,X`)).toThrow(/only allowed on tax type E rows/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,E,0,${'x'.repeat(301)}`)).toThrow(/at most 300 characters/);
    expect(() => parseReceipts(`${head}A,2026-10-01,1,E,0,"two\nlines"`)).toThrow(/one line/);
    expect(parseReceipts(`${head}A,2026-10-01,1,E,0,${'x'.repeat(300)}`)[0].exemptionReason).toHaveLength(300);
  });
  it('exemptionReasonOf checks receipts built in code', () => {
    const part = { subtotal: 100n, tax: 0n };
    const r = (receipt: string, exemptionReason?: string) => ({ receipt, date: '2026-10-01', branch: '', parts: new Map([['E', part]]), exemptionReason });
    expect(exemptionReasonOf([])).toBeUndefined();
    expect(exemptionReasonOf([r('A', ' X '), r('B', 'X')])).toBe('X');
    expect(() => exemptionReasonOf([r('A')])).toThrow(/receipt A has tax type E but no valid exemption reason/);
    expect(() => exemptionReasonOf([r('A', 'a\nb')])).toThrow(/no valid exemption reason/);
    expect(() => exemptionReasonOf([r('A', 'X'), r('B', 'Y')])).toThrow(/receipt B has a different exemption reason/);
  });
  it('rejects ragged rows and empty input', () => {
    expect(() => parseReceipts(csv([['A', '2026-10-01', '1', '06']]))).toThrow(/has 4 fields, header has 5/);
    expect(() => parseReceipts('')).toThrow(/empty/);
    expect(() => parseReceipts('receipt,date,subtotal,tax_type,tax\n')).toThrow(/no receipts/);
  });
  it('checks real dates', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-1-01')).toBe(false);
  });
});
