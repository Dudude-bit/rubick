import { create } from "zustand";

/**
 * A shell asked for from outside the pod page (a peek's Shell, a row menu's),
 * held for the page that opens next. The address cannot carry it: a restored
 * tab and a link arrive with the same address, and neither is anyone asking.
 */
export interface ShellAsk {
  namespace: string;
  pod: string;
  at: number;
}

const FRESH_MS = 5_000;

interface ShellAskState {
  ask: ShellAsk | null;
  askFor: (namespace: string, pod: string) => void;
  drop: () => void;
}

export const useShellAskStore = create<ShellAskState>((set) => ({
  ask: null,
  askFor: (namespace, pod) => set({ ask: { namespace, pod, at: Date.now() } }),
  drop: () => set({ ask: null }),
}));

export function asksFor(
  ask: ShellAsk | null,
  namespace: string | undefined,
  pod: string | undefined,
  now = Date.now()
): boolean {
  return (
    ask !== null &&
    ask.namespace === namespace &&
    ask.pod === pod &&
    now - ask.at < FRESH_MS
  );
}
