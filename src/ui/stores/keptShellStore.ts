import { create } from "zustand";

import { commands } from "@/lib/commands";

/**
 * The shells the reader started, each kept by the scope tab it was started in.
 *
 * A shell is somebody's work. Switching to another tab parks it with its tab,
 * and coming back to its page attaches to the same session, with what it
 * printed meanwhile. It ends with its owner: when the reader ends it, when its
 * tab closes, or when its tab leaves the pod's page.
 */
export interface KeptShell {
  id: string;
  /** The scope tab it was started in. */
  tab: string;
  context: string;
  namespace: string;
  pod: string;
  container: string;
}

interface KeptShellState {
  shells: KeptShell[];
  keep: (shell: KeptShell) => void;
  forget: (id: string) => void;
}

const scrollbacks = new Map<string, string>();

/** About a busy screen's worth of xterm's own scrollback, in characters. */
const SCROLLBACK = 256 * 1024;

export const useKeptShellStore = create<KeptShellState>((set) => ({
  shells: [],
  keep: (shell) =>
    set((state) => ({
      shells: [...state.shells.filter((each) => each.id !== shell.id), shell],
    })),
  forget: (id) => {
    scrollbacks.delete(id);
    set((state) =>
      state.shells.some((shell) => shell.id === id)
        ? { shells: state.shells.filter((shell) => shell.id !== id) }
        : state
    );
  },
}));

/** What a kept shell printed, for the pane that attaches to it next. */
export function heard(id: string, data: string): void {
  if (!useKeptShellStore.getState().shells.some((shell) => shell.id === id))
    return;
  let text = (scrollbacks.get(id) ?? "") + data;
  if (text.length > SCROLLBACK) {
    const cut = text.length - SCROLLBACK;
    const line = text.indexOf("\n", cut);
    text = text.slice(line === -1 ? cut : line + 1);
  }
  scrollbacks.set(id, text);
}

export function scrollbackOf(id: string | null): string {
  return id ? (scrollbacks.get(id) ?? "") : "";
}

/** End a shell on purpose: let go of it at once, and have the backend hang it up. */
export function endShell(id: string): Promise<void> {
  useKeptShellStore.getState().forget(id);
  return commands.closeTerminal(id).catch(() => undefined);
}

export interface ShellPlace {
  tab: string;
  context: string | null;
  namespace: string | undefined;
  pod: string | undefined;
}

/** The shell a tab keeps on this pod, if it keeps one. */
export function keptOn(
  shells: KeptShell[],
  { tab, context, namespace, pod }: ShellPlace
): KeptShell | undefined {
  return shells.find(
    (shell) =>
      shell.tab === tab &&
      shell.context === (context ?? "") &&
      shell.namespace === namespace &&
      shell.pod === pod
  );
}

/** Whether a tab keeps a live shell, which a link must not navigate away. */
export function tabKeepsShell(tab: string): boolean {
  return useKeptShellStore.getState().shells.some((shell) => shell.tab === tab);
}

export type Stranded = { shell: KeptShell; why: "tabClosed" | "leftPage" };

/**
 * The first kept shell its owner has let go of, if any: its tab is gone, or
 * its tab is the one on screen, has landed, and stands on a page that is not
 * the pod's. A tab on its way somewhere is judged when it lands, and so is a
 * window whose router is still between two routes (`landedOn` null).
 */
export function strandedShell(
  shells: KeptShell[],
  at: {
    ids: readonly string[];
    activeId: string;
    pendingHref: string | null;
    landedOn: string | null;
  },
  pageOf: (shell: KeptShell) => string
): Stranded | null {
  for (const shell of shells) {
    if (!at.ids.includes(shell.tab)) return { shell, why: "tabClosed" };
    if (
      shell.tab === at.activeId &&
      at.pendingHref === null &&
      at.landedOn !== null &&
      at.landedOn !== pageOf(shell)
    )
      return { shell, why: "leftPage" };
  }
  return null;
}
