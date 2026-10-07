import type { CustomResourceInfo } from "@/generated/types";

/**
 * Which of a CRD's own printer columns the list draws itself.
 *
 * Name and age get their own columns — one links to the object, the other
 * ticks — so the CRD's versions of them are skipped. Its own, because a CRD
 * names its printer columns and `kubectl`'s upper-case convention is a
 * convention, not a rule: Cilium declares `Age`, which a case-sensitive
 * comparison let through, and every Cilium kind drew two Age columns with
 * the CRD's one empty beside ours.
 */
export function drawnSeparately(name: string): boolean {
  const heading = name.trim().toUpperCase();
  return heading === "NAME" || heading === "AGE";
}

type Step =
  | { op: "keys"; keys: string[] }
  | { op: "all" }
  | { op: "indices"; at: number[] }
  | { op: "slice"; from: number | null; to: number | null; by: number }
  | { op: "descend" }
  | { op: "filter"; test: Test };

type Literal = string | number | boolean;

const COMPARISONS = ["==", "!=", "<=", ">=", "<", ">"] as const;

interface Test {
  left: Step[];
  compare: (typeof COMPARISONS)[number] | null;
  right: Literal | Step[] | null;
}

/** Where a bracket opened at `open` closes, past quotes and nested brackets. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "[" || c === "(") depth += 1;
    else if (c === "]" || c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function quoted(text: string): string | null {
  const match = /^(['"])(.*)\1$/s.exec(text.trim());
  return match ? match[2].replace(/\\(.)/g, "$1") : null;
}

function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function literal(text: string): Literal | Step[] | null {
  const trimmed = text.trim();
  const string = quoted(trimmed);
  if (string !== null) return string;
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("@")) return parse(trimmed.slice(1));
  return null;
}

function filter(expression: string): Test | null {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const c = expression[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "[" || c === "(") depth += 1;
    else if (c === "]" || c === ")") depth -= 1;
    else if (depth === 0 && "=!<>".includes(c)) {
      const compare = COMPARISONS.find((op) => expression.startsWith(op, i));
      if (!compare) return null;
      const leftText = expression.slice(0, i).trim();
      const right = literal(expression.slice(i + compare.length));
      if (!leftText.startsWith("@") || right === null) return null;
      const left = parse(leftText.slice(1));
      return left ? { left, compare, right } : null;
    }
  }
  const trimmed = expression.trim();
  if (!trimmed.startsWith("@")) return null;
  const left = parse(trimmed.slice(1));
  return left ? { left, compare: null, right: null } : null;
}

function bracket(inner: string): Step | null {
  if (inner === "*") return { op: "all" };
  if (inner.startsWith("?(") && inner.endsWith(")")) {
    const test = filter(inner.slice(2, -1));
    return test ? { op: "filter", test } : null;
  }
  if (/^-?\d+(\s*,\s*-?\d+)*$/.test(inner))
    return { op: "indices", at: inner.split(",").map(Number) };
  const slice = /^(-?\d+)?\s*:\s*(-?\d+)?(?:\s*:\s*(-?\d+))?$/.exec(inner);
  if (slice) {
    const [, from, to, by] = slice;
    return {
      op: "slice",
      from: from === undefined ? null : Number(from),
      to: to === undefined ? null : Number(to),
      by: by === undefined ? 1 : Number(by),
    };
  }
  const keys = splitOutsideQuotes(inner).map(quoted);
  if (keys.every((key): key is string => key !== null))
    return { op: "keys", keys };
  return null;
}

/**
 * The steps of a kubectl JSONPath, or `null` for one this reader does not
 * understand. Never a guess: a step it cannot read fails the whole path.
 */
function parse(path: string): Step[] | null {
  const steps: Step[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === "[") {
      const end = closing(path, i);
      if (end < 0) return null;
      const step = bracket(path.slice(i + 1, end).trim());
      if (!step) return null;
      steps.push(step);
      i = end + 1;
      continue;
    }
    if (c !== ".") return null;
    i += 1;
    if (path[i] === ".") {
      steps.push({ op: "descend" });
      i += 1;
      if (path[i] === "[") continue;
    }
    let name = "";
    while (i < path.length && !".[]()= \t".includes(path[i])) {
      if (path[i] === "\\") i += 1;
      name += path[i] ?? "";
      i += 1;
    }
    if (name === "") {
      if (i >= path.length && steps.length === 0) break;
      return null;
    }
    steps.push(name === "*" ? { op: "all" } : { op: "keys", keys: [name] });
  }
  return steps;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const children = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];

function descendants(value: unknown): unknown[] {
  return [value, ...children(value).flatMap(descendants)];
}

