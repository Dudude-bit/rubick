export interface ScaleTarget {
  apiVersion?: string;
  kind: string;
  name: string;
}

type Spec = Record<string, unknown>;

export const specOf = (object: unknown): Spec =>
  ((object as { spec?: Spec } | null)?.spec ?? {}) as Spec;

/** The object an autoscaler's spec names, or `null` when it names none. */
export function scaleTargetOf(object: unknown): ScaleTarget | null {
  const ref = (specOf(object).scaleTargetRef ?? {}) as Partial<ScaleTarget>;
  return typeof ref.kind === "string" &&
    ref.kind &&
    typeof ref.name === "string" &&
    ref.name
    ? { apiVersion: ref.apiVersion, kind: ref.kind, name: ref.name }
    : null;
}
