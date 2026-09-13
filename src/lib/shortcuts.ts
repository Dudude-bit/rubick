import type { en } from "@/i18n/catalogue";

export type ShortcutKey = keyof (typeof en)["shortcuts"];

export interface Shortcut {
  /** Logical keys, `mod+K` style; several where two combinations do one thing. */
  keys: string[];
  says: ShortcutKey;
}

export interface ShortcutGroup {
  title: ShortcutKey;
  items: Shortcut[];
}

/**
 * Every key the app answers to, as the overlay lists them. A row here is a
 * promise: the handler it names exists, in the file the group names in its
 * comment, and a key with no handler is not written down.
 */
export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    // CommandPalette.tsx, SettingsOverlay.tsx, useCopyLink.ts, ShortcutsOverlay.tsx
    title: "groupEverywhere",
    items: [
      { keys: ["mod+K"], says: "search" },
      { keys: ["mod+,"], says: "settings" },
      { keys: ["mod+shift+C"], says: "copyLink" },
      { keys: ["?"], says: "thisList" },
      { keys: ["Esc"], says: "closeDialog" },
    ],
  },
  {
    // useScopeTabs.ts
    title: "groupTabs",
    items: [
      { keys: ["mod+T"], says: "newTab" },
      { keys: ["mod+W"], says: "closeTab" },
      { keys: ["ctrl+Tab", "ctrl+shift+Tab"], says: "cycleTabs" },
      { keys: ["mod+1", "mod+9"], says: "tabByNumber" },
    ],
  },
  {
    // CommandPalette.tsx
    title: "groupPalette",
    items: [
      { keys: ["↑", "↓"], says: "moveSelection" },
      { keys: ["↵"], says: "openHit" },
      { keys: ["mod+↵"], says: "openHitBehind" },
      { keys: ["Tab"], says: "completeCluster" },
      { keys: ["⌫"], says: "dropScope" },
    ],
  },
  {
    // data-table.tsx, useLinkGesture.ts
    title: "groupLists",
    items: [
      { keys: ["↑", "↓"], says: "moveRow" },
      { keys: ["Home", "End"], says: "firstLastRow" },
      { keys: ["↵"], says: "openRow" },
      { keys: ["mod+↵"], says: "openRowBehind" },
      { keys: ["shift+↵"], says: "openRowFront" },
    ],
  },
  {
    // PeekPanel.tsx
    title: "groupPeek",
    items: [
      { keys: ["↵"], says: "peekFullPage" },
      { keys: ["←", "→"], says: "peekResize" },
      { keys: ["Esc"], says: "peekClose" },
    ],
  },
  {
    // FilesTab.tsx
    title: "groupFiles",
    items: [
      { keys: ["↑", "↓"], says: "moveRow" },
      { keys: ["↵"], says: "openEntry" },
      { keys: ["⌫"], says: "upOneLevel" },
      { keys: ["mod+S"], says: "download" },
    ],
  },
  {
    // LogViewer.tsx, LogList.tsx, LogDensityStrip.tsx
    title: "groupLogs",
    items: [
      { keys: ["1", "9"], says: "soloContainer" },
      { keys: ["0"], says: "allContainers" },
      { keys: ["mod+A"], says: "selectRendered" },
      { keys: ["←", "→"], says: "stripMove" },
      { keys: ["shift+←", "shift+→"], says: "stripRange" },
      { keys: ["↵"], says: "stripJump" },
      { keys: ["Esc"], says: "stripClear" },
    ],
  },
];
