/**
 * Per-cluster identity: which flavour of Kubernetes a context talks to,
 * and which colour stands for it across the window.
 *
 * Acting on the wrong cluster is the expensive mistake this tool can
 * cause, so the colour is repeated in three always-visible places (the
 * window edge strip, the tab dot and the provider mark). It has to be
 * decided before anyone configures anything, which is why both the
 * provider and the colour are derived from the context name alone.
 */

export type ClusterProvider =
  | "k3d"
  | "k3s"
  | "eks"
  | "gke"
  | "aks"
  | "minikube"
  | "generic";

/**
 * Detect the provider from the context name.
 *
 * Order matters: an EKS context is an ARN (`arn:aws:eks:eu-west-1:...`)
 * that also contains a region and account digits, and a GKE context is
 * `gke_project_zone_cluster`, so the most specific markers are tested
 * first and the loose substrings last.
 */
export function detectProvider(context: string): ClusterProvider {
  const name = context.toLowerCase();
  // "aks" inside "peaks-cluster" is not Azure, so markers are matched as
  // whole segments of a name that separates words with -, _, . or :.
  const hasWord = (word: string) =>
    new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(name);

  if (name.startsWith("k3d-")) return "k3d";
  if (hasWord("k3s")) return "k3s";
  if (name.startsWith("arn:aws") || hasWord("eks")) return "eks";
  if (name.startsWith("gke_") || hasWord("gke")) return "gke";
  if (hasWord("aks")) return "aks";
  if (name.includes("minikube")) return "minikube";
  return "generic";
}

/** Right-aligned label in the context list. Local clusters read "LOCAL". */
export function providerLabel(provider: ClusterProvider): string {
  switch (provider) {
    case "k3d":
      return "K3D";
    case "k3s":
      return "K3S";
    case "eks":
      return "EKS";
    case "gke":
      return "GKE";
    case "aks":
      return "AKS";
    case "minikube":
      return "LOCAL";
    case "generic":
      return "K8S";
  }
}

/**
 * Split a context name into the boilerplate its provider prepends and the
 * part that actually names the cluster.
 *
 * `arn:aws:eks:us-east-1:1234:cluster/prod` and
 * `gke_acme-prod_europe-west1_main` are, to a reader scanning a list,
 * fifty characters of account number followed by the one word they are
 * looking for. Neither half can be dropped — the account and the project
 * are what tell two `prod`s apart — so the prefix is kept and dimmed.
 *
 * The full name is never rewritten: `prefix + label` is the input.
 */
export function clusterNameParts(context: string): {
  prefix: string;
  label: string;
} {
  const provider = detectProvider(context);
  const separator = provider === "eks" ? "/" : provider === "gke" ? "_" : null;
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
 * Colour for a context, as a CSS colour usable in `--cluster`.
 *
 * Anything that looks like production gets the danger colour without
 * being configured — the protection has to work on first launch, before
 * anyone has assigned anything. Everything else gets a colour derived
 * from the name, so it is stable across restarts and across machines.
 */
export function clusterColor(context: string | null | undefined): string {
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
