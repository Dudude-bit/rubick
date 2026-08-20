import { Link } from "react-router-dom";
import { ExternalLink, AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceKind } from "@/lib/resource-registry";
import { useT } from "@/i18n/useT";

interface LinkedResourceProps {
  resourceType: ResourceKind;
  name: string;
  namespace: string;
  port?: string;
  exists?: boolean;
  className?: string;
}

export function LinkedResource({
  resourceType,
  name,
  namespace,
  port,
  exists = true,
  className = "",
}: LinkedResourceProps) {
  const t = useT();
  const displayText = port ? `${name}:${port}` : name;
  const url = getResourceDetailUrl(resourceType, name, namespace);

  if (!exists) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`text-err flex items-center gap-1 ${className}`}>
            <AlertTriangle className="h-3 w-3" />
            {displayText}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{t("empty", "resourceNotFoundInCluster")}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={url}
          className={`text-info hover:underline flex items-center gap-1 ${className}`}
        >
          {displayText}
          <ExternalLink className="h-3 w-3" />
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">
          {t("action", "viewKindDetails", { kind: resourceType })}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
