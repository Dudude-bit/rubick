/**
 * Per-cluster identity: which flavour of Kubernetes a context talks to,
 * and which colour stands for it across the window.
 *
 * Acting on the wrong cluster is the expensive mistake this tool can cause,
 * so the colour is repeated in three always-visible places (the window edge
 * strip, the tab dot and the provider mark), and both the provider and the
 * colour are derived from the context name alone — they have to be decided
 * before anyone has configured anything.
 *
 * The colours are the app's and are here. Which context names belong to
 * which vendor, and what each vendor's mark looks like, live in
 * `src/integrations/`.
 */

import {
  flavourOf,
  flavourOfContext,
  type ClusterProvider,
} from "@/integrations";

export type { ClusterProvider };

/**
 * Detect the provider from the context name.
 *
 * Names are tested in registry order, most specific vendor first; which
 * names belong to which vendor is that vendor's knowledge. `generic` is not
 * a vendor — it is what is left when none of them claims the name.
 */
export function detectProvider(context: string): ClusterProvider {
  return flavourOfContext(context)?.id ?? "generic";
}

/** Right-aligned label in the context list. Local clusters read "LOCAL". */
export function providerLabel(provider: ClusterProvider): string {
  return flavourOf(provider)?.label ?? "K8S";
}

/**
 * Split a context name into the boilerplate its provider prepends and the
 * part that actually names the cluster.
 *
 * `arn:aws:eks:us-east-1:1234:cluster/prod` and
 * `gke_acme-prod_europe-west1_main` are fifty characters of account number
 * followed by the one word a reader scanning a list wants. Neither half can
 * be dropped — the account and the project are what tell two `prod`s apart —
 * so the prefix is kept and dimmed. The full name is never rewritten:
 * `prefix + label` is the input.
 */
export function clusterNameParts(context: string): {
  prefix: string;
  label: string;
} {
  const separator = flavourOfContext(context)?.nameSeparator;
  const cut = separator ? context.lastIndexOf(separator) : -1;
  // A separator at the very end leaves nothing to read, so the whole name
  // stays at full contrast rather than dimming into a blank row.
  return cut > 0 && cut < context.length - 1
    ? { prefix: context.slice(0, cut + 1), label: context.slice(cut + 1) }
    : { prefix: "", label: context };
}

/**
 * The identity palette. Role tokens, not hex: the colour is a runtime
 * value carried in a CSS custom property, but the values it can take are
 * still the theme's. `--err` is reserved for production and never
 * assigned by the hash, so a red dot always means "be careful".
 */
const IDENTITY_PALETTE = [
  "hsl(var(--info))",
  "hsl(var(--ok))",
  "hsl(var(--warn))",
  "hsl(var(--fg-mut))",
] as const;

export const DANGER_CLUSTER_COLOR = "hsl(var(--err))";

/**
 * The hues a cluster's colour can be *set* to by hand.
 *
 * The same ring `identHue` draws from, thinned to the rungs that survive
 * being 6px wide on opposite ends of a tab strip. Five, not more: the ring's
 * two greens are a near-miss on each other at that size, and the rung past
 * pink is the magenta that sits next to `--err`, which is what production
 * wears.
 *
 * Only the hue is chosen here. Saturation and lightness stay in `--ident-s` /
 * `--ident-l`, which are per-theme and already calibrated for text, so a hue
 * picked on the dark canvas cannot vanish on the near-white one.
 * `tokens.test.ts` holds both themes to that.
 */
export const CLUSTER_HUES = [132, 184, 224, 274, 318] as const;

/** A chosen hue as a CSS colour, the same shape the rest of the app uses. */
export function clusterHueColor(hue: number): string {
  return `hsl(${hue} var(--ident-s) var(--ident-l))`;
}

/**
 * Colour for a context, as a CSS colour usable in `--cluster`.
 *
 * Anything that looks like production gets the danger colour without being
 * configured — the protection has to work on first launch. Everything else
 * gets a colour derived from the name, so it is stable across restarts and
 * across machines.
 *
 * A hue chosen by hand beats both: the derivation cannot read, so it paints
 * `product-catalog-dev` in the danger colour and two unrelated clusters the
 * same blue. Letting a reader override costs nothing — `isProductionContext`
 * is a separate question and is not moved by a swatch, and no warm hue is on
 * offer, so a chosen colour can never impersonate `--err`.
 */
export function clusterColor(
  context: string | null | undefined,
  /** The hue this person picked for it, if they picked one. */
  hue?: number | null
): string {
  if (hue != null) return clusterHueColor(hue);
  if (!context) return "hsl(var(--fg-fnt))";
  if (context.toLowerCase().includes("prod")) return DANGER_CLUSTER_COLOR;

  // djb2: tiny, dependency-free, and spreads short similar names
  // ("dev-1"/"dev-2") across different buckets.
  let hash = 5381;
  for (let i = 0; i < context.length; i++) {
    hash = ((hash << 5) + hash + context.charCodeAt(i)) | 0;
  }
  return IDENTITY_PALETTE[Math.abs(hash) % IDENTITY_PALETTE.length];
}

/** True when the context is treated as production. */
export function isProductionContext(context: string | null | undefined) {
  return !!context && context.toLowerCase().includes("prod");
}
