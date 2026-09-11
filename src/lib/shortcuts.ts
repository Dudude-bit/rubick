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
import { getResourceListUrl, ResourceType } from "@/lib/resource-registry";

export type ShortcutSection =
  "global" | "navigate" | "page" | "tabs" | "table" | "logs" | "builder";

export interface Shortcut {
  id: string;
  section: ShortcutSection;
  /** One entry per key pressed in turn: `["g", "p"]` is a chord. `mod` is ⌘ or Ctrl. */
  keys: string[];
  labelKey: keyof typeof en.shortcuts;
  /** Where a chord goes. Only the navigate section has one. */
  path?: string;
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

  {
    id: "goOverview",
    section: "navigate",
    keys: ["g", "o"],
    labelKey: "goOverview",
    path: "/",
  },
  {
    id: "goPods",
    section: "navigate",
    keys: ["g", "p"],
    labelKey: "goPods",
    path: getResourceListUrl(ResourceType.Pod),
  },
  {
    id: "goDeployments",
    section: "navigate",
    keys: ["g", "d"],
    labelKey: "goDeployments",
    path: getResourceListUrl(ResourceType.Deployment),
  },
  {
    id: "goServices",
    section: "navigate",
    keys: ["g", "s"],
    labelKey: "goServices",
    path: getResourceListUrl(ResourceType.Service),
  },
  {
    id: "goIngresses",
    section: "navigate",
    keys: ["g", "i"],
    labelKey: "goIngresses",
    path: getResourceListUrl(ResourceType.Ingress),
  },
  {
    id: "goNodes",
    section: "navigate",
    keys: ["g", "n"],
    labelKey: "goNodes",
    path: getResourceListUrl(ResourceType.Node),
  },
  {
    id: "goEvents",
    section: "navigate",
    keys: ["g", "e"],
    labelKey: "goEvents",
    path: getResourceListUrl(ResourceType.Event),
  },
  {
    id: "goJobs",
    section: "navigate",
    keys: ["g", "j"],
    labelKey: "goJobs",
    path: getResourceListUrl(ResourceType.Job),
  },
  {
    id: "goConfigMaps",
    section: "navigate",
    keys: ["g", "c"],
    labelKey: "goConfigMaps",
    path: getResourceListUrl(ResourceType.ConfigMap),
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

  {
    id: "deleteSelection",
    section: "builder",
    keys: ["del"],
    labelKey: "deleteSelection",
  },
  {
    id: "selectAll",
    section: "builder",
    keys: ["mod+a"],
    labelKey: "selectAll",
  },
  {
    id: "invertSelection",
    section: "builder",
    keys: ["mod+shift+i"],
    labelKey: "invertSelection",
  },
];

export const SECTIONS: readonly ShortcutSection[] = [
  "global",
  "navigate",
  "page",
  "tabs",
  "table",
  "logs",
  "builder",
];

/**
 * Every file allowed to own a `keydown` listener, with what it owns.
 *
 * The test reads this and the tree. A new listener anywhere else fails it,
 * which is how the overlay stays complete without anyone remembering to
 * update it.
 */
export const KEYDOWN_SITES: Readonly<Record<string, string>> = {
  "src/hooks/useShortcuts.ts": "the central handler: ?, g-chords, page keys",
  "src/components/layout/CommandPalette.tsx": "mod+k",
  "src/components/settings/SettingsOverlay.tsx": "mod+,",
  "src/hooks/useCopyLink.ts": "mod+shift+c",
  "src/hooks/useScopeTabs.ts": "ctrl+tab, mod+t, mod+w, mod+1..9",
  "src/components/logs/LogViewer.tsx": "0..9 solo a container",
  "src/features/infrastructure/useBuilderKeyboardShortcuts.ts":
    "del, mod+a, mod+shift+i",
  "src/lib/window-activity.ts":
    "not a shortcut: notices that the reader is here",
};

export function chordsOf(): Shortcut[] {
  return SHORTCUTS.filter((entry) => entry.section === "navigate");
}

export function pageKeysOf(): Shortcut[] {
  return SHORTCUTS.filter((entry) => entry.section === "page");
}
