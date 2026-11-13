/**
 * Whether the Activity panel is open, and on which tab.
 *
 * It used to be `useState` inside the panel, which meant the only way in was
 * the status-bar trigger — and a user with a port-forward running looked for
 * "port forwards", found a line reading "1 active" among `dark · 239 pods ·
 * 8 problems`, and concluded the app had no port-forward management at all.
 *
 * Lifted out so anything can open it by name: the command palette, and the
 * toast that announced the forward in the first place, which is the moment
 * somebody actually wants it.
 *
 * @module stores/activityPanelStore
 */

import { create } from "zustand";

export type ActivityTab = "ports" | "terminals" | "watching" | "writes";

interface ActivityPanelState {
  open: boolean;
  tab: ActivityTab;
  /** The tab with the newest entry nobody has opened yet. */
  unseen: ActivityTab | null;
  markUnseen: (tab: ActivityTab) => void;
  setOpen: (open: boolean) => void;
  /** Open the panel with a tab already chosen. */
  openOn: (tab: ActivityTab) => void;
}

export const useActivityPanelStore = create<ActivityPanelState>((set) => ({
  open: false,
  tab: "ports",
  unseen: null,
  markUnseen: (unseen) =>
    set((state) => (state.open && state.tab === unseen ? state : { unseen })),
  setOpen: (open) => set({ open }),
  openOn: (tab) =>
    set((state) => ({
      open: true,
      tab,
      unseen: state.unseen === tab ? null : state.unseen,
    })),
}));
