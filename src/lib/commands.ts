import * as generatedCommands from "@/generated/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { logInfo } from "@/lib/logger";
import {
  credentialsExpired,
  expiryReason,
  isCredentialsExpired,
} from "@/lib/credentials";

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
type Wrapped<T> = {
  [K in keyof T]: T[K] extends AsyncFn
    ? (...args: Parameters<T[K]>) => ReturnType<T[K]>
    : T[K];
};

/**
 * A command slower than this names itself in the log. The threshold is the
 * point where a wait starts being felt; everything under it would be noise
 * on a log every command in the app passes through.
 */
const SLOW_COMMAND_MS = 500;

export function wrapCommand<T extends AsyncFn>(fn: T, commandName?: string): T {
  const withErrors = wrapErrors(fn, commandName);
  return (async (...args: Parameters<T>) => {
    const startedAt = performance.now();
    try {
      return await withErrors(...args);
    } finally {
      const ms = Math.round(performance.now() - startedAt);
      if (ms >= SLOW_COMMAND_MS) {
        logInfo(`${commandName ?? fn.name} took ${ms}ms`, {
          context: "slow-command",
        });
      }
    }
  }) as T;
}

function wrapErrors<T extends AsyncFn>(fn: T, commandName?: string): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      const name = commandName ?? (fn.name || "unknown");
      const message = normalizeTauriError(error);
      // Every call in the app comes through here, which is the whole reason
      // the check is here: a 401 is not about the request that got it — the
      // session is over and every other request is failing too. Noticing it
      // once, centrally, is what stops the next command added from
      // forgetting to.
      if (isCredentialsExpired(message)) {
        credentialsExpired(expiryReason(message));
      }
      throw new Error(`Tauri command '${name}' failed: ${message}`, {
        cause: error,
      });
    }
  }) as T;
}

/**
 * Eagerly wraps every command, rather than proxying them: in production
 * builds a module namespace object's properties are non-configurable and
 * non-writable, so a Proxy 'get' handler returning the wrapped function
 * violates the invariant and throws "Proxy handler's 'get' result of a
 * non-configurable and non-writable property should be the same value as the
 * target's property".
 */
function wrapAllCommands<T extends Record<string, unknown>>(
  commands: T
): Wrapped<T> {
  const result = {} as Record<string, unknown>;

  for (const key of Object.keys(commands)) {
    const value = commands[key];
    if (typeof value === "function") {
      result[key] = wrapCommand(value as AsyncFn, key);
    } else {
      result[key] = value;
    }
  }

  return result as Wrapped<T>;
}

export const commands = wrapAllCommands(generatedCommands);
