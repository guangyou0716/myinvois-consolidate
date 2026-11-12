import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseMoney } from './money.js';

/** LHDN tax type codes accepted by this tool (https://sdk.myinvois.hasil.gov.my/codes/tax-types/). `E` (exempt) is not supported yet. */
export const TAX_TYPES: Readonly<Record<string, string>> = {
  '01': 'Sales Tax',
  '02': 'Service Tax',
  '03': 'Tourism Tax',
  '04': 'High-Value Goods Tax',
  '05': 'Sales Tax on Low Value Goods',
  '06': 'Not Applicable',
};

export interface TaxPart {
  /** Amount before tax, in cents. */
  subtotal: bigint;
  /** Tax amount, in cents. */
  tax: bigint;
}

/** One receipt after merging its CSV rows (one row per tax type). */
export interface Receipt {
  receipt: string;
  /** YYYY-MM-DD as written in the CSV. */
  date: string;
  branch: string;
  /** Tax type code -> amounts. */
  parts: Map<string, TaxPart>;
}

const REQUIRED = ['receipt', 'date', 'subtotal', 'tax_type', 'tax'] as const;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BRANCH = /^[A-Za-z0-9_-]{1,10}$/;

export function isRealDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Parses a receipts CSV. Header (any order, case-insensitive): receipt, date, subtotal, tax_type, tax, and
 * optionally branch. A receipt with several tax types has one row per tax type; the rows must share date and branch.
 */
export function parseReceipts(text: string): Receipt[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new InputError('receipts CSV is empty.');
  }
  const header = rows[0].map((name) => name.trim().toLowerCase());
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (index.has(name)) {
      throw new InputError(`receipts CSV header repeats column "${name}".`);
    }
    index.set(name, i);
  });
  const missing = REQUIRED.filter((name) => !index.has(name));
  if (missing.length > 0) {
    throw new InputError(`receipts CSV header is missing: ${missing.join(', ')} (need ${REQUIRED.join(', ')}[, branch]).`);
  }
  const branchAt = index.get('branch');
  const byNumber = new Map<string, Receipt>();
  const order: Receipt[] = [];

  for (let r = 1; r < rows.length; r++) {
    const where = `receipts CSV data row ${r}`;
    const row = rows[r];
    if (row.length !== header.length) {
      throw new InputError(`${where} has ${row.length} fields, header has ${header.length}.`);
    }
    const get = (name: string) => row[index.get(name) as number].trim();
    const receipt = get('receipt');
    if (receipt === '' || receipt.length > 100) {
      throw new InputError(`${where}: receipt number must be 1 to 100 characters.`);
    }
    const date = get('date');
    if (!isRealDate(date)) {
      throw new InputError(`${where}: date "${date}" is not a real YYYY-MM-DD date.`);
    }
    const taxType = get('tax_type');
    if (taxType.toUpperCase() === 'E') {
      throw new InputError(`${where}: tax type E (exempt) is not supported yet; it needs an exemption reason.`);
    }
    if (!(taxType in TAX_TYPES)) {
      throw new InputError(`${where}: tax type "${taxType}" is not one of ${Object.keys(TAX_TYPES).join(', ')}.`);
    }
    const subtotal = parseMoney(get('subtotal'), `${where}: subtotal`);
    const tax = parseMoney(get('tax'), `${where}: tax`);
    if (taxType === '06' && tax !== 0n) {
      throw new InputError(`${where}: tax type 06 (Not Applicable) must have tax 0.`);
    }
    const branch = branchAt === undefined ? '' : row[branchAt].trim();
    if (branch !== '' && !BRANCH.test(branch)) {
      throw new InputError(`${where}: branch "${branch}" must be 1 to 10 letters, digits, "-" or "_".`);
    }

    let entry = byNumber.get(receipt);
    if (entry === undefined) {
      entry = { receipt, date, branch, parts: new Map() };
      byNumber.set(receipt, entry);
      order.push(entry);
    } else {
      if (entry.date !== date || entry.branch !== branch) {
        throw new InputError(`${where}: receipt ${receipt} appears again with a different date or branch.`);
      }
      if (entry.parts.has(taxType)) {
        throw new InputError(`${where}: receipt ${receipt} has tax type ${taxType} twice (duplicate row?).`);
      }
    }
    entry.parts.set(taxType, { subtotal, tax });
  }
  if (order.length === 0) {
    throw new InputError('receipts CSV has a header but no receipts.');
  }
  return order;
}
