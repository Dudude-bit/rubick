import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { toKind, toPlural } from "@/lib/resource-registry";

export interface PeekTarget {
  kind: string;
  name: string;
  namespace?: string | null;
}

const PARAM = "peek";

/**
 * The peek lives in the query string so browser back closes it and a peek is
 * linkable — the alternative, component state, makes back navigate away from
 * the page the user was reading.
 */
export function usePeek() {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);

  const target = useMemo<PeekTarget | null>(() => {
    if (!raw) return null;
    const parts = raw.split("/");
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
      const kind = toKind(next.kind);
      // A kind the registry cannot spell has no address to write down; let the
      // caller's own navigation stand rather than silently rewriting the URL.
      if (!kind) return;
      const plural = toPlural(kind);
      const value = next.namespace
        ? `${plural}/${next.namespace}/${next.name}`
        : `${plural}/${next.name}`;
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
