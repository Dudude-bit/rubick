/**
 * Utility functions for handling errors with structured normalization
 */

import { logError } from "@/lib/logger";

/**
 * Normalized error structure for consistent error handling
 */
export interface NormalizedError {
  code: string;
  message: string;
  details?: unknown;
  timestamp: number;
  context?: string;
  isRetryable: boolean;
}

/**
 * Error codes for categorization
 */
export const ERROR_CODES = {
  UNKNOWN: "UNKNOWN_ERROR",
  NETWORK: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT_ERROR",
  AUTH: "AUTH_ERROR",
  PERMISSION: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION_ERROR",
  KUBE_API: "KUBE_API_ERROR",
  INTERNAL: "INTERNAL_ERROR",
} as const;

type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Whether an error message says the request is worth making again.
 *
 * Matched on whole words, and `network` was the reason why: every Kubernetes
 * error about an object in `networking.k8s.io` — every Ingress, every
 * NetworkPolicy — contains the substring, so a flat `403 Forbidden` on an
 * Ingress classified as a retryable network blip and was retried until it
 * gave up. A verdict is not a blip: the API server has already decided, and
 * asking again spends requests to be told the same thing.
 */
function isRetryableError(message: string): boolean {
  const lower = message.toLowerCase();
  // A refusal wins over anything else in the sentence, including the API
  // group's own name.
  if (
    /\b(forbidden|unauthorized|not found|invalid|already exists)\b/.test(lower)
  ) {
    return false;
  }
  return /\b(timeout|timed out|connection|network|token expired)\b/.test(lower);
}

/**
 * The same verdict, on a thrown value rather than a message — which is the
 * query client's entire retry policy.
 *
 * Without one, React Query's default applies to every query in the app: three
 * further requests and about seven seconds of skeleton before a `Forbidden`
 * the API server had already decided reaches the screen. On a token that
 * cannot see Secrets that is four requests per failing list, per poll, and the
 * reader waits the seven seconds to be told the same thing.
 *
 * It is also why a *number* of retries matters so little here: a polled query
 * re-asks on its own interval, so its retry is the next poll.
 */
export function isWorthRetrying(error: unknown): boolean {
  return isRetryableError(normalizeTauriError(error));
}

/**
 * Extract error code from error message or structure
 */
function extractErrorCode(error: unknown): ErrorCode {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;

    // Check for explicit error_code or code field
    if (typeof err.error_code === "string") {
      return err.error_code as ErrorCode;
    }
    if (typeof err.code === "string") {
      return err.code as ErrorCode;
    }
  }

  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("not authenticated") ||
    lowerMessage.includes("auth")
  ) {
    return ERROR_CODES.AUTH;
  }
  if (
    lowerMessage.includes("permission denied") ||
    lowerMessage.includes("forbidden")
  ) {
    return ERROR_CODES.PERMISSION;
  }
  if (lowerMessage.includes("not found")) {
    return ERROR_CODES.NOT_FOUND;
  }
  if (lowerMessage.includes("timeout")) {
    return ERROR_CODES.TIMEOUT;
  }
  if (lowerMessage.includes("network") || lowerMessage.includes("connection")) {
    return ERROR_CODES.NETWORK;
  }
  if (lowerMessage.includes("kube") || lowerMessage.includes("kubernetes")) {
    return ERROR_CODES.KUBE_API;
  }
  if (lowerMessage.includes("invalid") || lowerMessage.includes("validation")) {
    return ERROR_CODES.VALIDATION;
  }

  return ERROR_CODES.UNKNOWN;
}

/**
 * Normalize any error into a consistent NormalizedError structure
 *
 * @param error - Error to normalize (can be any type)
 * @param context - Optional context string for where the error occurred
 * @returns Normalized error structure
 */
export function normalizeError(
  error: unknown,
  context?: string
): NormalizedError {
  const message = normalizeTauriError(error);
  const code = extractErrorCode(error);

  let details: unknown = undefined;
  if (error && typeof error === "object" && !(error instanceof Error)) {
    details = error;
  } else if (error instanceof Error && error.stack) {
    details = { stack: error.stack };
  }

  return {
    code,
    message,
    details,
    timestamp: Date.now(),
    context,
    isRetryable: isRetryableError(message),
  };
}

/**
 * Report an error - logs it and returns the normalized form
 *
 * @param error - Error to report
 * @param context - Optional context string
 * @returns Normalized error
 */
export function reportError(error: unknown, context?: string): NormalizedError {
  const normalized = normalizeError(error, context);

  logError(normalized.message, {
    context: context ?? "error",
    data: {
      code: normalized.code,
      details: normalized.details,
      isRetryable: normalized.isRetryable,
    },
  });

  return normalized;
}

/**
 * Normalize Tauri error to a readable string message
 *
 * Tauri errors can be:
 * - String
 * - Error object with message property
 * - Object with code/message/error_code properties (from our Error type or API)
 * - Plain object
 *
 * @param error - Error to normalize (can be any type)
 * @returns Normalized error message as string
 */
export function normalizeTauriError(error: unknown): string {
  // If it's already a string, return it
  if (typeof error === "string") {
    return error;
  }

  // If it's an Error instance, return its message
  if (error instanceof Error) {
    return error.message;
  }

  // If it's an object, try to extract message
  if (error && typeof error === "object") {
    // Check for API error structure: { error, code, error_code }
    const err = error as Record<string, unknown>;

    // Check for API error structure first
    if (typeof err.error === "string" && err.error) {
      const errorCode =
        err.error_code && typeof err.error_code === "string"
          ? `${err.error_code}: `
          : "";
      return `${errorCode}${err.error}`;
    }

    // Try message field (most common for Tauri errors)
    if (typeof err.message === "string" && err.message) {
      return err.message;
    }

    // Try to stringify the whole object for debugging
    try {
      const json = JSON.stringify(error);
      // If it's a valid JSON object with structure, try to extract meaningful info
      if (err.code && typeof err.code === "string") {
        return `${err.code}: ${err.message || json}`;
      }
      return json;
    } catch {
      // If stringification fails, return a generic message
      return "Unknown error occurred";
    }
  }

  // Fallback
  return String(error);
}

/**
 * The failure as the server stated it, with our own framing taken off.
 *
 * `wrapCommand` prefixes every rejected invoke with the name of the Tauri
 * command it came from. That is a fact about our call stack, not about what
 * went wrong, and it is worth keeping on the thrown `Error` — it is what makes
 * a console trace legible. It is worth nothing to a reader looking at a toast
 * that should read "deployments.apps 'api' is forbidden", so it comes off at
 * the last moment, where the message is shown rather than where it is made.
 */
export function verbatim(message: string): string {
  return message.replace(/^Tauri command '[^']*' failed: /, "");
}

/** {@link normalizeTauriError} for something about to be put on screen. */
export function errorToShow(error: unknown): string {
  return verbatim(normalizeTauriError(error));
}
