import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { toKind, toPlural } from "@/lib/resource-registry";

export interface PeekTarget {
  kind: string;
  name: string;
  namespace?: string | null;
  /**
   * The CRD that defines this kind, `<plural>.<group>`.
   *
   * Set for a custom resource and for nothing else, and it is what makes one
   * peekable at all. The registry cannot spell a kind it has never heard of,
   * so there is no plural to address the object by and no `apiVersion` to
   * read it with — a peek that guessed either would ask the core API for
   * `/api/v1/applications` and show the reader a 404 where an Argo
   * Application should be.
   */
  crd?: string;
}

const PARAM = "peek";

/**
 * A CRD is named `<plural>.<group>` and always has a dot; no plural in the
 * registry has one. That is the whole disambiguation between the two shapes
 * the parameter holds, and it is a property of Kubernetes naming rather than
 * a convention invented here.
 */
const isCrdName = (segment: string) => segment.includes(".");

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
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);

  const target = useMemo<PeekTarget | null>(() => {
    if (!raw) return null;
    const parts = raw.split("/");

    if (isCrdName(parts[0])) {
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
  }, [raw]);

  const open = useCallback(
    (next: PeekTarget) => {
      const where = next.namespace ? [next.namespace, next.name] : [next.name];
      let value: string;
      if (next.crd) {
        value = [next.crd, next.kind, ...where].join("/");
      } else {
        const kind = toKind(next.kind);
        // A core kind the registry cannot spell has no address to write down,
        // and no CRD was named to address it by; let the caller's own
        // navigation stand rather than silently rewriting the URL.
        if (!kind) return;
        value = [toPlural(kind), ...where].join("/");
      }
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set(PARAM, value);
          return updated;
        },
        { replace: false }
      );
    },
    [setParams]
  );

  const close = useCallback(() => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.delete(PARAM);
        return updated;
      },
      { replace: false }
    );
  }, [setParams]);

  return { target, open, close };
}
