import { ImageIcon, TerminalIcon } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ClickablePorts } from "@/components/ui/clickable-port";
import { EnvironmentVariables } from "@/components/resources/EnvironmentVariables";
import { DetailAction } from "@/components/resources/detail-blocks";
import { ImageRef } from "@/components/resources/ImageRef";
import { KeyValueList, type KeyValue } from "@/components/resources/detail-kv";
import { statusRole } from "@/lib/status-role";
import { describeTermination, terminationWhen } from "@/lib/pod-status";
import type {
  ContainerInfo,
  ContainerState,
  DeploymentContainerInfo,
} from "@/generated/types";

/**
 * A pod's containers, and a deployment's container template, as metadata
 * blocks rather than cards.
 *
 * Runtime and spec containers carry different fields — only a running
 * container has a state and a restart count, only a template has declared
 * requests and limits — so the row list is built per container instead of
 * being forced into one shared table.
 */

function isRuntime(
  container: ContainerInfo | DeploymentContainerInfo
): container is ContainerInfo {
  return "ready" in container && "state" in container;
}

type StateSummary = { text: string; tone?: "warn" | "err" };

/**
 * `state` is a tagged union; the previous card iterated it with
 * `Object.entries` and rendered the discriminant itself as the state name.
 */
function describeState(state: ContainerState): StateSummary {
  switch (state.type) {
    case "running":
      return { text: "Running" };
    case "waiting": {
      const reason = state.reason;
      if (!reason) return { text: "Waiting", tone: "warn" };
      return {
        text: `Waiting · ${reason}`,
        tone: statusRole(reason) === "err" ? "err" : "warn",
      };
    }
    case "terminated": {
      const when = terminationWhen(state.termination);
      return {
        text: `Terminated · ${describeTermination(state.termination)}${when ? ` · ${when}` : ""}`,
        tone: state.termination.exitCode === 0 ? undefined : "err",
      };
    }
    default:
      return { text: "Unknown", tone: "warn" };
  }
}

function quantities(record: Record<string, string>): string | null {
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key} ${value}`).join(" · ");
}

export interface ContainerRowsProps {
  containers: (ContainerInfo | DeploymentContainerInfo)[];
  namespace?: string;
  /** Enables the port-forward affordance on a running container's ports. */
  podName?: string;
  onOpenShell?: (containerName: string) => void;
  onUpdateImage?: (containerName: string, currentImage: string) => void;
}

export function ContainerRows({
  containers,
  namespace,
  podName,
  onOpenShell,
  onUpdateImage,
}: ContainerRowsProps) {
  if (containers.length === 0) {
    return <p className="text-xs text-fg-fnt">No containers</p>;
  }

  return (
    <div className="flex flex-col gap-[22px]">
      {containers.map((container) => {
        const runtime = isRuntime(container);
        const state = runtime ? describeState(container.state) : null;

        const items: KeyValue[] = [
          { label: "Image", value: <ImageRef image={container.image} /> },
        ];

        if (runtime && state) {
          items.push({ label: "State", value: state.text, tone: state.tone });
          items.push({
            label: "Restarts",
            value: container.restartCount,
            tone: container.restartCount > 0 ? "warn" : undefined,
          });
          // A container that restarts is a container that died, and the
          // count alone never said of what. Only shown when the current
          // state is not already the termination being described.
          if (
            container.state.type !== "terminated" &&
            container.lastTerminated
          ) {
            const when = terminationWhen(container.lastTerminated);
            items.push({
              label: "Last exit",
              value: `${describeTermination(container.lastTerminated)}${when ? ` · ${when}` : ""}`,
              tone: container.lastTerminated.exitCode === 0 ? undefined : "err",
            });
          }
          if (container.ports.length > 0) {
            items.push({
              label: "Ports",
              value:
                podName && namespace ? (
                  <ClickablePorts
                    ports={container.ports}
                    podName={podName}
                    podNamespace={namespace}
                  />
                ) : (
                  container.ports
                    .map((p) => `${p.containerPort}/${p.protocol}`)
                    .join(" · ")
                ),
              mono: true,
            });
          }
        }

        if (!runtime) {
          if (container.ports.length > 0) {
            items.push({
              label: "Ports",
              value: container.ports.join(" · "),
              mono: true,
            });
          }
          const requests = quantities(container.resources.requests);
          const limits = quantities(container.resources.limits);
          if (requests)
            items.push({ label: "Requests", value: requests, mono: true });
          items.push({
            label: "Limits",
            // A container with no limit can consume the node; saying so beats
            // omitting the row and letting it read as "not applicable".
            value: limits ?? "none set",
            mono: limits != null,
            tone: limits ? undefined : "warn",
          });
        }

        return (
          <Section key={container.name}>
            <SectionHeader
              title={container.name}
              count={
                runtime && !container.ready ? (
                  <span className="text-warn">not ready</span>
                ) : runtime ? (
                  "ready"
                ) : undefined
              }
              actions={
                <>
                  {runtime && onOpenShell && (
                    <DetailAction
                      label="Shell"
                      icon={TerminalIcon}
                      onClick={() => onOpenShell(container.name)}
                    />
                  )}
                  {!runtime && onUpdateImage && (
                    <DetailAction
                      label="Update image"
                      icon={ImageIcon}
                      onClick={() =>
                        onUpdateImage(container.name, container.image)
                      }
                    />
                  )}
                </>
              }
            />
            <KeyValueList items={items} />
            <EnvironmentVariables
              env={container.env}
              envFrom={container.envFrom}
              containerName={container.name}
              namespace={namespace}
            />
          </Section>
        );
      })}
    </div>
  );
}
