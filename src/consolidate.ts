import { InputError } from './errors.js';
import { buildLines, type ConsolidatedLine, type Method } from './lines.js';
import { formatMoney } from './money.js';
import { exemptionReasonsOf, validReasonOf, type Receipt, type TaxPart } from './receipts.js';
import type { Supplier } from './supplier.js';
import { documentJson, lineJson, sumParts } from './ubl.js';
import { elementXml, ublJsonToXml } from './xml.js';

/** MyInvois limits from the IRBM e-Invoice Specific Guideline 3.6.4: 300 KB per document, 100 documents and 5 MB per submission. */
export interface Limits {
  documentBytes: number;
  batchDocuments: number;
  batchBytes: number;
}
export const LIMITS: Readonly<Limits> = { documentBytes: 300_000, batchDocuments: 100, batchBytes: 5_000_000 };

/** Malaysia is UTC+8 with no daylight saving time. */
const MYT_OFFSET_MS = 8 * 3600 * 1000;
/** Rough per-document envelope in a submission (format, SHA-256 hash, codeNumber, quotes and commas). */
const SUBMISSION_ENVELOPE_BYTES = 200;
/** Room left for document-level totals growing as lines are added. */
const ESTIMATE_MARGIN_BYTES = 2048;

/** Document encoding: MyInvois accepts UBL 2.1 as JSON or XML. */
export type DocumentFormat = 'json' | 'xml';

export interface ConsolidateOptions {
  /** "YYYY-MM": the month whose receipts are consolidated. */
  month: string;
  method: Method;
  /** One document series per branch (guideline 3.6.3 (c)). */
  byBranch?: boolean;
  /** Document ID prefix, default "CONS". */
  idPrefix?: string;
  /** Issue instant written into IssueDate / IssueTime (UTC). */
  issuedAt: Date;
  /** Encoding of the documents (default json); sizes and splitting are measured on this encoding. */
  format?: DocumentFormat;
  /** Override limits (tests use small ones). */
  limits?: Partial<Limits>;
}

export interface DocumentResult {
  id: string;
  branch: string;
  /** TaxExemptionReason of this document's tax type E lines, when it has any. */
  exemptionReason?: string;
  lines: number;
  receipts: number;
  firstReceipt: string;
  lastReceipt: string;
  subtotal: string;
  tax: string;
  total: string;
  /** UTF-8 size of `body`. */
  bytes: number;
  json: Record<string, unknown>;
  /** The encoded document exactly as it should be written / submitted (JSON or XML, per `format`). */
  body: string;
}

export interface Totals {
  subtotal: string;
  tax: string;
  total: string;
}

export interface ConsolidateResult {
  month: string;
  method: Method;
  byBranch: boolean;
  format: DocumentFormat;
  receipts: number;
  lines: number;
  periodStart: string;
  periodEnd: string;
  /** Last day (MYT) to submit: 7 calendar days after month end. */
  submitBy: string;
  issueDate: string;
  issueTime: string;
  documents: DocumentResult[];
  /** Document IDs per submission batch. */
  batches: string[][];
  totalsFromReceipts: Totals;
  totalsFromDocuments: Totals;
  reconciled: boolean;
  byTaxType: Array<{ taxType: string } & Totals>;
  /** TaxExemptionReason written for tax type E, when all type E receipts share one reason. */
  exemptionReason?: string;
  /**
   * Distinct exemption reasons in order of first appearance. With two or more, receipts with reason n go to their own
   * document series with an `-E<n>` ID part, and receipts without type E keep the plain series.
   */
  exemptionReasons: string[];
  /** Totals of tax type E per exemption reason (same order as exemptionReasons). */
  byExemptionReason: Array<{ exemptionReason: string } & Totals>;
  warnings: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function totals(subtotal: bigint, tax: bigint): Totals {
  return { subtotal: formatMoney(subtotal), tax: formatMoney(tax), total: formatMoney(subtotal + tax) };
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

export function consolidate(receipts: readonly Receipt[], supplier: Supplier, options: ConsolidateOptions): ConsolidateResult {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(options.month);
  if (!match) {
    throw new InputError(`month "${options.month}" must be YYYY-MM.`);
  }
  const prefix = options.idPrefix ?? 'CONS';
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(prefix)) {
    throw new InputError('ID prefix must be 1 to 20 letters, digits, "-" or "_".');
  }
  if (Number.isNaN(options.issuedAt.getTime())) {
    throw new InputError('issue time is not a valid date.');
  }
  const limits = { ...LIMITS, ...options.limits };
  const format = options.format ?? 'json';
  if (format !== 'json' && format !== 'xml') {
    throw new InputError('format must be json or xml.');
  }
  const encode = (doc: Record<string, unknown>) => (format === 'xml' ? ublJsonToXml(doc) : JSON.stringify(doc));
  const lineBytesOf = (line: Record<string, unknown>) => utf8(format === 'xml' ? elementXml('InvoiceLine', [line]) : JSON.stringify(line));
  const year = Number(match[1]);
  const month = Number(match[2]);
  const periodStart = ymd(new Date(Date.UTC(year, month - 1, 1)));
  const periodEnd = ymd(new Date(Date.UTC(year, month, 0)));
  const submitBy = ymd(new Date(Date.UTC(year, month, 7)));
  const monthOverAt = Date.UTC(year, month, 1) - MYT_OFFSET_MS;
  const deadlineAt = Date.UTC(year, month, 8) - MYT_OFFSET_MS;

  const outside = receipts.filter((r) => r.date < periodStart || r.date > periodEnd);
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map((r) => `${r.receipt} (${r.date})`).join(', ');
    throw new InputError(`${outside.length} receipt(s) are outside ${options.month}: ${sample}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}.`);
  }

