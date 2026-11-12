import type { DocumentFormat, Totals } from './consolidate.js';
import { LIMITS } from './consolidate.js';
import { InputError } from './errors.js';
import { buildLines } from './lines.js';
import { formatMoney, parseMoney } from './money.js';
import { exemptionReasonOf, type Receipt, type TaxPart } from './receipts.js';
import type { Supplier } from './supplier.js';
import { documentJson, sumParts, type OriginalReference } from './ubl.js';
import { ublJsonToXml } from './xml.js';

/** MyInvois field limits: e-Invoice Code / Number 50 characters, Original e-Invoice Reference Number (UUID) 26. */
const ID_MAX = 50;
const UUID_MAX = 26;

/** The parts of a consolidated e-Invoice JSON (as written by `build`) that a refund note is checked against. */
export interface OriginalDocument {
  id: string;
  supplierTin: string;
  periodStart: string;
  periodEnd: string;
  /** PayableAmount in cents. */
  payable: bigint;
}

export interface RefundNoteOptions {
  /** "YYYY-MM": the month of the consolidated e-Invoice being refunded against; refunded receipts must fall in it. */
  month: string;
  /** Internal ID and MyInvois UUID of the validated consolidated e-Invoice. */
  original: OriginalReference;
  /** The original document itself, when available: enables the supplier, period and amount checks. */
  originalDocument?: OriginalDocument;
  /** Refund note ID, default `RN-<original ID>`. */
  id?: string;
  issuedAt: Date;
  format?: DocumentFormat;
  /** Override the 300 KB document limit (tests). */
  documentBytes?: number;
}

export interface RefundNoteResult {
  id: string;
  month: string;
  format: DocumentFormat;
  original: OriginalReference;
  /** Whether the refund was checked against the original document (supplier, period, amount). */
  checkedAgainstOriginal: boolean;
  receipts: number;
  lines: number;
  issueDate: string;
  issueTime: string;
  totals: Totals;
  byTaxType: Array<{ taxType: string } & Totals>;
  exemptionReason?: string;
  bytes: number;
  json: Record<string, unknown>;
  body: string;
  warnings: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const totals = (subtotal: bigint, tax: bigint): Totals => ({
  subtotal: formatMoney(subtotal),
  tax: formatMoney(tax),
  total: formatMoney(subtotal + tax),
});

type Json = Record<string, unknown>;
function first(obj: unknown, key: string): Json | undefined {
  if (obj === null || typeof obj !== 'object') {
    return undefined;
  }
  const value = (obj as Json)[key];
  return Array.isArray(value) && value.length > 0 && value[0] !== null && typeof value[0] === 'object' ? (value[0] as Json) : undefined;
}
function text(obj: unknown, ...path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    cur = first(cur, key);
  }
  const value = (cur as Json | undefined)?._;
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

/**
 * Reads a consolidated e-Invoice UBL JSON document (an Invoice, type 01, MYR) such as the ones `build` writes.
 * Only JSON is read; for an XML original pass the ID instead.
 */
export function parseOriginal(jsonText: string): OriginalDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (error) {
    throw new InputError(`original document is not valid JSON (${(error as Error).message}); for an XML original use --original-id.`);
  }
  const invoice = first(doc, 'Invoice');
  if (invoice === undefined) {
    throw new InputError('original document has no Invoice element (expected MyInvois UBL JSON).');
  }
  const id = text(invoice, 'ID');
  const type = text(invoice, 'InvoiceTypeCode');
  const currency = text(invoice, 'DocumentCurrencyCode');
  const supplierTin = (() => {
    const party = first(first(invoice, 'AccountingSupplierParty'), 'Party');
    const ids = party === undefined ? [] : (party.PartyIdentification as unknown[] | undefined) ?? [];
    for (const entry of ids) {
      const idEl = first(entry, 'ID');
      if (idEl?.schemeID === 'TIN' && typeof idEl._ === 'string') {
        return idEl._;
      }
    }
    return undefined;
  })();
  const periodStart = text(invoice, 'InvoicePeriod', 'StartDate');
  const periodEnd = text(invoice, 'InvoicePeriod', 'EndDate');
  const payableText = text(invoice, 'LegalMonetaryTotal', 'PayableAmount');
  if (id === undefined || supplierTin === undefined || periodStart === undefined || periodEnd === undefined || payableText === undefined) {
    throw new InputError('original document is missing ID, supplier TIN, InvoicePeriod or PayableAmount.');
  }
  if (type !== '01') {
    throw new InputError(`original document has InvoiceTypeCode ${type ?? '(none)'}; a refund note must refer to an Invoice (01).`);
  }
  if (currency !== 'MYR') {
    throw new InputError(`original document currency is ${currency ?? '(none)'}; only MYR is supported.`);
  }
  return { id, supplierTin, periodStart, periodEnd, payable: parseMoney(payableText, 'original PayableAmount') };
}

