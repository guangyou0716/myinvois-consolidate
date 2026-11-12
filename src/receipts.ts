import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseMoney } from './money.js';

/** LHDN tax type codes (https://sdk.myinvois.hasil.gov.my/codes/tax-types/). `E` needs an exemption reason. */
export const TAX_TYPES: Readonly<Record<string, string>> = {
  '01': 'Sales Tax',
  '02': 'Service Tax',
  '03': 'Tourism Tax',
  '04': 'High-Value Goods Tax',
  '05': 'Sales Tax on Low Value Goods',
  '06': 'Not Applicable',
  E: 'Tax exemption (where applicable)',
};

/** MyInvois limit for TaxExemptionReason (Invoice v1.0 "Details of Tax Exemption"). */
export const EXEMPTION_REASON_MAX = 300;

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
  /** Exemption reason of the receipt's tax type E row, if it has one. */
  exemptionReason?: string;
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
 * optionally branch and exemption_reason. A receipt with several tax types has one row per tax type; the rows must
 * share date and branch. Tax type E rows need tax 0 and an exemption reason; every E row in the file must give the
 * same reason, because each consolidated document carries one TaxExemptionReason for type E.
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
    throw new InputError(`receipts CSV header is missing: ${missing.join(', ')} (need ${REQUIRED.join(', ')}[, branch][, exemption_reason]).`);
  }
  const branchAt = index.get('branch');
  const reasonAt = index.get('exemption_reason');
  let firstReason: { reason: string; row: number } | undefined;
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
    const rawType = get('tax_type');
    const taxType = rawType.toUpperCase() === 'E' ? 'E' : rawType;
    if (!(taxType in TAX_TYPES)) {
      throw new InputError(`${where}: tax type "${taxType}" is not one of ${Object.keys(TAX_TYPES).join(', ')}.`);
    }
    const subtotal = parseMoney(get('subtotal'), `${where}: subtotal`);
    const tax = parseMoney(get('tax'), `${where}: tax`);
    if (taxType === '06' && tax !== 0n) {
      throw new InputError(`${where}: tax type 06 (Not Applicable) must have tax 0.`);
    }
    const reason = reasonAt === undefined ? '' : row[reasonAt].trim();
    if (taxType === 'E') {
      if (tax !== 0n) {
        throw new InputError(`${where}: tax type E (exempt) must have tax 0.`);
      }
      if (reason === '') {
        throw new InputError(`${where}: tax type E (exempt) needs an exemption_reason (add the column if it is missing).`);
      }
      if (reason.length > EXEMPTION_REASON_MAX || /[\r\n]/.test(reason)) {
        throw new InputError(`${where}: exemption_reason must be one line of at most ${EXEMPTION_REASON_MAX} characters.`);
      }
      if (firstReason === undefined) {
        firstReason = { reason, row: r };
      } else if (firstReason.reason !== reason) {
        throw new InputError(
          `${where}: exemption_reason differs from data row ${firstReason.row}; one run supports one reason for tax type E ` +
            '(split the receipts into separate runs with different --prefix values).',
        );
      }
    } else if (reason !== '') {
      throw new InputError(`${where}: exemption_reason is only allowed on tax type E rows.`);
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
    if (taxType === 'E') {
      entry.exemptionReason = reason;
    }
  }
  if (order.length === 0) {
    throw new InputError('receipts CSV has a header but no receipts.');
  }
  return order;
}

/**
 * The one exemption reason used by the tax type E receipts, or undefined when none has type E. Throws when E parts
 * have no reason or different reasons (possible for receipts built in code rather than by parseReceipts).
 */
export function exemptionReasonOf(receipts: readonly Receipt[]): string | undefined {
  let found: string | undefined;
  for (const receipt of receipts) {
    if (!receipt.parts.has('E')) {
      continue;
    }
    const reason = receipt.exemptionReason?.trim() ?? '';
    if (reason === '' || reason.length > EXEMPTION_REASON_MAX || /[\r\n]/.test(reason)) {
      throw new InputError(`receipt ${receipt.receipt} has tax type E but no valid exemption reason.`);
    }
    if (found !== undefined && found !== reason) {
      throw new InputError(`receipt ${receipt.receipt} has a different exemption reason; one run supports one reason for tax type E.`);
    }
    found = reason;
  }
  return found;
}
