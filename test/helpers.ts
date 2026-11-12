import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSupplier } from '../src/supplier.js';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const example = (name: string) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8');
export const supplier = () => parseSupplier(JSON.parse(example('supplier.json')));
export const NOV_3 = new Date('2026-11-03T01:00:00Z');

/** Builds a receipts CSV from rows of [receipt, date, subtotal, taxType, tax, branch?]. */
export function csv(rows: string[][], branch = false): string {
  const header = branch ? 'receipt,date,subtotal,tax_type,tax,branch' : 'receipt,date,subtotal,tax_type,tax';
  return [header, ...rows.map((r) => r.join(','))].join('\n');
}
