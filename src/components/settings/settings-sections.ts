import {
  Info,
  Package,
  Palette,
  Plug,
  Server,
  Stethoscope,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SettingsSectionDef {
  /** The URL segment, and the id every row indexes itself under. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** One line under the pane's title, saying what kind of decision this is. */
  description: string;
  /**
   * Words the section answers to that none of its rows print. Only the
   * nav reads these; they never make a row match on their own.
   */
  keywords: string;
  /** True for a section whose answer is about the connected cluster. */
  clusterScoped?: boolean;
}

/**
 * Six sections, split by what kind of decision each holds.
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
    label: "Appearance",
    icon: Palette,
    description: "Chosen once, applies everywhere, belongs to you.",
    keywords: "appearance theme colour color dark light display",
  },
  {
    id: "clusters",
    label: "Clusters",
    icon: Server,
    description:
      "How the app reaches a cluster: the file that names them, the identity that authenticates, and the binaries it shells out to.",
    keywords:
      "clusters kubeconfig context cloud profile gcp azure aws cli helm kubectl binary path auth",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    description:
      "What this cluster has that the app can use. Most of it is detected by whether its CRDs exist; anything with its own address is configured here, per cluster.",
    keywords:
      "integrations extensions cert-manager traefik prometheus argo flux istio crd",
    clusterScoped: true,
  },
  {
    id: "registries",
    label: "Registries",
    icon: Package,
    description: "Where images are pulled from, and what reaches them.",
    keywords:
      "registries registry image pull credentials docker ecr gcr harbor auth token",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: Stethoscope,
    description: "What this app can see of the machine it runs on.",
    keywords:
      "diagnostics path plugin plugins kubectl krew oidc environment troubleshoot debug report copy",
  },
  {
    id: "about",
    label: "About",
    icon: Info,
    description: "What this build is, and how it replaces itself.",
    keywords: "about version tauri framework update updates release",
  },
] as const;

/**
 * Where a reader with no section in the URL lands.
 *
 * Appearance: the only section that needs no cluster, no file and no
 * credential to say something true.
 */
export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;
