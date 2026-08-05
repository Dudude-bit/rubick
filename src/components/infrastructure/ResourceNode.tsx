import { Handle, NodeProps, Position } from "reactflow";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ResourceNodeData } from "@/features/infrastructure/types";
import { ResourceType } from "@/lib/resource-registry";

export function ResourceNode({ data, selected }: NodeProps<ResourceNodeData>) {
  const showSourceHandle =
    data.kind === ResourceType.Ingress || data.kind === ResourceType.Service;
  const showTargetHandle =
    data.kind === ResourceType.Service ||
    data.kind === ResourceType.Pod ||
    data.kind === ResourceType.Deployment;
  const imported = data.origin === "cluster";

  return (
    <div
      className={cn(
        // The canvas fill is not elevation — it is what stops the dot grid
        // showing through the node. Selection is a ring, not a shadow.
        "min-w-[170px] rounded border border-hair bg-canvas px-2.5 py-1.5 text-xs",
        // An imported node is a copy of something that already exists in
        // the cluster and is excluded from Apply by default, so it reads
        // as a draft rather than as a thing being created.
        imported && "border-dashed",
        selected && "ring-1 ring-info"
      )}
    >
      {showTargetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          className="h-1.5 w-1.5 border-0 bg-fg-fnt"
        />
      )}
      {showSourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          className="h-1.5 w-1.5 border-0 bg-fg-fnt"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        {/* The kind used to carry a hue each — six palettes restating six
            words that are printed right beside them. */}
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
          {data.kind}
        </span>
        <span className="text-[11px] text-fg-mut">{data.status ?? "Idle"}</span>
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        <span className="truncate font-mono text-xs font-medium text-fg">
          {data.name}
        </span>
        <span className="flex items-baseline gap-1.5 truncate text-[11px] text-fg-mut">
          {data.namespace || "default"}
          {imported && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-fg-fnt">· imported</span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center" className="max-w-xs">
                Imported resources are excluded from Apply and Validate unless
                you enable “Include imported”.
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
    </div>
  );
}
