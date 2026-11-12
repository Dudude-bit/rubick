import { create } from "zustand";
import { commands } from "@/lib/commands";
import { keptByName } from "@/lib/kept-by-name";
import { currentConnection } from "@/lib/refusals";
import { useClusterStore } from "@/stores/clusterStore";
import type { ManifestResult } from "@/generated/types";

export interface HistoryEntry {
  timestamp: number;
  content: string;
  label?: string;
}

/**
 * How a validate or an apply ended, for the result block. `unanswered` is an
 * answer of its own: the server may have stored what nobody confirmed.
 */
export interface ResultShown {
  verdict: "ok" | "failed" | "unanswered";
  stdout: string;
  stderr: string;
}

export interface ResourceKey {
  kind: string;
  name: string;
  namespace?: string;
}

interface YamlEditorState {
  // Dialog state
  open: boolean;
  title: string;
  resourceKey: ResourceKey | null;
  /** The cluster the manifest was read from, the only one it may be applied to. */
  openedOn: string | null;
  readOnly: boolean;

  // Content
  originalContent: string;
  editedContent: string;

  // UI state
  isLoading: boolean;
  isValidating: boolean;
  isApplying: boolean;
  showDiff: boolean;

  // Validation/Apply results
  validationResult: ManifestResult | null;
  applyResult: ResultShown | null;

  // History (per resource, stored by key)
  history: Record<string, HistoryEntry[]>;

  // Actions
  openEditor: (params: {
    title: string;
    resourceKey: ResourceKey;
    fetchYaml: () => Promise<string>;
    readOnly?: boolean;
  }) => Promise<void>;
  closeEditor: () => void;
  setEditedContent: (content: string) => void;
  setShowDiff: (show: boolean) => void;
  setValidationResult: (result: ManifestResult | null) => void;
  setApplyResult: (result: ResultShown | null) => void;
  setIsValidating: (validating: boolean) => void;
  setIsApplying: (applying: boolean) => void;
  /** Filed under `of`, the object it was applied to; the open editor's if not given. */
  addHistoryEntry: (
    content: string,
    label?: string,
    of?: Pick<YamlEditorState, "resourceKey" | "openedOn">
  ) => void;
  restoreFromHistory: (timestamp: number) => void;
  getResourceHistory: () => HistoryEntry[];
  resetToOriginal: () => void;
  /** Whether the buffer parsed and was reformatted. */
  formatYaml: () => Promise<boolean>;
}

/**
 * What an object's history is filed under: the cluster first, since the same
 * kind, namespace and name on another cluster is another object.
 */
function historyKey({
  resourceKey: key,
  openedOn,
}: Pick<YamlEditorState, "resourceKey" | "openedOn">): string {
  if (!key) return "";
  return `${openedOn ?? ""}:${key.kind}:${key.namespace || "cluster"}:${key.name}`;
}

/** Moves on every open and every close, so a read can tell whether the editor
 *  on screen is still the one that asked for it. */
let opening = 0;

/**
 * Which opening of the editor is on screen. An apply or a validate answers
 * after a wait, and the editor may have been closed or opened on another
 * object since: the answer belongs to the opening that asked.
 */
export const editorSession = (): number => opening;

