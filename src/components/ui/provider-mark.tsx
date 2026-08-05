import { cn } from "@/lib/utils";
import type { ClusterProvider } from "@/lib/cluster-identity";

/**
 * A mark per Kubernetes flavour, drawn as one simplified geometric shape
 * so it stays legible at 13px next to the context name: the Kubernetes
 * heptagon for k3d/k3s and anything unrecognised, the AWS cube for EKS,
 * a hexagon for GKE, a triangular A for AKS and a rounded square for
 * minikube. It answers "which kind of cluster am I talking to" at a
 * glance; the colour beside it answers "which one".
 */
const HEPTAGON = (
  <>
    <path d="M12 2.5 20 6.6l-1.9 9.1L12 21.5 5.9 15.7 4 6.6z" />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
  </>
);

const PATHS: Record<ClusterProvider, React.ReactNode> = {
  k3d: HEPTAGON,
  k3s: HEPTAGON,
  generic: HEPTAGON,
  eks: (
    <>
      <path d="M12 2.5 21 7v10l-9 4.5L3 17V7z" />
      <path d="M12 12 21 7M12 12v9.5M12 12 3 7" />
    </>
  ),
  gke: (
    <>
      <path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z" />
      <path d="M12 12v9.5" />
      <circle cx="12" cy="7.6" r="2.2" />
    </>
  ),
  aks: <path d="M11 3 4 18h5l5-11 3 11h3L14 3z" />,
  minikube: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export interface ProviderMarkProps extends Omit<
  React.SVGProps<SVGSVGElement>,
  "children"
> {
  provider: ClusterProvider;
}

export function ProviderMark({
  provider,
  className,
  ...props
}: ProviderMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-[15px] w-[15px] flex-none", className)}
      {...props}
    >
      {PATHS[provider]}
    </svg>
  );
}
