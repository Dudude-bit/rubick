import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

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
  const t = useT();
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
              "rounded-sm font-mono text-info underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info",
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
          {t("action", "forwardThisPort")}
        </TooltipContent>
      </Tooltip>

      <PortForwardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={{
          kind: "Pod",
          name: podName,
          namespace: podNamespace,
          ports: [{ port, name: portName ?? null, protocol }],
        }}
        initialPort={port}
      />
    </>
  );
}

export interface ClickableServicePortProps {
  /** The Service's own port — what a backendRef or a rule names. */
  port: number;
  serviceName: string;
  namespace: string;
  className?: string;
  /** Drawn before the number, so prose can say `serves :8080`. */
  prefix?: string;
}

/**
 * A Service port that opens a port-forward to the Service. The backend picks
 * a ready pod behind it when the forward starts, and another when that one
 * goes.
 */
export function ClickableServicePort({
  port,
  serviceName,
  namespace,
  className,
  prefix = "",
}: ClickableServicePortProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const t = useT();

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "rounded-sm font-mono text-info underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info",
              className
            )}
            onClick={(event) => {
              // The row underneath navigates; forwarding a port is not that.
              event.stopPropagation();
              setDialogOpen(true);
            }}
          >
            {prefix}
            {port}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t("empty", "gwForwardThrough", { name: serviceName })}
        </TooltipContent>
      </Tooltip>

      <PortForwardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        target={{
          kind: "Service",
          name: serviceName,
          namespace,
          ports: [{ port, name: null, protocol: "TCP" }],
        }}
        initialPort={port}
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