export const useYamlEditorStore = create<YamlEditorState>((set, get) => ({
  // Initial state
  open: false,
  title: "",
  resourceKey: null,
  openedOn: null,
  readOnly: false,
  originalContent: "",
  editedContent: "",
  isLoading: false,
  isValidating: false,
  isApplying: false,
  showDiff: false,
  validationResult: null,
  applyResult: null,
  history: {},

  openEditor: async ({ title, resourceKey, fetchYaml, readOnly = false }) => {
    const connection = currentConnection();
    const mine = ++opening;
    const openedOn = useClusterStore.getState().currentContext;
    set({
      open: true,
      title,
      resourceKey,
      openedOn,
      readOnly,
      originalContent: "",
      editedContent: "",
      isLoading: true,
      validationResult: null,
      applyResult: null,
      showDiff: false,
    });

    try {
      // Load history for this resource from backend
      const key = historyKey({ resourceKey, openedOn });
      if (key) {
        try {
          const entries = await commands.getYamlHistory(key);
          const history = entries.map((e) => ({
            timestamp: e.timestamp,
            content: e.content,
            label: e.label ?? undefined,
          }));
          set((state) => ({
            history: { ...state.history, [key]: history },
          }));
        } catch (error) {
          console.error("Failed to load YAML history:", error);
        }
      }

      const content = await fetchYaml();
      // Closed or replaced while it read: the answer is nobody's.
      if (mine !== opening) return;
      // The read may have left after the window moved, and then it is another
      // cluster's manifest under this one's name: nothing is shown.
      if (connection !== currentConnection()) {
        get().closeEditor();
        return;
      }
      set({
        originalContent: content,
        editedContent: content,
        isLoading: false,
      });
    } catch (error) {
      if (mine !== opening) return;
      set({
        open: false,
        isLoading: false,
      });
      throw error;
    }
  },

  closeEditor: () => {
    opening++;
    set({
      open: false,
      title: "",
      resourceKey: null,
      openedOn: null,
      readOnly: false,
      originalContent: "",
      editedContent: "",
      isLoading: false,
      isValidating: false,
      isApplying: false,
      validationResult: null,
      applyResult: null,
      showDiff: false,
    });
  },

  setEditedContent: (content) => {
    set({
      editedContent: content,
      validationResult: null,
      applyResult: null,
    });
  },

  setShowDiff: (show) => {
    set({ showDiff: show });
  },

  setValidationResult: (result) => {
    set({ validationResult: result });
  },

  setApplyResult: (result) => {
    set({ applyResult: result });
  },

  setIsValidating: (validating) => {
    set({ isValidating: validating });
  },

  setIsApplying: (applying) => {
    set({ isApplying: applying });
  },

  addHistoryEntry: (content, label, of = get()) => {
    const { history } = get();
    const key = historyKey(of);
    if (!key) return;

    const newEntry: HistoryEntry = {
      timestamp: Date.now(),
      content,
      label,
    };

    const currentHistory = history[key] || [];
    // Add to front, limit size
    const updatedHistory = [newEntry, ...currentHistory].slice(0, 20);

    set({
      history: {
        ...history,
        [key]: updatedHistory,
      },
    });

    // Save to backend (fire and forget)
    commands
      .addYamlHistoryEntry(key, {
        timestamp: newEntry.timestamp,
        content: newEntry.content,
        label: newEntry.label ?? undefined,
      })
      .catch((error) => {
        console.error("Failed to save YAML history entry:", error);
      });
  },

  restoreFromHistory: (timestamp) => {
    const { history } = get();
    const key = historyKey(get());
    if (!key) return;

    const entry = history[key]?.find((e) => e.timestamp === timestamp);
    if (entry) {
      set({
        editedContent: entry.content,
        validationResult: null,
        applyResult: null,
      });
    }
  },

  getResourceHistory: () => {
    const { history } = get();
    const key = historyKey(get());
    if (!key) return [];
    return history[key] || [];
  },

  resetToOriginal: () => {
    const { originalContent } = get();
    set({
      editedContent: originalContent,
      validationResult: null,
      applyResult: null,
    });
  },

  formatYaml: async () => {
    const { editedContent } = get();
    try {
      const { dump, load } = await import("js-yaml");
      const parsed = load(editedContent);
      const formatted = dump(parsed, {
        indent: 2,
        lineWidth: -1, // No line wrapping
        noRefs: true,
        sortKeys: false,
      });
      set({
        editedContent: formatted,
        validationResult: null,
        applyResult: null,
      });
      return true;
    } catch {
      // A buffer that does not parse is left as it is.
      return false;
    }
  },
}));

// The manifest was read from the cluster the name meant then, and Apply goes
// to whichever cluster it means now.
keptByName(() => useYamlEditorStore.getState().closeEditor());
