import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ServiceTypeBadgeProps {
  type: string;
}

/**
 * A service type is not a status, so it gets no palette of its own. The
 * one thing worth marking is whether the service is reachable from outside
 * the cluster, and that reads as weight rather than hue — an amber pill on
 * every LoadBalancer row would claim something is wrong when nothing is.
 */
const SERVICE_TYPES: Record<
  string,
  { external: boolean; description: string }
> = {
  ClusterIP: {
    external: false,
    description: "Internal only — reachable from inside the cluster",
  },
  NodePort: {
    external: true,
    description: "Reachable from outside via a port on every node",
  },
  LoadBalancer: {
    external: true,
    description: "Reachable from outside via a load balancer",
  },
  ExternalName: {
    external: false,
    description: "DNS alias to a service outside the cluster",
  },
};

export function ServiceTypeBadge({ type }: ServiceTypeBadgeProps) {
  const config = SERVICE_TYPES[type] ?? {
    external: false,
    description: "Unknown service type",
  };

  return (
    <Tooltip>
      <TooltipTrigger>
        <Badge variant={config.external ? "default" : "secondary"}>
          {type}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">{config.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}
