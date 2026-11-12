import { InputError } from './errors.js';

const MONEY = /^(\d{1,20})(?:\.(\d{1,2}))?$/;

/** Parses a non-negative amount with at most 2 decimals ("12", "12.3", "12.30") into integer cents. */
export function parseMoney(text: string, what: string): bigint {
  const match = MONEY.exec(text.trim());
  if (!match) {
    throw new InputError(`${what} "${text}" is not a non-negative amount with at most 2 decimals.`);
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/** Formats integer cents as a fixed 2-decimal string, e.g. 12345n -> "123.45". */
export function formatMoney(cents: bigint): string {
  const negative = cents < 0n;
  const digits = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Converts integer cents to the JSON number MyInvois expects. A 2-decimal value below 2^53 / 100
 * round-trips exactly through its shortest decimal form, so the printed JSON shows the same digits.
 */
export function moneyNumber(cents: bigint): number {
  if (cents > 9007199254740991n || cents < -9007199254740991n) {
    throw new InputError(`amount ${formatMoney(cents)} is too large.`);
  }
  return Number(formatMoney(cents));
}
