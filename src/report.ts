import type { ConsolidateResult, DocumentFormat } from './consolidate.js';

/** File name a document is written to. */
export const documentFile = (id: string, format: DocumentFormat) => `${id}.${format}`;

/** Summary without the document bodies, for summary.json and --json. */
export function summaryJson(result: ConsolidateResult): Record<string, unknown> {
  return {
    ...result,
    documents: result.documents.map((doc) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { json, body, ...rest } = doc;
      return { ...rest, file: documentFile(doc.id, result.format) };
    }),
  };
}

export function textReport(result: ConsolidateResult, outDir?: string): string {
  const out: string[] = [];
  out.push(`Consolidated e-Invoice for ${result.month} (${result.periodStart} to ${result.periodEnd})`);
  out.push(`Method: ${result.method === 'chain' ? 'continuous receipt chains' : 'one line per receipt'}${result.byBranch ? ', per branch' : ''}`);
  out.push(`Receipts: ${result.receipts}, lines: ${result.lines}, documents: ${result.documents.length}, submission batches: ${result.batches.length}`);
  out.push('');
  for (const doc of result.documents) {
    out.push(
      `  ${doc.id}  ${doc.receipts} receipts (${doc.firstReceipt} .. ${doc.lastReceipt}), ${doc.lines} lines, ` +
        `RM${doc.subtotal} + tax RM${doc.tax} = RM${doc.total}, ${doc.bytes} bytes`,
    );
  }
  out.push('');
  for (const t of result.byTaxType) {
    const reason = t.taxType === 'E' && result.exemptionReason !== undefined ? ` (exemption reason: ${result.exemptionReason})` : '';
    out.push(`  tax type ${t.taxType}: RM${t.subtotal} + tax RM${t.tax}${reason}`);
    if (t.taxType === 'E' && result.exemptionReasons.length > 1) {
      result.byExemptionReason.forEach((r, i) => {
        out.push(`    E${i + 1}: RM${r.subtotal} (exemption reason: ${r.exemptionReason})`);
      });
    }
  }
  const r = result.totalsFromReceipts;
  out.push(`Total: RM${r.subtotal} + tax RM${r.tax} = RM${r.total} (${result.reconciled ? 'documents reconcile with receipts' : 'DOES NOT RECONCILE'})`);
  out.push(`Issue: ${result.issueDate} ${result.issueTime}. Submit by ${result.submitBy} (7 days after month end).`);
  for (const warning of result.warnings) {
    out.push(`Warning: ${warning}`);
  }
  out.push(outDir === undefined ? 'Dry run: pass --out DIR to write the documents.' : `Wrote ${result.documents.length} document(s) and summary.json to ${outDir}.`);
  out.push(`Documents are unsigned v1.0 ${result.format.toUpperCase()} and are not submitted. Check them (e.g. with myinvois-precheck) before submitting.`);
  return `${out.join('\n')}\n`;
}
