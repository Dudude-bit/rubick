/**
 * One `metav1.LabelSelector`, read the way Kubernetes reads it.
 *
 * The backend's `Selector::matches` owes the same answers, and both are held
 * to `shared/label-selector-conformance.json`. Its `about` says why a
 * selector Kubernetes would refuse to build answers `null` rather than
 * either guess.
 */

/** `metav1.LabelSelectorRequirement`. */
export interface LabelSelectorRequirement {
  key: string;
  operator: string;
  values?: string[] | null;
}

/** `metav1.LabelSelector`. */
export interface LabelSelector {
  matchLabels?: Record<string, string> | null;
  matchExpressions?: LabelSelectorRequirement[] | null;
}

export type Labels =
  Readonly<Record<string, string>> | ReadonlyMap<string, string>;

export type Requirement =
  | { key: string; operator: "In" | "NotIn"; values: readonly string[] }
  | { key: string; operator: "Exists" | "DoesNotExist" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `values` list; `null` for one that is not a list of strings. */
function valuesOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;
}

/**
 * The requirements a selector is made of, or `null` where
 * `metav1.LabelSelectorAsSelector` would refuse to build one from it.
 *
 * Typed, and checked anyway: a selector arrives from an object's spec, and
 * a custom resource's schema is not obliged to have checked its shape.
 */
export function requirementsOf(selector: LabelSelector): Requirement[] | null {
  const raw: unknown = selector;
  if (!isRecord(raw)) return null;
  const requirements: Requirement[] = [];

  const { matchLabels, matchExpressions } = raw;
  if (matchLabels !== undefined && matchLabels !== null) {
    if (!isRecord(matchLabels)) return null;
    for (const [key, value] of Object.entries(matchLabels)) {
      if (key === "" || typeof value !== "string") return null;
      requirements.push({ key, operator: "In", values: [value] });
    }
  }

  if (matchExpressions !== undefined && matchExpressions !== null) {
    if (!Array.isArray(matchExpressions)) return null;
    for (const expression of matchExpressions) {
      if (!isRecord(expression)) return null;
      const { key, operator } = expression;
      const values = valuesOf(expression.values);
      if (typeof key !== "string" || key === "" || values === null) return null;
      switch (operator) {
        case "In":
        case "NotIn":
          if (values.length === 0) return null;
          requirements.push({ key, operator, values });
          break;
        case "Exists":
        case "DoesNotExist":
          if (values.length > 0) return null;
          requirements.push({ key, operator });
          break;
        default:
          return null;
      }
    }
  }
  return requirements;
}

function valueOf(labels: Labels, key: string): string | undefined {
  if (labels instanceof Map) return labels.get(key);
  const record = labels as Readonly<Record<string, string>>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function holds(requirement: Requirement, labels: Labels): boolean {
  const value = valueOf(labels, requirement.key);
  switch (requirement.operator) {
    case "In":
      return value !== undefined && requirement.values.includes(value);
    case "NotIn":
      return value === undefined || !requirement.values.includes(value);
    case "Exists":
      return value !== undefined;
    case "DoesNotExist":
      return value === undefined;
  }
}

/**
 * Whether `labels` satisfy `selector`, or `null` where the selector cannot
 * be evaluated.
 *
 * A selector that is not there matches nothing, as
 * `LabelSelectorAsSelector(nil)` does; an empty one matches everything.
 */
export function labelSelectorMatches(
  selector: LabelSelector | null | undefined,
  labels: Labels
): boolean | null {
  if (selector === null || selector === undefined) return false;
  const requirements = requirementsOf(selector);
  if (requirements === null) return null;
  return requirements.every((requirement) => holds(requirement, labels));
}
