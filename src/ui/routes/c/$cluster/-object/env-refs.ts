import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";

/** A ConfigMap or Secret a container's environment names, as the read of it answered. */
export type RefObject =
  | { state: "reading" }
  | { state: "read"; keys: string[] }
  | { state: "missing" }
  | { state: "refused" }
  | { state: "unread"; error: string };

export function refObjectOf(query: {
  data?: { dataKeys: string[] };
  error: unknown;
}): RefObject {
  if (query.data) return { state: "read", keys: query.data.dataKeys };
  if (!query.error) return { state: "reading" };
  switch (errorCode(query.error)) {
    case ERROR_CODES.NOT_FOUND:
      return { state: "missing" };
    case ERROR_CODES.PERMISSION:
      return { state: "refused" };
    default:
      return { state: "unread", error: errorToShow(query.error) };
  }
}

/** One reference settled against its object. `key` is null for envFrom, which takes them all. */
export type RefVerdict =
  | { verdict: "reading" }
  | { verdict: "present" }
  | { verdict: "keyMissing"; keys: string[] }
  | { verdict: "objectMissing" }
  | { verdict: "refused" }
  | { verdict: "unread"; error: string };

export function verdictOf(
  object: RefObject | undefined,
  key: string | null
): RefVerdict {
  if (!object) return { verdict: "reading" };
  switch (object.state) {
    case "reading":
      return { verdict: "reading" };
    case "missing":
      return { verdict: "objectMissing" };
    case "refused":
      return { verdict: "refused" };
    case "unread":
      return { verdict: "unread", error: object.error };
    case "read":
      return key === null || object.keys.includes(key)
        ? { verdict: "present" }
        : { verdict: "keyMissing", keys: object.keys };
  }
}

/** Whether the reference stops the variable from being set. */
export function isBroken(verdict: RefVerdict): boolean {
  return (
    verdict.verdict === "keyMissing" || verdict.verdict === "objectMissing"
  );
}