/**
 * Builds one unsigned Refund Note (type 04, v1.0) against a validated consolidated e-Invoice, for receipts refunded
 * after that e-Invoice was submitted. Buyer stays "General Public"; one line per refunded receipt.
 */
export function refundNote(refunds: readonly Receipt[], supplier: Supplier, options: RefundNoteOptions): RefundNoteResult {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(options.month);
  if (!match) {
    throw new InputError(`month "${options.month}" must be YYYY-MM.`);
  }
  const { original } = options;
  if (original.id.trim() === '' || original.id.length > ID_MAX) {
    throw new InputError(`original e-Invoice ID must be 1 to ${ID_MAX} characters.`);
  }
  if (!/^[A-Za-z0-9]{1,26}$/.test(original.uuid)) {
    throw new InputError(`original e-Invoice UUID must be 1 to ${UUID_MAX} letters or digits (the UUID MyInvois returned on validation).`);
  }
  const id = options.id ?? `RN-${original.id}`;
  if (id.trim() === '' || id.length > ID_MAX) {
    throw new InputError(`refund note ID "${id}" must be 1 to ${ID_MAX} characters; pass a shorter --id.`);
  }
  if (id === original.id) {
    throw new InputError('refund note ID must differ from the original e-Invoice ID.');
  }
  const format = options.format ?? 'json';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const periodStart = ymd(new Date(Date.UTC(year, month - 1, 1)));
  const periodEnd = ymd(new Date(Date.UTC(year, month, 0)));
  const outside = refunds.filter((r) => r.date < periodStart || r.date > periodEnd);
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map((r) => `${r.receipt} (${r.date})`).join(', ');
    throw new InputError(
      `${outside.length} refunded receipt(s) are outside ${options.month}, the month of the original e-Invoice: ${sample}` +
        `${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}. The date column is the original receipt date.`,
    );
  }
  const exemptionReason = exemptionReasonOf(refunds);
  const lines = buildLines(refunds, 'receipt');
  for (const line of lines) {
    line.description = `Refund of receipt ${line.receipts[0]}`;
  }

  const byType = new Map<string, TaxPart>();
  for (const refund of refunds) {
    for (const [type, part] of refund.parts) {
      const t = byType.get(type) ?? { subtotal: 0n, tax: 0n };
      t.subtotal += part.subtotal;
      t.tax += part.tax;
      byType.set(type, t);
    }
  }
  const sum = sumParts(byType);
  if (sum.subtotal + sum.tax === 0n) {
    throw new InputError('refunds add up to RM0.00; nothing to refund.');
  }

  const origDoc = options.originalDocument;
  if (origDoc !== undefined) {
    if (origDoc.id !== original.id) {
      throw new Error('internal: original document ID differs from the reference ID.');
    }
    if (origDoc.supplierTin !== supplier.tin) {
      throw new InputError(`original e-Invoice supplier TIN ${origDoc.supplierTin} differs from the supplier file (${supplier.tin}).`);
    }
    if (origDoc.periodStart !== periodStart || origDoc.periodEnd !== periodEnd) {
      throw new InputError(`original e-Invoice covers ${origDoc.periodStart} to ${origDoc.periodEnd}, not ${options.month}.`);
    }
    if (sum.subtotal + sum.tax > origDoc.payable) {
      throw new InputError(
        `refund total RM${formatMoney(sum.subtotal + sum.tax)} is more than the original e-Invoice payable amount RM${formatMoney(origDoc.payable)}.`,
      );
    }
  }

  const issueDate = options.issuedAt.toISOString().slice(0, 10);
  const issueTime = `${options.issuedAt.toISOString().slice(11, 19)}Z`;
  const warnings: string[] = [];
  // Malaysia is UTC+8 with no daylight saving time: the month is over at 00:00 MYT on the 1st of the next month.
  if (options.issuedAt.getTime() < Date.UTC(year, month, 1) - 8 * 3600 * 1000) {
    warnings.push(`Issue time is before ${options.month} is over (Malaysia time); a refund note follows the submitted consolidated e-Invoice.`);
  }
  if (origDoc === undefined) {
    warnings.push('Not checked against the original document (pass --original FILE.json to check supplier, period and amount).');
  }
  const json = documentJson({ id, issueDate, issueTime, periodStart, periodEnd }, supplier, lines, exemptionReason, original);
  const body = format === 'xml' ? ublJsonToXml(json) : JSON.stringify(json);
  const bytes = Buffer.byteLength(body, 'utf8');
  const limit = options.documentBytes ?? LIMITS.documentBytes;
  if (bytes > limit) {
    throw new InputError(`refund note is ${bytes} bytes, over the ${limit}-byte document limit; split the refunds CSV into several runs with different --id.`);
  }
  return {
    id,
    month: options.month,
    format,
    original,
    checkedAgainstOriginal: origDoc !== undefined,
    receipts: refunds.length,
    lines: lines.length,
    issueDate,
    issueTime,
    totals: totals(sum.subtotal, sum.tax),
    byTaxType: [...byType.keys()].sort().map((taxType) => {
      const t = byType.get(taxType) as TaxPart;
      return { taxType, ...totals(t.subtotal, t.tax) };
    }),
    ...(exemptionReason === undefined ? {} : { exemptionReason }),
    bytes,
    json,
    body,
    warnings,
  };
}

