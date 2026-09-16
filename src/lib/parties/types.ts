/**
 * The party kinds the business deals with. Phase 7 adds Dalal / Broker and
 * Manufacturer: both are ordinary parties, so their money balances are the
 * same Accounts Payable / Receivable sub-ledger by partyId and the existing
 * Payment Given flow settles them unchanged.
 */
export const PARTY_TYPES = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "SUPPLIER", label: "Supplier" },
  { value: "KARIGAR", label: "Karigar" },
  { value: "BROKER", label: "Dalal / Broker" },
  { value: "MANUFACTURER", label: "Manufacturer" },
] as const;

export type PartyTypeValue = (typeof PARTY_TYPES)[number]["value"];

const LABEL_BY_TYPE = new Map<string, string>(PARTY_TYPES.map((t) => [t.value, t.label]));

export function partyTypeLabel(value: string): string {
  return LABEL_BY_TYPE.get(value) ?? value;
}
