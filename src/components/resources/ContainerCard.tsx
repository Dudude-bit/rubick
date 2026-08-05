/**
 * Container Card Component
 *
 * Displays container information in a consistent card format.
 * Supports both runtime containers (from pods) and spec containers (from deployments).
 *
 * Note: Uses EnvironmentVariables directly rather than ContainerConfiguration because
 * ContainerConfiguration requires volumes and imagePullSecrets which are pod-level
 * properties not available in ContainerInfo or DeploymentContainerInfo types.
 * The ContainerConfiguration component is better suited for dedicated configuration
 * views where all configuration data is available together.
 */

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EnvironmentVariables } from "@/components/resources/EnvironmentVariables";
import { ClickablePorts } from "@/components/ui/clickable-port";
import { Terminal as TerminalIcon, ImageIcon } from "lucide-react";
import type { ContainerInfo, DeploymentContainerInfo } from "@/generated/types";

// Type guard to check if container has runtime info
function isRuntimeContainer(
  container: ContainerInfo | DeploymentContainerInfo
): container is ContainerInfo {
  return "ready" in container && "state" in container;
}

interface ContainerCardProps {
  /** Container info - can be runtime (from pod) or spec (from deployment) */
  container: ContainerInfo | DeploymentContainerInfo;
  /** Namespace for environment variable lookups */
  namespace?: string;
  /** Pod name for port forwarding */
  podName?: string;
  /** Show shell button (only for runtime containers) */
  showShell?: boolean;
  /** Handler for shell button click */
  onOpenShell?: (containerName: string) => void;
  /** Show update image button (for deployments) */
  showUpdateImage?: boolean;
  /** Handler for update image button click */
  onUpdateImage?: (containerName: string, currentImage: string) => void;
}

export function ContainerCard({
  container,
  namespace,
  podName,
  showShell = false,
  onOpenShell,
  showUpdateImage = false,
  onUpdateImage,
}: ContainerCardProps) {
  const isRuntime = isRuntimeContainer(container);

  // Get ports - different structure for runtime vs spec containers
  const ports = isRuntime
    ? container.ports
    : container.ports.map((p) => ({
        containerPort: p,
        protocol: "TCP",
        name: null,
      }));

  // Get resources - same structure for both
  const resources = isRuntime ? null : container.resources;

  return (
    <Section>
      <SectionHeader
        title={container.name}
        actions={
          <>
            {isRuntime && (
              <Badge variant={container.ready ? "success" : "destructive"}>
                {container.ready ? "Ready" : "Not Ready"}
              </Badge>
            )}

            {showShell && isRuntime && onOpenShell && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenShell(container.name)}
              >
                <TerminalIcon className="mr-2 h-4 w-4" />
                Shell
              </Button>
            )}

            {showUpdateImage && !isRuntime && onUpdateImage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUpdateImage(container.name, container.image)}
              >
                <ImageIcon className="mr-2 h-4 w-4" />
                Update Image
              </Button>
            )}
          </>
        }
      />
      <SectionBody className="flex flex-col gap-3 pt-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="font-semibold block">Image:</span>
            <span className="break-all font-mono text-xs">
              {container.image}
            </span>
          </div>
          {isRuntime && (
            <div>
              <span className="font-semibold block">Restart Count:</span>
              <span>{container.restartCount}</span>
            </div>
          )}
        </div>

        {/* Ports */}
        {ports && ports.length > 0 && (
          <div>
            <span className="font-semibold block mb-1">Ports:</span>
            {isRuntime && podName && namespace ? (
              <ClickablePorts
                ports={ports}
                podName={podName}
                podNamespace={namespace}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {ports.map((port, i) => (
                  <Badge key={i} variant="secondary">
                    {port.containerPort}
                    {port.protocol ? `/${port.protocol}` : ""}
                    {port.name ? ` (${port.name})` : ""}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Resources (for spec containers only) */}
        {resources && (
          <>
            {resources.requests &&
              Object.keys(resources.requests).length > 0 && (
                <div>
                  <span className="font-semibold block mb-1">Requests:</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(resources.requests).map(([k, v]) => (
                      <Badge key={k} variant="outline">
                        {k}: {v}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            {resources.limits && Object.keys(resources.limits).length > 0 && (
              <div>
                <span className="font-semibold block mb-1">Limits:</span>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(resources.limits).map(([k, v]) => (
                    <Badge key={k} variant="outline">
                      {k}: {v}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* State (for runtime containers only) */}
        {isRuntime && container.state && (
          <div>
            <span className="font-semibold block mb-1">State:</span>
            <div className="text-fg-mut">
              {Object.entries(container.state).map(([status, details]) => (
                <div key={status}>
                  <span className="capitalize">{status}</span>
                  {/* @ts-expect-error details is unknown */}
                  {details?.reason && <span>: {details.reason}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Environment Variables */}
        <EnvironmentVariables
          env={container.env}
          envFrom={container.envFrom}
          containerName={container.name}
          namespace={namespace}
        />
      </SectionBody>
    </Section>
  );
}
