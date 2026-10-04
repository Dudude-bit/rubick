/**
 * Every key the app answers to, in one table.
 *
 * The overlay behind `?` draws this list, the central handler in
 * `useShortcuts` reads its chords from it, and `shortcuts.test.ts` walks the
 * source tree for `keydown` listeners and refuses any file that is not named
 * here. That last part is the point: a shortcut added in a component's own
 * listener used to be invisible to everything, and the overlay would have
 * quietly stopped being complete the first time somebody did that.
 */

import type { en } from "@/i18n/catalogue";
import { clusterLink, listLink, type AppLink } from "@/lib/links";
import { ResourceType } from "@/lib/resource-registry";

export type ShortcutSection =
  | "global"
  | "navigate"
  | "page"
  | "tabs"
  | "table"
  | "logs";

export interface Shortcut {
  id: string;
  section: ShortcutSection;
  /** One entry per key pressed in turn: `["g", "p"]` is a chord. `mod` is ⌘ or Ctrl. */
  keys: string[];
  labelKey: keyof typeof en.shortcuts;
  /** Where a chord goes. Only the navigate section has one. */
  path?: AppLink;
  /** Which detail tab a page key opens. Only the page section has one. */
  tab?: string;
}

/** How long the second key of a chord may take. */
export const CHORD_MS = 1500;

/** The event the detail layout listens for: open this tab if the page has it. */
export const DETAIL_TAB_OPEN = "detail-tab-open";

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", section: "global", keys: ["mod+k"], labelKey: "palette" },
  { id: "settings", section: "global", keys: ["mod+,"], labelKey: "settings" },
  {
    id: "copyLink",
    section: "global",
    keys: ["mod+shift+c"],
    labelKey: "copyLink",
  },
  { id: "help", section: "global", keys: ["?"], labelKey: "help" },
  { id: "escape", section: "global", keys: ["esc"], labelKey: "escape" },
  // Claimed only on the screen that *is* the cluster list, which is why the
  // table names the file rather than the hook: the same component renders a
  // pane inside a resource page and deliberately leaves the key alone there.
  {
    id: "filterClusters",
    section: "global",
    keys: ["mod+f"],
    labelKey: "filterClusters",
  },
  // Advertised on screen where they work, and so owed a place here: the
  // overlay is titled "every key the app answers to", and the Files tab was
  // printing its own hint for a key this table had never heard of.
  {
    id: "downloadFile",
    section: "table",
    keys: ["mod+s"],
    labelKey: "downloadFile",
  },
  {
    id: "upADirectory",
    section: "table",
    keys: ["del"],
    labelKey: "upADirectory",
  },
  {
    id: "selectLogs",
    section: "logs",
    keys: ["mod+a"],
    labelKey: "selectLogs",
  },
  {
    id: "connectCluster",
    section: "global",
    keys: ["enter"],
    labelKey: "connectCluster",
  },
  {
    id: "scopeAnother",
    section: "global",
    keys: ["mod+enter"],
    labelKey: "scopeAnother",
  },

  {
    id: "goOverview",
    section: "navigate",
    keys: ["g", "o"],
    labelKey: "goOverview",
    path: clusterLink(),
  },
  {
    id: "goPods",
    section: "navigate",
    keys: ["g", "p"],
    labelKey: "goPods",
    path: listLink(ResourceType.Pod),
  },
  {
    id: "goDeployments",
    section: "navigate",
    keys: ["g", "d"],
    labelKey: "goDeployments",
    path: listLink(ResourceType.Deployment),
  },
  {
    id: "goServices",
    section: "navigate",
    keys: ["g", "s"],
    labelKey: "goServices",
    path: listLink(ResourceType.Service),
  },
  {
    id: "goIngresses",
    section: "navigate",
    keys: ["g", "i"],
    labelKey: "goIngresses",
    path: listLink(ResourceType.Ingress),
  },
  {
    id: "goNodes",
    section: "navigate",
    keys: ["g", "n"],
    labelKey: "goNodes",
    path: listLink(ResourceType.Node),
  },
  {
    id: "goEvents",
    section: "navigate",
    keys: ["g", "e"],
    labelKey: "goEvents",
    path: listLink(ResourceType.Event),
  },
  {
    id: "goJobs",
    section: "navigate",
    keys: ["g", "j"],
    labelKey: "goJobs",
    path: listLink(ResourceType.Job),
  },
  {
    id: "goConfigMaps",
    section: "navigate",
    keys: ["g", "c"],
    labelKey: "goConfigMaps",
    path: listLink(ResourceType.ConfigMap),
  },

  {
    id: "tabOverview",
    section: "page",
    keys: ["o"],
    labelKey: "tabOverview",
    tab: "overview",
  },
  {
    id: "tabLogs",
    section: "page",
    keys: ["l"],
    labelKey: "tabLogs",
    tab: "logs",
  },
  {
    id: "tabYaml",
    section: "page",
    keys: ["y"],
    labelKey: "tabYaml",
    tab: "yaml",
  },
  {
    id: "tabEvents",
    section: "page",
    keys: ["e"],
    labelKey: "tabEvents",
    tab: "events",
  },

  { id: "nextTab", section: "tabs", keys: ["ctrl+tab"], labelKey: "nextTab" },
  {
    id: "previousTab",
    section: "tabs",
    keys: ["ctrl+shift+tab"],
    labelKey: "previousTab",
  },
  { id: "newTab", section: "tabs", keys: ["mod+t"], labelKey: "newTab" },
  { id: "closeTab", section: "tabs", keys: ["mod+w"], labelKey: "closeTab" },
  { id: "nthTab", section: "tabs", keys: ["mod+1…9"], labelKey: "nthTab" },

  { id: "rowMove", section: "table", keys: ["↑", "↓"], labelKey: "rowMove" },
  { id: "rowOpen", section: "table", keys: ["enter"], labelKey: "rowOpen" },

  {
    id: "soloContainer",
    section: "logs",
    keys: ["1…9"],
    labelKey: "soloContainer",
  },
  {
    id: "allContainers",
    section: "logs",
    keys: ["0"],
    labelKey: "allContainers",
  },
];

