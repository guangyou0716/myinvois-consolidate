# myinvois-consolidate

Offline CLI and TypeScript library that turns a month of B2C receipts into **MyInvois consolidated e-Invoices**:
buyer "General Public", TIN `EI00000000010`, classification code `004`, every receipt number in a line description.
Output is unsigned UBL 2.1 JSON (Invoice `01`, version `1.0`). It makes no network calls, uses no credentials and
never submits anything.

**Not affiliated with, endorsed by, or connected to Lembaga Hasil Dalam Negeri Malaysia (LHDN/HASiL). Check the
output and LHDN's current guidance before you submit. The MyInvois validators are authoritative.**

## Rules it follows

From the [IRBM e-Invoice Specific Guideline](https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Specific-Guideline.pdf), section 3.6:

- receipts for buyers who did not ask for an e-Invoice can be aggregated monthly and submitted **within 7 calendar
  days after month end** (the tool prints the date and warns when the issue time is before month end or after it);
- buyer details: name `General Public`, TIN `EI00000000010`, ID / address / contact / SST `NA` (Appendix 2);
- line items: (a) one line per receipt (`--method receipt`), (b) one line per continuous receipt-number chain, a
  break in the chain starts a new line (`--method chain`, default), (c) per branch or location (`--by-branch`);
- limits (3.6.4): 300 KB per document, 100 documents and 5 MB per submission. Documents are split to stay at or under
  300,000 bytes of JSON, and grouped into submission batches of at most 100 documents and about 5,000,000 bytes after
  base64 encoding (a conservative estimate).

Classification code `004` is "Consolidated e-Invoice" in the [LHDN code table](https://sdk.myinvois.hasil.gov.my/codes/classification-codes/).

## Usage

The package is private and not published. Build from this repository (Node 20 or newer):

```bash
npm ci && npm run build
node dist/cli.js build examples/receipts-2026-10.csv --supplier examples/supplier.json --month 2026-10
node dist/cli.js build receipts.csv --supplier supplier.json --month 2026-10 --by-branch --out out/2026-10
```

| Option | Meaning |
|---|---|
| `--supplier FILE` | Your company (see `examples/supplier.json`): `name`, `tin`, `brn`, `msic`, `msicDescription`, `addressLines` (1 to 3), `city`, `postcode`, `state` (2-digit code), `phone`; optional `sst`, `ttx` (default `NA`), `country` (default `MYS`), `email`. |
| `--month YYYY-MM` | The month being consolidated. Every receipt date must be in it. |
| `--method chain\|receipt` | Line-item method, default `chain`. |
| `--by-branch` | One document series per `branch` value. |
| `--prefix TEXT` | Document ID prefix, default `CONS` (IDs: `CONS-202610-001`, `CONS-202610-PG1-001`). |
| `--issued-at ISO` | Issue time with a zone, default now. Written as UTC `IssueDate` / `IssueTime`. MyInvois expects submission soon after the issue time, so build right before submitting. |
| `--format json\|xml` | Document encoding, default `json`. `xml` writes the same UBL 2.1 Invoice as XML (`cac`/`cbc` namespaces, elements in UBL schema order). The 300 KB document limit and the batch limits are measured on the chosen encoding, so XML may split into more documents. |
| `--out DIR` | Write `<ID>.json` (or `<ID>.xml`) per document and `summary.json`. Never overwrites. Without it the run is a dry run. |
| `--json` | Print the summary as JSON. |

Exit codes: `0` ok, `1` documents do not reconcile with the receipts, `2` input error.

### Receipts CSV

Header (any order, any case): `receipt,date,subtotal,tax_type,tax[,branch][,exemption_reason]`.

- `subtotal` and `tax` are non-negative amounts in MYR with at most 2 decimals (refunds after submission go in a refund note, see below), `date` is `YYYY-MM-DD`.
- `tax_type` is an [LHDN tax type](https://sdk.myinvois.hasil.gov.my/codes/tax-types/) `01` to `06` or `E`; `06` (Not Applicable) must have tax `0`.
- `E` (tax exemption) rows must have tax `0` and an `exemption_reason` (one line, at most 300 characters, quote it
  if it contains commas). It is written as `TaxExemptionReason` on the type `E` tax subtotal of each line and of the
  document. Receipts may give different reasons: a document carries one reason, so with two or more reasons each
  reason gets its own document series (`CONS-202610-E1-001`, `CONS-202610-PG1-E2-001`, numbered in order of first
  appearance) holding the receipts with that reason, all their tax types included. Receipts without type `E` stay in
  the plain series. The summary lists type `E` totals per reason. Other tax types must leave `exemption_reason`
  empty. MyInvois limits the special characters in this field, so keep the text plain (see
  `examples/receipts-2026-10-exempt.csv` and `examples/receipts-2026-10-exempt-multi.csv`).
- A receipt with several tax types has one row per tax type (same date and branch). Repeating the same receipt and
  tax type is an error.
- Receipt numbers chain when the prefix matches and the trailing number goes up by one (`R-0099` then `R-0100`).

Money is handled as integer cents. The summary reconciles document totals with the receipt totals and prints them
per tax type.

### Refund notes

Receipts refunded **after** the consolidated e-Invoice was submitted get a Refund Note (type `04`) against it. Refunds
in the same month need no note: put the receipt at its final value in that month's `build` input instead.

```bash
myinvois-consolidate refund-note examples/refunds-2026-10.csv --supplier examples/supplier.json --month 2026-10 \
  --original out/CONS-202610-001.json --original-uuid <UUID from MyInvois> --out out-refunds
```

- `refunds.csv` uses the receipts CSV columns. `date` is the original receipt date (it must fall in `--month`), and
  `subtotal` / `tax` are the refunded amounts. One line per refunded receipt (`Refund of receipt R-0003`).
- `--original FILE.json` reads the consolidated e-Invoice written by `build` and checks the supplier TIN, the month and
  that the refund is not more than its payable amount. `--original-id ID` is the alternative when the JSON is not at
  hand (for example an XML original); then nothing is checked and a warning says so.
- `--original-uuid` is the UUID MyInvois returned when it validated the consolidated e-Invoice. Both ID and UUID go in
  `BillingReference / InvoiceDocumentReference`, as the
  [Refund Note v1.0](https://sdk.myinvois.hasil.gov.my/documents/refund-v1-0/) structure requires.
- The buyer stays "General Public". `--id` sets the note ID (default `RN-<original ID>`); `--issued-at`, `--format`,
  `--out` and `--json` work as for `build`. One run writes one note; all type `E` refunds must share one exemption reason.

## Limits of this version

- A receipt can have one exemption reason (one type `E` row).
- Output (JSON or XML) is version `1.0` and **unsigned**. Signing (version `1.1`) and submission are out of scope.
- MYR only.
- Supplier fields get basic checks only. Run a full pre-submission checker on the output.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke
```

`examples/` data is synthetic.

## License

MIT
