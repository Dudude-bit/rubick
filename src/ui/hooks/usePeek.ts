import { useCallback, useMemo } from "react";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { ResourceType, toKind, toPlural } from "@/lib/resource-registry";

export interface PeekTarget {
  kind: string;
  name: string;
  namespace?: string | null;
  /**
   * The segment the kind is served at: `<plural>.<group>` for a custom
   * resource, the bare plural of a core kind the registry does not hold
   * (`serviceaccounts`).
   *
   * Set for a kind outside the registry and for nothing else, and it is what
   * makes one peekable at all. The registry cannot spell a kind it has never heard of,
   * so there is no plural to address the object by and no `apiVersion` to
   * read it with — a peek that guessed either would ask the core API for
   * `/api/v1/applications` and show the reader a 404 where an Argo
   * Application should be.
   */
  crd?: string;
}

/**
 * A CRD is named `<plural>.<group>` and always has a dot; no plural in the
 * registry has one. That is the whole disambiguation between the two shapes
 * the parameter holds, and it is a property of Kubernetes naming rather than
 * a convention invented here.
 */
const isCrdName = (segment: string) => segment.includes(".");

/** A first segment the registry cannot spell is a served segment, dotted or a core plural. */
const isServedSegment = (segment: string) =>
  isCrdName(segment) || toKind(segment) === null;

/** The parameter's value as a target, or `null` for a value in neither shape. */
export function parsePeekValue(raw: string): PeekTarget | null {
  if (!raw) return null;
  const parts = raw.split("/");

  if (isServedSegment(parts[0])) {
    const [crd, kind, ...rest] = parts;
    // A kind is UpperCamelCase — required of every CRD by the API server.
    // Without this check a link truncated to `<crd>/<ns>/<name>` would open
    // a panel headed with the namespace, which reads as a real object.
    if (!kind || !/^[A-Z]/.test(kind)) return null;
    if (rest.length < 1 || rest.length > 2) return null;
    const [namespace, name] = rest.length === 2 ? rest : [null, rest[0]];
    if (!name) return null;
    return { kind, name, namespace, crd };
  }

  if (parts.length < 2 || parts.length > 3) return null;
  const kind = toKind(parts[0]);
  if (!kind) return null;
  const [, first, second] = parts;
  const [namespace, name] =
    parts.length === 3 ? [first, second] : [null, first];
  if (!name) return null;
  return { kind, name, namespace };
}

/**
 * The object behind a core route, `/pods/default/nginx`, in the shape the
 * parameter takes: the same segments without the slash. A route in any
 * other shape has no peek and is opened the way it always was.
 */
export function peekTargetOfHref(href: string): PeekTarget | null {
  const path = href.split("?")[0];
  if (!path.startsWith("/c/")) return null;
  const parts = path.split("/").filter(Boolean).slice(2);
  if (parts.length < 2 || parts.length > 3 || isCrdName(parts[0])) return null;
  return parsePeekValue(parts.map(decodeURIComponent).join("/"));
}

/**
 * The peek lives in the query string so browser back closes it and a peek is
 * linkable — the alternative, component state, makes back navigate away from
 * the page the user was reading.
 *
 * Two shapes, because a custom resource needs two more facts than a core
 * object does:
 *
 * - `pods/default/nginx` — plural, optional namespace, name
 * - `applications.argoproj.io/Application/argocd/shop` — CRD, kind, optional
 *   namespace, name
 *
 * The kind is written out for the custom shape rather than resolved from the
 * CRD, so the panel's header names the object from the first frame instead of
 * after a round trip.
 */
export function usePeek() {
  const raw = useAppSearch().peek ?? null;
  const setSearch = useSetSearch();

  const target = useMemo<PeekTarget | null>(
    () => (raw ? parsePeekValue(raw) : null),
    [raw]
  );

  const open = useCallback(
    (next: PeekTarget) => {
      const where = next.namespace ? [next.namespace, next.name] : [next.name];
      let value: string;
      if (next.crd) {
        value = [next.crd, next.kind, ...where].join("/");
      } else {
        const kind = toKind(next.kind);
        if (!kind) return;
        value = [toPlural(kind), ...where].join("/");
      }
      if (value === raw) return;
      setSearch({ peek: value }, { replace: false });
    },
    [setSearch, raw]
  );

  const close = useCallback(() => {
    setSearch({ peek: undefined }, { replace: false });
  }, [setSearch]);

  return { target, open, close };
}

/**
 * The peek's tab as the detail page spells it, or `null` for a tab the page
 * opens on anyway.
 *
 * The two sides name most tabs alike, and one they do not: the peek has a
 * single `children` tab that shows a workload's pods and a CronJob's jobs,
 * while each page names that tab after the kind it lists. A tab id no page
 * has does not fail — the page falls back to Overview and keeps the query
 * parameter, which the scope tab then records as the route to come back to.
 */
export function pageTab(tab: string, kind: string): string | null {
  if (tab === "overview") return null;
  if (tab !== "children") return tab;
  return toPlural(
    toKind(kind) === ResourceType.CronJob ? ResourceType.Job : ResourceType.Pod
  );
}
