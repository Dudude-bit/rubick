import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { cn } from "@/lib/utils";

export interface ClickablePortProps {
  /** Port number */
  port: number;
  /** Optional port name */
  portName?: string;
  /** Protocol (TCP, UDP) */
  protocol?: string;
  /** Pod name for port forwarding */
  podName: string;
  /** Pod namespace for port forwarding */
  podNamespace: string;
  /** Badge variant */
  variant?: "default" | "secondary" | "outline";
  /** Additional class names */
  className?: string;
  /** Show protocol in badge */
  showProtocol?: boolean;
}

export function ClickablePort({
  port,
  portName,
  protocol = "TCP",
  podName,
  podNamespace,
  variant = "secondary",
  className,
  showProtocol = true,
}: ClickablePortProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const displayText = portName
    ? `${port} (${portName})`
    : showProtocol
      ? `${port}/${protocol}`
      : String(port);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={variant}
            className={cn(
              "cursor-pointer transition-colors hover:bg-sel hover:text-fg",
              className
            )}
            onClick={(e) => {
              e.stopPropagation();
              setDialogOpen(true);
            }}
          >
            {displayText}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Click to port forward
        </TooltipContent>
      </Tooltip>

      <PortForwardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        podName={podName}
        podNamespace={podNamespace}
        initialPort={port}
        portName={portName}
      />
    </>
  );
}

/** Props for rendering multiple ports */
export interface ClickablePortsProps {
  /** Array of port info */
  ports: Array<{
    containerPort: number;
    name?: string | null;
    protocol?: string | null;
  }>;
  /** Pod name */
  podName: string;
  /** Pod namespace */
  podNamespace: string;
  /** Badge variant */
  variant?: "default" | "secondary" | "outline";
  /** Additional class for container */
  className?: string;
}

/** Render multiple clickable ports */
export function ClickablePorts({
  ports,
  podName,
  podNamespace,
  variant = "secondary",
  className,
}: ClickablePortsProps) {
  if (!ports || ports.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {ports.map((port, idx) => (
        <ClickablePort
          key={`${port.containerPort}-${idx}`}
          port={port.containerPort}
          portName={port.name || undefined}
          protocol={port.protocol || "TCP"}
          podName={podName}
          podNamespace={podNamespace}
          variant={variant}
        />
      ))}
    </div>
  );
}
