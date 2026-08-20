import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
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
 * A Service port that opens a port-forward — through a pod, resolved on
 * click, because a Service does not answer a forward and which pod stands
 * behind it only exists in its endpoints at that moment. Resolving early
 * would go stale in a way a click-time read cannot.
 */
export function ClickableServicePort({
  port,
  serviceName,
  namespace,
  className,
  prefix = "",
}: ClickableServicePortProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resolved, setResolved] = useState<{
    podName: string;
    port: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const open = async (event: React.MouseEvent) => {
    // The row underneath navigates; forwarding a port is not that.
    event.stopPropagation();
    setBusy(true);
    try {
      // The Service is what ties the clicked port number to the endpoint
      // entry's NAME — on a multi-port Service, ports[0] would forward the
      // wrong container port while the tooltip promised this one.
      const [endpoints, service] = await Promise.all([
        commands.getEndpoints(serviceName, namespace),
        commands.getService(serviceName, namespace).catch(() => null),
      ]);
      const portName =
        service?.ports.find((entry) => entry.port === port)?.name ?? null;
      for (const subset of endpoints.subsets) {
        const address = subset.addresses.find(
          (entry) => entry.targetRef?.kind === "Pod"
        );
        if (!address?.targetRef) continue;
        // The endpoints port is the pod-side number — the one a forward to
        // the pod actually needs, where targetPort differs from port.
        // Ports pair by name; a single unnamed port pairs by being alone.
        const match =
          portName != null
            ? subset.ports.find((entry) => entry.name === portName)
            : subset.ports.length === 1
              ? subset.ports[0]
              : (subset.ports.find((entry) => entry.port === port) ?? null);
        if (!match && subset.ports.length > 0 && portName != null) continue;
        setResolved({
          podName: address.targetRef.name,
          port: match?.port ?? port,
        });
        setDialogOpen(true);
        return;
      }
      toast({
        title: `Nothing to forward to`,
        description: `No ready pod stands behind ${serviceName} right now.`,
        variant: "destructive",
      });
    } catch (error) {
      toast({
        title: `Could not resolve ${serviceName}`,
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className={cn(
              "rounded-sm font-mono text-info underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:opacity-50",
              className
            )}
            onClick={open}
          >
            {prefix}
            {port}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Forward this port — through a pod behind {serviceName}
        </TooltipContent>
      </Tooltip>

      {resolved && (
        <PortForwardDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          podName={resolved.podName}
          podNamespace={namespace}
          initialPort={resolved.port}
          portName={`${serviceName}:${port}`}
        />
      )}
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
