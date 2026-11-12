import type { Query } from "@tanstack/react-query";

import {
  ERROR_CODES,
  errorCode,
  errorToShow,
  isRefusal,
} from "@/lib/error-utils";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { firstTelling } from "@/lib/refusals";

export const formatKey = (key: unknown) => {
  try {
    return JSON.parse(JSON.stringify(key));
  } catch {
    return String(key);
  }
};

export const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The object a NotFound is about, as `namespace/name`: the last name in the
 * key that the error names, and the key's entry before it, which is how every
 * reader of one object keys it.
 */
function goneObject(said: string, queryKey: readonly unknown[]): string | null {
  for (let at = queryKey.length - 1; at > 0; at--) {
    const part = queryKey[at];
    if (typeof part !== "string" || part === "") continue;
    if (
      said.includes(`"${part}"`) ||
      said.includes(`/${part} `) ||
      said.endsWith(`/${part}`)
    )
      return `${queryKey[at - 1] ?? ""}/${part}`;
  }
  return null;
}

/**
 * A failed read, in the log. A refusal is said on screen in the page's own
 * words, so it is a warning, once per connection rather than per poll, and
 * once for every read the server refused in the same sentence. An object
 * found gone is said on screen too, and is one line however many of its
 * readers find it gone.
 */
export function logQueryFailure(
  error: unknown,
  query: Pick<Query, "queryKey" | "queryHash">
): void {
  const data = {
    queryKey: formatKey(query.queryKey),
    error: formatError(error),
  };
  if (errorCode(error) === ERROR_CODES.NOT_FOUND) {
    const gone = goneObject(data.error, query.queryKey) ?? query.queryHash;
    if (firstTelling(`gone ${gone}`))
      logInfo("Query found the object gone", { context: "react-query", data });
    return;
  }
  if (!isRefusal(error)) {
    logError("Query error", { context: "react-query", data });
    return;
  }
  if (firstTelling(errorToShow(error) || query.queryHash))
    logWarn("Query refused", { context: "react-query", data });
}
