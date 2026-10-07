import type { Query } from "@tanstack/react-query";

import { errorToShow, isRefusal } from "@/lib/error-utils";
import { logError, logWarn } from "@/lib/logger";
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
 * A failed read, in the log. A refusal is said on screen in the page's own
 * words, so it is a warning, once per connection rather than per poll, and
 * once for every read the server refused in the same sentence.
 */
export function logQueryFailure(
  error: unknown,
  query: Pick<Query, "queryKey" | "queryHash">
): void {
  const data = {
    queryKey: formatKey(query.queryKey),
    error: formatError(error),
  };
  if (!isRefusal(error)) {
    logError("Query error", { context: "react-query", data });
    return;
  }
  if (firstTelling(errorToShow(error) || query.queryHash))
    logWarn("Query refused", { context: "react-query", data });
}
