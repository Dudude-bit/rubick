import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ServicePortInfo } from "@/generated/types";

/**
 * A service's ports inside a list row.
 *
 * A port number is a value, not a lifecycle status, so it is printed rather
 * than badged: the published port at full foreground, the target behind a
 * dimmed arrow, and the name and protocol quiet beside them. The complete
 * record stays in the tooltip, because five fields per port would turn a
 * table cell into a paragraph.
 */

interface PortsDisplayProps {
  ports: ServicePortInfo[];
  maxDisplay?: number;
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

function PortText({ port }: { port: ServicePortInfo }) {
  const qualifier = [port.name, port.protocol].filter(Boolean).join(" · ");
  return (
    <span className="cursor-default">
      <span className="font-mono text-fg">{port.port}</span>
      <span className="font-mono text-fg-fnt">→</span>
      <span className="font-mono text-fg-mut">{port.targetPort}</span>
      {port.nodePort != null && (
        <span className="font-mono text-fg-mut">:{port.nodePort}</span>
      )}
      {qualifier && (
        <span className="ml-1 text-[11px] text-fg-fnt">{qualifier}</span>
      )}
    </span>
  );
}

export function PortsDisplay({ ports, maxDisplay = 2 }: PortsDisplayProps) {
  if (ports.length === 0) {
    return <span className="text-fg-fnt">—</span>;
  }

  const shown = ports.slice(0, maxDisplay);
  const rest = ports.slice(maxDisplay);

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
      {shown.map((port, idx) => (
        <Tooltip key={idx}>
          <TooltipTrigger asChild>
            <span>
              <PortText port={port} />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <pre className="whitespace-pre text-[11px]">
              {formatPortFull(port)}
            </pre>
          </TooltipContent>
        </Tooltip>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default text-[11px] text-fg-fnt">
              +{rest.length} more
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-2">
              {rest.map((port, idx) => (
                <pre key={idx} className="whitespace-pre text-[11px]">
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