function holds(test: Test, item: unknown): boolean {
  const left = run(test.left, [item]);
  if (test.compare === null) return left.length > 0;
  if (left.length === 0) return false;
  const right = Array.isArray(test.right)
    ? run(test.right, [item])[0]
    : test.right;
  const a = left[0];
  if (typeof a !== typeof right) return test.compare === "!=";
  switch (test.compare) {
    case "==":
      return a === right;
    case "!=":
      return a !== right;
    case "<":
      return (a as number) < (right as number);
    case ">":
      return (a as number) > (right as number);
    case "<=":
      return (a as number) <= (right as number);
    case ">=":
      return (a as number) >= (right as number);
  }
}

function step(at: Step, value: unknown): unknown[] {
  switch (at.op) {
    case "keys":
      return isRecord(value)
        ? at.keys
            .filter((key) => Object.hasOwn(value, key))
            .map((key) => value[key])
        : [];
    case "all":
      return children(value);
    case "indices":
      return Array.isArray(value)
        ? at.at
            .map((n) => (n < 0 ? value.length + n : n))
            .filter((n) => n >= 0 && n < value.length)
            .map((n) => value[n])
        : [];
    case "slice": {
      if (!Array.isArray(value) || at.by <= 0) return [];
      const bound = (n: number | null, fallback: number) =>
        n === null
          ? fallback
          : Math.min(Math.max(n < 0 ? value.length + n : n, 0), value.length);
      const out: unknown[] = [];
      for (
        let n = bound(at.from, 0);
        n < bound(at.to, value.length);
        n += at.by
      )
        out.push(value[n]);
      return out;
    }
    case "descend":
      return descendants(value);
    case "filter":
      return children(value).filter((item) => holds(at.test, item));
  }
}

function run(steps: Step[], values: unknown[]): unknown[] {
  return steps.reduce<unknown[]>(
    (current, at) => current.flatMap((value) => step(at, value)),
    values
  );
}

/** The metadata a list row carries; a column reading any other field was not read. */
const CARRIED_METADATA = [
  "name",
  "namespace",
  "uid",
  "labels",
  "annotations",
  "creationTimestamp",
  "generation",
  "ownerReferences",
];

/** The owner fields a row carries; `blockOwnerDeletion` is not one of them. */
const CARRIED_OWNER = ["apiVersion", "kind", "name", "uid", "controller"];

/** Whether the steps past `ownerReferences` read only fields the row carries. */
function readsCarriedOwner(steps: Step[]): boolean {
  return steps.every((at) => {
    switch (at.op) {
      case "keys":
        return at.keys.every((key) => CARRIED_OWNER.includes(key));
      case "descend":
        return false;
      case "filter":
        return (
          readsCarriedOwner(at.test.left) &&
          (!Array.isArray(at.test.right) || readsCarriedOwner(at.test.right))
        );
      default:
        return true;
    }
  });
}

export type PrinterCell =
  | { evaluated: true; value: unknown }
  | { evaluated: false };

/**
 * A printer column's value for one row, as the API server prints it for
 * kubectl: the first value the JSONPath finds, `undefined` when it finds
 * none. A path this reader cannot evaluate says so instead of reading as
 * "none", which is what the cluster says when the field is really absent.
 */
export function printerCell(
  row: CustomResourceInfo,
  jsonPath: string
): PrinterCell {
  const steps = jsonPath.startsWith(".") ? parse(jsonPath) : null;
  if (!steps) return { evaluated: false };
  const [first, second] = steps;
  if (
    first?.op !== "keys" ||
    (first.keys.includes("metadata") &&
      (second?.op !== "keys" ||
        !second.keys.every((key) => CARRIED_METADATA.includes(key)) ||
        (second.keys.includes("ownerReferences") &&
          !readsCarriedOwner(steps.slice(2)))))
  )
    return { evaluated: false };
  const document = {
    apiVersion: row.apiVersion,
    kind: row.kind,
    metadata: {
      name: row.name,
      ...(row.namespace ? { namespace: row.namespace } : {}),
      uid: row.uid,
      labels: row.labels,
      annotations: row.annotations,
      creationTimestamp: row.createdAt,
      generation: row.generation,
      ...(row.ownerReferences.length > 0 && {
        ownerReferences: row.ownerReferences.map(({ controller, ...ref }) =>
          controller === null ? ref : { ...ref, controller }
        ),
      }),
    },
    spec: row.spec,
    ...(row.status === null ? {} : { status: row.status }),
  };
  const [value] = run(steps, [document]);
  return { evaluated: true, value: value ?? undefined };
}
