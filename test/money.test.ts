import { describe, expect, it } from 'vitest';
import { formatMoney, moneyNumber, parseMoney } from '../src/money.js';

describe('money', () => {
  it('parses up to 2 decimals into cents', () => {
    expect(parseMoney('12', 'x')).toBe(1200n);
    expect(parseMoney('12.3', 'x')).toBe(1230n);
    expect(parseMoney(' 0.05 ', 'x')).toBe(5n);
  });
  it('rejects 3 decimals, negatives and junk', () => {
    for (const bad of ['1.234', '-1', '1,000', '', 'abc', '.5']) {
      expect(() => parseMoney(bad, 'subtotal')).toThrow(/subtotal/);
    }
  });
  it('formats and converts exactly', () => {
    expect(formatMoney(5n)).toBe('0.05');
    expect(formatMoney(123456n)).toBe('1234.56');
    expect(moneyNumber(1n + 2n)).toBe(0.03);
    expect(JSON.stringify(moneyNumber(1000000001n))).toBe('10000000.01');
  });
});
