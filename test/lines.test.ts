import { describe, expect, it } from 'vitest';
import { buildLines, compareReceipts, follows, splitReceiptNumber } from '../src/lines.js';
import { parseReceipts } from '../src/receipts.js';
import { csv } from './helpers.js';

describe('receipt chains', () => {
  it('splits prefix and number', () => {
    expect(splitReceiptNumber('R-000123')).toEqual({ prefix: 'R-', digits: '000123', value: 123n });
    expect(splitReceiptNumber('ABC')).toBeNull();
  });
  it('follows only same prefix, +1 and compatible width', () => {
    expect(follows('R-0099', 'R-0100')).toBe(true);
    expect(follows('R-99', 'R-100')).toBe(true);
    expect(follows('R-0001', 'R-0003')).toBe(false);
    expect(follows('R-0001', 'S-0002')).toBe(false);
    expect(follows('R-0009', 'R-10')).toBe(false);
    expect(follows('R-1', 'R-02')).toBe(false);
    expect(follows('X', 'X1')).toBe(false);
  });
  it('sorts naturally, not as text', () => {
    expect(['R-10', 'R-9', 'A-2', 'R-x'].sort(compareReceipts)).toEqual(['A-2', 'R-9', 'R-10', 'R-x']);
  });
  it('chain method: a gap starts a new line, amounts per tax type are summed', () => {
    const receipts = parseReceipts(
      csv([
        ['R-0003', '2026-10-02', '100.00', '02', '8.00'],
        ['R-0001', '2026-10-01', '10.00', '06', '0'],
        ['R-0002', '2026-10-01', '25.50', '06', '0'],
        ['R-0007', '2026-10-15', '60.00', '02', '4.80'],
      ]),
    );
    const lines = buildLines(receipts, 'chain');
    expect(lines.map((l) => l.description)).toEqual(['Receipts R-0001 - R-0003', 'Receipt R-0007']);
    expect(lines[0].receipts).toEqual(['R-0001', 'R-0002', 'R-0003']);
    expect(lines[0].parts.get('06')).toEqual({ subtotal: 3550n, tax: 0n });
    expect(lines[0].parts.get('02')).toEqual({ subtotal: 10000n, tax: 800n });
  });
  it('receipt method: one line per receipt', () => {
    const receipts = parseReceipts(csv([['R-2', '2026-10-01', '1', '06', '0'], ['R-1', '2026-10-01', '2', '06', '0']]));
    expect(buildLines(receipts, 'receipt').map((l) => l.description)).toEqual(['Receipt R-1', 'Receipt R-2']);
  });
  it('does not mutate receipt amounts when summing a chain', () => {
    const receipts = parseReceipts(csv([['R-1', '2026-10-01', '1', '06', '0'], ['R-2', '2026-10-01', '2', '06', '0']]));
    buildLines(receipts, 'chain');
    expect(receipts[0].parts.get('06')).toEqual({ subtotal: 100n, tax: 0n });
  });
});
