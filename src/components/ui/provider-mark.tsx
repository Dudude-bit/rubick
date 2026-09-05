import { flavourOf, type ClusterProvider } from "@/integrations";
import { cn } from "@/lib/utils";

/**
 * A mark per Kubernetes flavour, one simplified geometric shape so it stays
 * legible at 13px next to the context name. It answers "which kind of cluster
 * am I talking to"; the colour beside it answers "which one".
 *
 * The shapes are each vendor's own and live with the rest of what the app
 * knows about them. The heptagon is Kubernetes' own, so it is what a cluster
 * wears when no vendor claims its name — and what k3d and k3s wear too, having
 * no mark of their own worth drawing this small.
 */
const HEPTAGON = (
  <>
    <path d="M12 2.5 20 6.6l-1.9 9.1L12 21.5 5.9 15.7 4 6.6z" />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
  </>
);

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
      {flavourOf(provider)?.mark ?? HEPTAGON}
    </svg>
  );
}