export const SECTIONS: readonly ShortcutSection[] = [
  "global",
  "navigate",
  "page",
  "tabs",
  "table",
  "logs",
];

/**
 * Every file allowed to own a `keydown` listener, with what it owns.
 *
 * The test reads this and the tree. A new listener anywhere else fails it,
 * which is how the overlay stays complete without anyone remembering to
 * update it.
 */
export const KEYDOWN_SITES: Readonly<Record<string, string>> = {
  "src/ui/hooks/useShortcuts.ts": "the central handler: ?, g-chords, page keys",
  "src/ui/components/layout/CommandPalette.tsx": "mod+k",
  "src/ui/components/settings/SettingsOverlay.tsx": "mod+,",
  "src/ui/hooks/useCopyLink.ts": "mod+shift+c",
  "src/ui/hooks/useScopeTabs.ts": "ctrl+tab, mod+t, mod+w, mod+1..9",
  "src/ui/components/logs/LogViewer.tsx": "0..9 solo a container",
  "src/ui/components/cluster/ClusterList.tsx":
    "mod+f focuses the cluster filter, on the front door only",
  "src/ui/components/layout/ScopeTabs.tsx":
    "mod+click and mod+Enter add a namespace instead of replacing it",
  "src/ui/components/logs/LogList.tsx":
    "mod+a selects the rendered window, not the whole buffer",
  "src/ui/components/files/FilesTab.tsx": "mod+s downloads, Backspace goes up",
  "src/ui/lib/window-activity.ts":
    "not a shortcut: notices that the reader is here",
};

export function chordsOf(): Shortcut[] {
  return SHORTCUTS.filter((entry) => entry.section === "navigate");
}

export function pageKeysOf(): Shortcut[] {
  return SHORTCUTS.filter((entry) => entry.section === "page");
}
