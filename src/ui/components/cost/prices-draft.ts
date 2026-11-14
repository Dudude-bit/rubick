/**
 * The prices form's draft, read as prices: empty optional fields are "not
 * entered", which leaves that resource unpriced rather than free.
 */
import type { en } from "@/i18n/catalogue";
import type { Prices } from "@/lib/cost";

export const FIELDS = ["cpu", "memory", "storage", "gpu"] as const;
export type Field = (typeof FIELDS)[number];
export type Draft = Record<Field | "currency", string>;

export const LABEL: Record<Field, keyof typeof en.cost> = {
  cpu: "fieldCpu",
  memory: "fieldMemory",
  storage: "fieldStorage",
  gpu: "fieldGpu",
};
export const REQUIRED: Record<Field, boolean> = {
  cpu: true,
  memory: true,
  storage: false,
  gpu: false,
};

export function draftOf(prices: Prices | null): Draft {
  const text = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);
  return {
    cpu: text(prices?.cpu),
    memory: text(prices?.memory),
    storage: text(prices?.storage),
    gpu: text(prices?.gpu),
    currency: prices?.currency ?? "",
  };
}

/**
 * The prices a draft says, or the fields that do not say a price. An empty
 * optional field is "not entered", which leaves that resource unpriced.
 */
export function pricesFromDraft(
  draft: Draft
): { prices: Prices; wrong: [] } | { prices: null; wrong: Field[] } {
  const wrong: Field[] = [];
  const read = (field: Field): number | null => {
    const text = draft[field].trim().replace(",", ".");
    if (text === "") {
      if (REQUIRED[field]) wrong.push(field);
      return null;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
      wrong.push(field);
      return null;
    }
    return value;
  };
  const [cpu, memory, storage, gpu] = FIELDS.map(read);
  if (wrong.length > 0) return { prices: null, wrong };
  return {
    prices: {
      cpu: cpu!,
      memory: memory!,
      storage: storage ?? null,
      gpu: gpu ?? null,
      currency: draft.currency.trim(),
    },
    wrong: [],
  };
}