  const reasons = exemptionReasonsOf(receipts);
  const split = reasons.length > 1;
  const warnings: string[] = [];
  const issuedMs = options.issuedAt.getTime();
  if (issuedMs < monthOverAt) {
    warnings.push(`Issue time is before ${options.month} is over (Malaysia time); issue the consolidated e-Invoice after month end.`);
  } else if (issuedMs >= deadlineAt) {
    warnings.push(`Issue time is after the deadline: consolidated e-Invoices for ${options.month} are due by ${submitBy} (7 calendar days after month end).`);
  }

  // Group key: branch ('' without --by-branch) and reason number (0 = no own reason series).
  interface Group {
    branch: string;
    reasonNo: number;
    receipts: Receipt[];
  }
  const groups = new Map<string, Group>();
  for (const receipt of receipts) {
    if (options.byBranch && receipt.branch === '') {
      throw new InputError(`receipt ${receipt.receipt} has no branch, but --by-branch is set.`);
    }
    const branch = options.byBranch ? receipt.branch : '';
    const reason = validReasonOf(receipt);
    const reasonNo = split && reason !== undefined ? reasons.indexOf(reason) + 1 : 0;
    const key = `${branch}\u0000${reasonNo}`;
    const group = groups.get(key) ?? { branch, reasonNo, receipts: [] };
    group.receipts.push(receipt);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : a.reasonNo - b.reasonNo));

  const issueDate = options.issuedAt.toISOString().slice(0, 10);
  const issueTime = `${options.issuedAt.toISOString().slice(11, 19)}Z`;
  const yyyymm = `${match[1]}${match[2]}`;
  const documents: DocumentResult[] = [];
  let lineCount = 0;
  let docSubtotal = 0n;
  let docTax = 0n;

  for (const { branch, reasonNo, receipts: groupReceipts } of ordered) {
    const lines = buildLines(groupReceipts, options.method);
    lineCount += lines.length;
    const exemptionReason = split ? (reasonNo === 0 ? undefined : reasons[reasonNo - 1]) : reasons[0];
    const chunks: ConsolidatedLine[][] = [];
    const header = (seq: number) => ({
      id: `${prefix}-${yyyymm}${branch === '' ? '' : `-${branch}`}${reasonNo === 0 ? '' : `-E${reasonNo}`}-${String(seq).padStart(3, '0')}`,
      issueDate,
      issueTime,
      periodStart,
      periodEnd,
    });
    const base = utf8(encode(documentJson(header(999), supplier, [], exemptionReason))) + ESTIMATE_MARGIN_BYTES;
    let current: ConsolidatedLine[] = [];
    let size = base;
    for (const line of lines) {
      const lineBytes = lineBytesOf(lineJson(line, 99_999, exemptionReason)) + 1;
      if (base + lineBytes > limits.documentBytes) {
        throw new InputError(`line "${line.description}" alone does not fit in a ${limits.documentBytes}-byte document.`);
      }
      if (current.length > 0 && size + lineBytes > limits.documentBytes) {
        chunks.push(current);
        current = [];
        size = base;
      }
      current.push(line);
      size += lineBytes;
    }
    chunks.push(current);

    chunks.forEach((chunk, i) => {
      const h = header(i + 1);
      const json = documentJson(h, supplier, chunk, exemptionReason);
      const body = encode(json);
      const docBytes = utf8(body);
      if (docBytes > limits.documentBytes) {
        throw new Error(`internal: ${h.id} is ${docBytes} bytes, over the ${limits.documentBytes}-byte limit.`);
      }
      const all = new Map<string, TaxPart>();
      let receiptsInDoc = 0;
      for (const line of chunk) {
        receiptsInDoc += line.receipts.length;
        for (const [type, part] of line.parts) {
          const t = all.get(type) ?? { subtotal: 0n, tax: 0n };
          t.subtotal += part.subtotal;
          t.tax += part.tax;
          all.set(type, t);
        }
      }
      const sum = sumParts(all);
      docSubtotal += sum.subtotal;
      docTax += sum.tax;
      const last = chunk[chunk.length - 1];
      const hasE = chunk.some((line) => line.parts.has('E'));
      documents.push({
        id: h.id,
        branch,
        ...(hasE && exemptionReason !== undefined ? { exemptionReason } : {}),
        lines: chunk.length,
        receipts: receiptsInDoc,
        firstReceipt: chunk[0].receipts[0],
        lastReceipt: last.receipts[last.receipts.length - 1],
        ...totals(sum.subtotal, sum.tax),
        bytes: docBytes,
        json,
        body,
      });
    });
  }

  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  for (const doc of documents) {
    const encoded = Math.ceil(doc.bytes / 3) * 4 + SUBMISSION_ENVELOPE_BYTES;
    if (batch.length > 0 && (batch.length >= limits.batchDocuments || batchBytes + encoded > limits.batchBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(doc.id);
    batchBytes += encoded;
  }
  batches.push(batch);

  const byType = new Map<string, TaxPart>();
  const byReason = new Map<string, TaxPart>(reasons.map((reason) => [reason, { subtotal: 0n, tax: 0n }]));
  for (const receipt of receipts) {
    const reason = validReasonOf(receipt);
    const e = receipt.parts.get('E');
    if (reason !== undefined && e !== undefined) {
      const t = byReason.get(reason) as TaxPart;
      t.subtotal += e.subtotal;
      t.tax += e.tax;
    }
    for (const [type, part] of receipt.parts) {
      const t = byType.get(type) ?? { subtotal: 0n, tax: 0n };
      t.subtotal += part.subtotal;
      t.tax += part.tax;
      byType.set(type, t);
    }
  }
  const fromReceipts = sumParts(byType);
  const receiptsInDocs = documents.reduce((n, d) => n + d.receipts, 0);
  const reconciled = docSubtotal === fromReceipts.subtotal && docTax === fromReceipts.tax && receiptsInDocs === receipts.length;

  return {
    month: options.month,
    method: options.method,
    byBranch: options.byBranch ?? false,
    format,
    receipts: receipts.length,
    lines: lineCount,
    periodStart,
    periodEnd,
    submitBy,
    issueDate,
    issueTime,
    documents,
    batches,
    totalsFromReceipts: totals(fromReceipts.subtotal, fromReceipts.tax),
    totalsFromDocuments: totals(docSubtotal, docTax),
    reconciled,
    byTaxType: [...byType.keys()].sort().map((taxType) => {
      const t = byType.get(taxType) as TaxPart;
      return { taxType, ...totals(t.subtotal, t.tax) };
    }),
    ...(reasons.length === 1 ? { exemptionReason: reasons[0] } : {}),
    exemptionReasons: reasons,
    byExemptionReason: reasons.map((exemptionReason) => {
      const t = byReason.get(exemptionReason) as TaxPart;
      return { exemptionReason, ...totals(t.subtotal, t.tax) };
    }),
    warnings,
  };
}