/** Summary without the document body, for --json and summary output. */
export function refundSummaryJson(result: RefundNoteResult): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { json, body, ...rest } = result;
  return { ...rest, file: `${result.id}.${result.format}` };
}

export function refundTextReport(result: RefundNoteResult, outDir?: string): string {
  const out: string[] = [];
  out.push(`Refund note ${result.id} against consolidated e-Invoice ${result.original.id} (UUID ${result.original.uuid}, ${result.month})`);
  out.push(`Refunded receipts: ${result.receipts}, lines: ${result.lines}, ${result.bytes} bytes`);
  for (const t of result.byTaxType) {
    const reason = t.taxType === 'E' && result.exemptionReason !== undefined ? ` (exemption reason: ${result.exemptionReason})` : '';
    out.push(`  tax type ${t.taxType}: RM${t.subtotal} + tax RM${t.tax}${reason}`);
  }
  out.push(`Refund total: RM${result.totals.subtotal} + tax RM${result.totals.tax} = RM${result.totals.total}`);
  out.push(`Issue: ${result.issueDate} ${result.issueTime}.${result.checkedAgainstOriginal ? ' Checked against the original document.' : ''}`);
  for (const warning of result.warnings) {
    out.push(`Warning: ${warning}`);
  }
  out.push(outDir === undefined ? 'Dry run: pass --out DIR to write the refund note.' : `Wrote ${result.id}.${result.format} to ${outDir}.`);
  out.push(`The refund note is unsigned v1.0 ${result.format.toUpperCase()} and is not submitted. Check it (e.g. with myinvois-precheck) before submitting.`);
  return `${out.join('\n')}\n`;
}
