import { create } from "zustand";

/** Whether the reader opened Needs attention past its first rows: kept while the app runs, not across launches. */
export const useAttentionExpanded = create<{
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}>((set) => ({
  expanded: false,
  setExpanded: (expanded) => set({ expanded }),
}));
