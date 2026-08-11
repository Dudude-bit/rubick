import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { cn } from "@/lib/utils";

/**
 * A container port that opens a port-forward.
 *
 * A port number is a value, not a lifecycle status, so it is printed in mono
 * rather than badged. It still has to read as pressable: the informational
 * colour and a dotted underline mark it the way a link is marked, and it is a
 * real `<button>`, so it keeps its place in the tab order.
 */

export interface ClickablePortProps {
  port: number;
  portName?: string;
  protocol?: string;
  /** Pod to forward from. */
  podName: string;
  podNamespace: string;
  className?: string;
  /** Off when the protocol is already implied by the surrounding row. */
  showProtocol?: boolean;
}

export function ClickablePort({
  port,
  portName,
  protocol = "TCP",
  podName,
  podNamespace,
  className,
  showProtocol = true,
}: ClickablePortProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const label = portName
    ? `${port} (${portName})`
    : showProtocol
      ? `${port}/${protocol}`
      : String(port);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "rounded-sm font-mono text-info underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info",
              className
            )}
            onClick={(e) => {
              // The row underneath navigates to the pod; forwarding a port is
              // not that.
              e.stopPropagation();
              setDialogOpen(true);
            }}
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Forward this port
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

export interface ClickablePortsProps {
  ports: Array<{
    containerPort: number;
    name?: string | null;
    protocol?: string | null;
  }>;
  podName: string;
  podNamespace: string;
  className?: string;
}

export function ClickablePorts({
  ports,
  podName,
  podNamespace,
  className,
}: ClickablePortsProps) {
  if (!ports || ports.length === 0) return null;

  return (
    <span className={cn("flex flex-wrap gap-x-3 gap-y-0.5", className)}>
      {ports.map((port, idx) => (
        <ClickablePort
          key={`${port.containerPort}-${idx}`}
          port={port.containerPort}
          portName={port.name || undefined}
          protocol={port.protocol || "TCP"}
          podName={podName}
          podNamespace={podNamespace}
        />
      ))}
    </span>
  );
}
