/**
 * Whether helm and kubectl are on this machine, asked once per session and
 * again only on demand or after the tool paths change.
 *
 * @module stores/dependenciesStore
 */

import { create } from "zustand";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { CliAvailability } from "@/generated/types";

type Tool = "helm" | "kubectl";

interface DependenciesState {
  helm: CliAvailability | null;
  kubectl: CliAvailability | null;
  isChecking: boolean;
  lastChecked: Date | null;

  /** Asks again, joining a question already in flight rather than queueing a second one. */
  checkHelmAvailability: () => Promise<void>;
  checkKubectlAvailability: () => Promise<void>;
  /** Asks again after the tool paths changed; an answer in flight was about the old ones, so this one waits for it and asks once more. */
  recheckAfterPathChange: () => Promise<void>;
  /** Asks only about a tool with no answer yet; a screen calls this on mount. */
  ensureDependencies: () => Promise<void>;
}

const ask: Record<Tool, () => Promise<CliAvailability>> = {
  helm: () => commands.checkHelmAvailability(),
  kubectl: () => commands.checkKubectlAvailability(),
};

const inFlight = new Map<Tool, Promise<void>>();
const queued = new Map<Tool, Promise<void>>();

export const useDependenciesStore = create<DependenciesState>((set, get) => {
  const check = (tool: Tool): Promise<void> => {
    const running = inFlight.get(tool);
    if (running) return running;
    set({ isChecking: true });
    const run = ask[tool]()
      .catch((error): CliAvailability => ({
        available: false,
        version: null,
        error: errorToShow(error),
        path: null,
        searchedPaths: [],
      }))
      .then((result) => {
        inFlight.delete(tool);
        set({
          [tool]: result,
          isChecking: inFlight.size > 0,
          lastChecked: new Date(),
        } as Partial<DependenciesState>);
      });
    inFlight.set(tool, run);
    return run;
  };

  const checkAfter = (tool: Tool): Promise<void> => {
    const running = inFlight.get(tool);
    if (!running) return check(tool);
    const waiting = queued.get(tool);
    if (waiting) return waiting;
    const next = running.then(() => {
      queued.delete(tool);
      return check(tool);
    });
    queued.set(tool, next);
    return next;
  };

  return {
    helm: null,
    kubectl: null,
    isChecking: false,
    lastChecked: null,
    checkHelmAvailability: () => check("helm"),
    checkKubectlAvailability: () => check("kubectl"),
    recheckAfterPathChange: async () => {
      await Promise.all([checkAfter("helm"), checkAfter("kubectl")]);
    },
    ensureDependencies: async () => {
      const state = get();
      await Promise.all(
        (["helm", "kubectl"] as const)
          .filter((tool) => state[tool] === null)
          .map(check)
      );
    },
  };
});
