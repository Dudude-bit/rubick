import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ServicePortInfo } from "@/generated/types";

interface PortsDisplayProps {
  ports: ServicePortInfo[];
  maxDisplay?: number;
}

function formatPortCompact(port: ServicePortInfo): string {
  let result = `${port.port}→${port.targetPort}`;
  if (port.nodePort) {
    result += ` (${port.nodePort})`;
  }
  return result;
}

function formatPortFull(port: ServicePortInfo): string {
  const parts = [`Port: ${port.port}`, `Target: ${port.targetPort}`];
  if (port.nodePort) {
    parts.push(`NodePort: ${port.nodePort}`);
  }
  parts.push(`Protocol: ${port.protocol}`);
  if (port.name) {
    parts.push(`Name: ${port.name}`);
  }
  return parts.join("\n");
}

export function PortsDisplay({ ports, maxDisplay = 2 }: PortsDisplayProps) {
  if (ports.length === 0) {
    return <span className="text-fg-mut">No ports</span>;
  }

  const displayPorts = ports.slice(0, maxDisplay);
  const remainingCount = ports.length - maxDisplay;

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {displayPorts.map((port, idx) => (
        <Tooltip key={idx}>
          <TooltipTrigger>
            <Badge variant="secondary" className="text-xs font-mono">
              {formatPortCompact(port)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <pre className="text-xs whitespace-pre">{formatPortFull(port)}</pre>
          </TooltipContent>
        </Tooltip>
      ))}
      {remainingCount > 0 && (
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="outline" className="text-xs">
              +{remainingCount}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-2">
              {ports.slice(maxDisplay).map((port, idx) => (
                <pre key={idx} className="text-xs whitespace-pre">
                  {formatPortFull(port)}
                </pre>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
