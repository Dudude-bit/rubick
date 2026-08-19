import { Info, Package, Palette, Server, Stethoscope } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { en } from "@/i18n/catalogue";

type SettingsKey = keyof typeof en.settings;

export interface SettingsSectionDef {
  /** The URL segment, and the id every row indexes itself under. */
  id: string;
  /**
   * Catalogue keys rather than the words themselves: this is a module-level
   * array, so it cannot call the hook, and both readers — the nav and the
   * pane's heading — are components that can.
   */
  label: SettingsKey;
  icon: LucideIcon;
  /** One line under the pane's title, saying what kind of decision this is. */
  description: SettingsKey;
  /** True for a section whose answer is about the connected cluster. */
  clusterScoped?: boolean;
}

/**
 * Five sections, split by what kind of decision each holds. Integrations
 * used to be the sixth and earned its own door: what a cluster has is not a
 * preference of this app's, and mixing the two made both harder to find.
 *
 * The page used to be one scroll of eight groups, and the groups were
 * three different kinds of thing wearing the same shirt: a preference, the
 * several ways of reaching a cluster, and live state. Splitting them by
 * kind is what gives a category like Integrations a home instead of a
 * ninth slot in the pile.
 *
 * Two of the six hold no decision at all — About and Diagnostics answer
 * "what is this build" and "what can it see". They live here because that
 * is where a reader looks for them, not because the rule stretched to
 * cover them.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: "appearance",
    label: "sectionAppearance",
    icon: Palette,
    description: "sectionAppearanceHint",
  },
  {
    id: "clusters",
    label: "sectionClusters",
    icon: Server,
    description: "sectionClustersHint",
  },
  {
    id: "registries",
    label: "sectionRegistries",
    icon: Package,
    description: "sectionRegistriesHint",
  },
  {
    id: "diagnostics",
    label: "sectionDiagnostics",
    icon: Stethoscope,
    description: "sectionDiagnosticsHint",
  },
  {
    id: "about",
    label: "sectionAbout",
    icon: Info,
    description: "sectionAboutHint",
  },
] as const;

/**
 * Where a reader with no section in the URL lands.
 *
 * Appearance: the only section that needs no cluster, no file and no
 * credential to say something true.
 */
export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;
