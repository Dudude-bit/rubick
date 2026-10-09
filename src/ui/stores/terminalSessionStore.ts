import { create } from "zustand";

import type { TerminalSessionInfo } from "@/generated/types";

/**
 * The shells the backend holds open in containers, as the backend lists them.
 *
 * Only ever replaced whole, from `list_terminal_sessions` and the
 * `terminal-sessions` event: a list kept by the panes adding and removing
 * entries lost a shell the moment its pane went away, while the shell ran on.
 */
interface TerminalSessionState {
  /** `null` until the backend has answered once. */
  sessions: TerminalSessionInfo[] | null;
  /** Why the list could not be read, while nothing newer has arrived. */
  failed: string | null;
  replace: (sessions: TerminalSessionInfo[]) => void;
  fail: (why: string) => void;
}

export const useTerminalSessionStore = create<TerminalSessionState>((set) => ({
  sessions: null,
  failed: null,
  replace: (sessions) => set({ sessions, failed: null }),
  fail: (failed) => set({ failed }),
}));

const NONE: TerminalSessionInfo[] = [];

/** The list as far as anything has been heard, for a count or a lookup. */
export const heardSessions = (state: TerminalSessionState) =>
  state.sessions ?? NONE;
