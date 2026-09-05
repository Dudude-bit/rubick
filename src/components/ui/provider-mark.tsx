import { flavourOf, type ClusterProvider } from "@/integrations";
import { cn } from "@/lib/utils";

/**
 * A mark per Kubernetes flavour: one simplified shape, legible at 13px beside
 * the context name. It says which kind of cluster this is; the colour beside it
 * says which one. Vendor shapes live with that vendor's integration; the
 * heptagon is Kubernetes' own and stands in when no vendor claims the name —
 * k3d and k3s included, having no mark worth drawing this small.
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
