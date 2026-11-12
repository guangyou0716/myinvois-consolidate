import type { Receipt, TaxPart } from './receipts.js';

export type Method = 'receipt' | 'chain';

/** One consolidated e-Invoice line: a single receipt (method a) or a continuous receipt-number chain (method b). */
export interface ConsolidatedLine {
  description: string;
  /** Receipt numbers on this line, in order. */
  receipts: string[];
  parts: Map<string, TaxPart>;
}

interface Numbered {
  prefix: string;
  digits: string;
  value: bigint;
}

/** Splits "R-000123" into prefix "R-" and trailing digits "000123". No trailing digits: null. */
export function splitReceiptNumber(receipt: string): Numbered | null {
  const match = /^(.*?)(\d+)$/.exec(receipt);
  if (!match) {
    return null;
  }
  return { prefix: match[1], digits: match[2], value: BigInt(match[2]) };
}

/**
 * True when `next` directly follows `previous` in a receipt-number chain: same prefix, number + 1, and the
 * same zero-padded width (R-0099 -> R-0100), or no zero padding on either side (R-99 -> R-100).
 */
export function follows(previous: string, next: string): boolean {
  const a = splitReceiptNumber(previous);
  const b = splitReceiptNumber(next);
  if (a === null || b === null || a.prefix !== b.prefix || b.value !== a.value + 1n) {
    return false;
  }
  const padded = (n: Numbered) => n.digits.length > 1 && n.digits.startsWith('0');
  return a.digits.length === b.digits.length || (!padded(a) && !padded(b));
}

/** Natural order: by prefix, then number, then text; receipts without trailing digits sort by text after their prefix group. */
export function compareReceipts(x: string, y: string): number {
  const a = splitReceiptNumber(x);
  const b = splitReceiptNumber(y);
  const pa = a?.prefix ?? x;
  const pb = b?.prefix ?? y;
  if (pa !== pb) {
    return pa < pb ? -1 : 1;
  }
  if (a && b && a.value !== b.value) {
    return a.value < b.value ? -1 : 1;
  }
  if (!a !== !b) {
    return a ? -1 : 1;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

function addParts(target: Map<string, TaxPart>, source: Map<string, TaxPart>): void {
  for (const [type, part] of source) {
    const current = target.get(type);
    if (current) {
      current.subtotal += part.subtotal;
      current.tax += part.tax;
    } else {
      target.set(type, { subtotal: part.subtotal, tax: part.tax });
    }
  }
}

/** Builds lines from receipts (already filtered to one document group), sorted in natural receipt order. */
export function buildLines(receipts: readonly Receipt[], method: Method): ConsolidatedLine[] {
  const sorted = [...receipts].sort((a, b) => compareReceipts(a.receipt, b.receipt));
  const lines: ConsolidatedLine[] = [];
  for (const receipt of sorted) {
    const last = lines[lines.length - 1];
    if (method === 'chain' && last && follows(last.receipts[last.receipts.length - 1], receipt.receipt)) {
      last.receipts.push(receipt.receipt);
      addParts(last.parts, receipt.parts);
      continue;
    }
    const parts = new Map<string, TaxPart>();
    addParts(parts, receipt.parts);
    lines.push({ description: '', receipts: [receipt.receipt], parts });
  }
  for (const line of lines) {
    const first = line.receipts[0];
    const end = line.receipts[line.receipts.length - 1];
    line.description = line.receipts.length === 1 ? `Receipt ${first}` : `Receipts ${first} - ${end}`;
  }
  return lines;
}
