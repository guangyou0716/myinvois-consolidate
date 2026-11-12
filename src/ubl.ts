import type { ConsolidatedLine } from './lines.js';
import { moneyNumber } from './money.js';
import type { TaxPart } from './receipts.js';
import type { Supplier } from './supplier.js';

/** Buyer values the IRBM e-Invoice Specific Guideline (section 3.6, Appendix 2) prescribes for a consolidated e-Invoice. */
export const GENERAL_PUBLIC_TIN = 'EI00000000010';
/** Classification code 004 "Consolidated e-Invoice" (https://sdk.myinvois.hasil.gov.my/codes/classification-codes/). */
export const CONSOLIDATED_CLASSIFICATION = '004';

type Json = Record<string, unknown>;
const v = (value: unknown, attrs: Json = {}) => [{ _: value, ...attrs }];
const myr = (cents: bigint) => v(moneyNumber(cents), { currencyID: 'MYR' });
const id = (value: string, schemeID: string) => ({ ID: v(value, { schemeID }) });
const country = (code: string) => [{ IdentificationCode: v(code, { listID: 'ISO3166-1', listAgencyID: '6' }) }];

function taxCategory(type: string): Json[] {
  return [{ ID: v(type), TaxScheme: [{ ID: v('OTH', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }) }] }];
}

function taxTotal(parts: Map<string, TaxPart>): Json[] {
  const types = [...parts.keys()].sort();
  let tax = 0n;
  const subtotals = types.map((type) => {
    const part = parts.get(type) as TaxPart;
    tax += part.tax;
    return { TaxableAmount: myr(part.subtotal), TaxAmount: myr(part.tax), TaxCategory: taxCategory(type) };
  });
  return [{ TaxAmount: myr(tax), TaxSubtotal: subtotals }];
}

export function sumParts(parts: Map<string, TaxPart>): TaxPart {
  let subtotal = 0n;
  let tax = 0n;
  for (const part of parts.values()) {
    subtotal += part.subtotal;
    tax += part.tax;
  }
  return { subtotal, tax };
}

export function lineJson(line: ConsolidatedLine, index: number): Json {
  const { subtotal } = sumParts(line.parts);
  return {
    ID: v(String(index + 1)),
    InvoicedQuantity: v(1, { unitCode: 'C62' }),
    LineExtensionAmount: myr(subtotal),
    TaxTotal: taxTotal(line.parts),
    Item: [
      {
        CommodityClassification: [{ ItemClassificationCode: v(CONSOLIDATED_CLASSIFICATION, { listID: 'CLASS' }) }],
        Description: v(line.description),
      },
    ],
    Price: [{ PriceAmount: myr(subtotal) }],
    ItemPriceExtension: [{ Amount: myr(subtotal) }],
  };
}

function supplierParty(s: Supplier): Json[] {
  const contact: Json = { Telephone: v(s.phone) };
  if (s.email !== undefined) {
    contact.ElectronicMail = v(s.email);
  }
  return [
    {
      Party: [
        {
          IndustryClassificationCode: v(s.msic, { name: s.msicDescription }),
          PartyIdentification: [id(s.tin, 'TIN'), id(s.brn, 'BRN'), id(s.sst, 'SST'), id(s.ttx, 'TTX')],
          PostalAddress: [
            {
              CityName: v(s.city),
              PostalZone: v(s.postcode),
              CountrySubentityCode: v(s.state),
              AddressLine: s.addressLines.map((line) => ({ Line: v(line) })),
              Country: country(s.country),
            },
          ],
          PartyLegalEntity: [{ RegistrationName: v(s.name) }],
          Contact: [contact],
        },
      ],
    },
  ];
}

/** Buyer block per Appendix 2: "General Public", TIN EI00000000010, everything else "NA" (state code 17 = not applicable). */
function generalPublicParty(): Json[] {
  return [
    {
      Party: [
        {
          PartyIdentification: [id(GENERAL_PUBLIC_TIN, 'TIN'), id('NA', 'BRN'), id('NA', 'SST'), id('NA', 'TTX')],
          PostalAddress: [
            {
              CityName: v('NA'),
              PostalZone: v('NA'),
              CountrySubentityCode: v('17'),
              AddressLine: [{ Line: v('NA') }],
              Country: country('MYS'),
            },
          ],
          PartyLegalEntity: [{ RegistrationName: v('General Public') }],
          Contact: [{ Telephone: v('NA') }],
        },
      ],
    },
  ];
}

export interface DocumentHeader {
  id: string;
  /** UTC date and time, e.g. "2026-11-03" and "01:00:00Z". */
  issueDate: string;
  issueTime: string;
  /** First and last day of the consolidated month, YYYY-MM-DD. */
  periodStart: string;
  periodEnd: string;
}

/** Builds an unsigned UBL 2.1 JSON Invoice (type 01, version 1.0) for MyInvois. */
export function documentJson(header: DocumentHeader, supplier: Supplier, lines: readonly ConsolidatedLine[]): Json {
  const totals = new Map<string, TaxPart>();
  for (const line of lines) {
    for (const [type, part] of line.parts) {
      const t = totals.get(type) ?? { subtotal: 0n, tax: 0n };
      t.subtotal += part.subtotal;
      t.tax += part.tax;
      totals.set(type, t);
    }
  }
  const { subtotal, tax } = sumParts(totals);
  return {
    _D: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    _A: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    _B: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    Invoice: [
      {
        ID: v(header.id),
        IssueDate: v(header.issueDate),
        IssueTime: v(header.issueTime),
        InvoiceTypeCode: v('01', { listVersionID: '1.0' }),
        DocumentCurrencyCode: v('MYR'),
        TaxCurrencyCode: v('MYR'),
        InvoicePeriod: [
          { StartDate: v(header.periodStart), EndDate: v(header.periodEnd), Description: v('Monthly') },
        ],
        AccountingSupplierParty: supplierParty(supplier),
        AccountingCustomerParty: generalPublicParty(),
        TaxTotal: taxTotal(totals),
        LegalMonetaryTotal: [
          {
            LineExtensionAmount: myr(subtotal),
            TaxExclusiveAmount: myr(subtotal),
            TaxInclusiveAmount: myr(subtotal + tax),
            PayableAmount: myr(subtotal + tax),
          },
        ],
        InvoiceLine: lines.map(lineJson),
      },
    ],
  };
}
