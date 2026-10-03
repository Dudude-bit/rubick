import {
  Check,
  ImageIcon,
  Minus,
  ScrollText,
  TerminalIcon,
  X,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { ClickablePorts } from "@/components/ui/clickable-port";
import { EnvironmentVariables } from "@/components/resources/EnvironmentVariables";
import { DetailAction } from "@/components/resources/detail-blocks";
import { ImageRef } from "@/components/resources/ImageRef";
import { KeyValueList, type KeyValue } from "@/components/resources/detail-kv";
import {
  containerSequence,
  podContainers,
  templateSequence,
  type ContainerStep,
  type PodContainerLists,
  type StepMark,
  type TemplateContainerLists,
} from "@/lib/container-sequence";
import {
  containerStatus,
  describeTermination,
  lastTermination,
  terminationWhen,
} from "@/lib/pod-status";
import type {
  ContainerInfo,
  ContainerPhase,
  DeploymentContainerInfo,
} from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/**
 * A pod's containers, and a deployment's container template, as metadata
 * blocks rather than cards.
 *
 * Runtime and spec containers carry different fields — only a running one
 * has a state and a restart count, only a template has declared requests
 * and limits — so rows are built per container rather than forced into
 * one shared table.
 *
 * Neither is a set: init containers run in order, each waiting on the one
 * before it; sidecars start during init and never finish; app containers
 * run together. Hence grouping by phase, the init group drawn as a rail,
 * and one renderer for all three phases and both views — five detail
 * pages sharing one template type must share the grouping or they drift.
 *
 * Whole lists rather than one array: handing this component
 * `deployment.containers` is exactly the bug it exists to fix, and a prop
 * that cannot be passed is a better guard than a comment.
 */

function isRuntime(
  container: ContainerInfo | DeploymentContainerInfo
): container is ContainerInfo {
  return "ready" in container && "state" in container;
}

function quantities(record: Record<string, string>): string | null {
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key} ${value}`).join(" · ");
}

/**
 * The mark on the rail. Four silhouettes rather than four colours, for
 * the reason `status-role` gives: severity has to survive greyscale.
 * `queued` is a dash and not a clock — nothing is counting down, the
 * step before it may never finish.
 */
const STEP_MARK: Record<
  StepMark,
  { icon: typeof Check | null; ring: string; text: string; dot?: string }
> = {
  done: { icon: Check, ring: "ring-ok/50", text: "text-ok" },
  failed: { icon: X, ring: "ring-err/60", text: "text-err" },
  running: {
    icon: null,
    ring: "ring-info/50",
    text: "text-info",
    dot: "bg-info",
  },
  queued: { icon: Minus, ring: "ring-hair", text: "text-fg-fnt" },
};

function Marker({ mark }: { mark: StepMark | null }) {
  // No mark is the template's case: there is no run, so there is nothing
  // for a tick or a cross to be about. The pip is only the position, and
  // says so by being the same weight as the rail it sits on.
  const {
    icon: Icon,
    ring,
    text,
    dot,
  } = mark
    ? STEP_MARK[mark]
    : { icon: null, ring: "ring-hair", text: "text-fg-fnt", dot: "bg-fg-fnt" };
  return (
    <span
      aria-hidden="true"
      className={`relative z-10 flex h-[13px] w-[13px] flex-none items-center justify-center rounded-full bg-canvas ring-1 ${ring} ${text}`}
    >
      {Icon ? (
        <Icon className="h-2 w-2" />
      ) : (
        <span className={`h-1 w-1 rounded-full ${dot}`} />
      )}
    </span>
  );
}

interface ContainerRowsCommon {
  namespace?: string;
  /** Enables the port-forward affordance on a running container's ports. */
  podName?: string;
  onOpenShell?: (containerName: string) => void;
  onUpdateImage?: (containerName: string, currentImage: string) => void;
  /** Opens the log viewer soloed on this container. */
  onOpenLogs?: (containerName: string) => void;
}

export type ContainerRowsProps = ContainerRowsCommon &
  (
    | { pod: PodContainerLists | undefined; template?: never }
    | { template: TemplateContainerLists | undefined; pod?: never }
  );

/** A group of blocks, with the rail drawn where there is an order to draw. */
interface Row {
  container: ContainerInfo | DeploymentContainerInfo;
  step?: ContainerStep;
}

interface Group {
  phase: ContainerPhase;
  title: string;
  caption: string;
  /** Ordered, and the order is the payload for `init`. */
  rows: Row[];
}

export function ContainerRows(props: ContainerRowsProps) {
  const t = useT();
  const { namespace, podName, onOpenShell, onUpdateImage, onOpenLogs } = props;

  const groups: Group[] = props.pod
    ? containerSequence(podContainers(props.pod), t).map((group) => ({
        ...group,
        rows: group.steps.map((step) => ({ container: step.container, step })),
      }))
    : props.template
      ? templateSequence(props.template, t).map((group) => ({
          ...group,
          rows: group.containers.map((container) => ({ container })),
        }))
      : [];

  if (groups.length === 0) {
    // A pod without a container is not a thing Kubernetes will admit, so
    // this is the template failing to arrive rather than a fact about the
    // workload — and the reader has to be able to tell the two apart.
    return (
      <p className="text-xs text-fg-fnt">
        <T section="empty" k="noContainersInSpec" />
      </p>
    );
  }

  // One group is the whole pod, and the tab strip has already said
  // "Containers" — a caption over it would only say it again. A template
  // with one group has no sequence either, so it loses the rail with it:
  // a pip beside every row of the deployment that declares nothing but an
  // app container is decoration.
  const grouped = groups.length > 1;
  const marked = grouped || props.pod !== undefined;

  return (
    <div className="flex flex-col gap-7">
      {groups.map((group) => (
        <div key={group.phase} className="flex flex-col gap-2.5">
          {grouped && (
            <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
              {group.title}
              <span className="font-normal normal-case tracking-normal">
                {" · "}
                {group.caption}
              </span>
            </p>
          )}
          <div className="flex flex-col gap-[22px]">
            {group.rows.map((row, index) => (
              <div
                key={row.container.name}
                className={
                  marked
                    ? "relative grid grid-cols-[13px_1fr] gap-x-2.5"
                    : "relative"
                }
              >
                {/* The rail, drawn only where there is an order to draw:
                    the init sequence. It runs from this mark into the
                    gap above the next one, which is what makes "seed is
                    behind migrate" readable without a sentence. */}
                {marked &&
                  group.phase === "init" &&
                  index < group.rows.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-[-28px] left-[6px] top-4 w-px bg-hair"
                    />
                  )}
                {marked && <Marker mark={row.step?.mark ?? null} />}
                <ContainerBlock
                  container={row.container}
                  step={row.step}
                  namespace={namespace}
                  podName={podName}
                  onOpenShell={onOpenShell}
                  onUpdateImage={onUpdateImage}
                  onOpenLogs={onOpenLogs}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ContainerBlock({
  container,
  step,
  namespace,
  podName,
  onOpenShell,
  onUpdateImage,
  onOpenLogs,
}: {
  container: ContainerInfo | DeploymentContainerInfo;
  /** Present only for a runtime container, which is the only kind with one. */
  step?: ContainerStep;
  namespace?: string;
  podName?: string;
  onOpenShell?: (containerName: string) => void;
  onUpdateImage?: (containerName: string, currentImage: string) => void;
  onOpenLogs?: (containerName: string) => void;
}) {
  const t = useT();
  const runtime = isRuntime(container);
  const status = step?.status ?? (runtime ? containerStatus(container) : null);

  const items: KeyValue[] = [
    {
      label: t("columns", "image"),
      value: <ImageRef image={container.image} />,
    },
  ];

  if (runtime) {
    items.push({
      label: t("columns", "restarts"),
      value: container.restartCount,
      tone: container.restartCount > 0 ? "warn" : undefined,
    });
    // A container that restarts is one that died, and the count alone
    // never said of what. The heading carries the state word, so this row
    // carries only the exit code and when — whether that death is the
    // state the container is in now or the one it is backing off from.
    // Skipped on a step that ended cleanly: the heading and the note
    // already say all of it.
    const death = step?.mark === "done" ? null : lastTermination(container);
    if (death) {
      const when = terminationWhen(death, t);
      items.push({
        label: t("columns", "lastExit"),
        value: `${describeTermination(death)}${when ? ` · ${when}` : ""}`,
        tone: death.exitCode === 0 ? undefined : "err",
      });
    }
    if (container.ports.length > 0) {
      items.push({
        label: t("columns", "ports"),
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
        label: t("columns", "ports"),
        value: container.ports.join(" · "),
        mono: true,
      });
    }
    const requests = quantities(container.resources.requests);
    const limits = quantities(container.resources.limits);
    if (requests)
      items.push({
        label: t("columns", "requests"),
        value: requests,
        mono: true,
      });
    items.push({
      label: t("columns", "limits"),
      // A container with no limit can consume the node; saying so beats
      // omitting the row and letting it read as "not applicable".
      value: limits ?? t("empty", "noneSet"),
      mono: limits != null,
      tone: limits ? undefined : "warn",
    });
  }

  // A container that has never run has no log to open, and offering one
  // that lands on an empty pane is worse than not offering it.
  const hasLogs = step ? step.mark !== "queued" : runtime;

  return (
    <Section>
      <SectionHeader
        title={container.name}
        // The container's state, with readiness folded into it: "Running"
        // means running *and* serving, and a container failing its
        // readiness probe says "Not ready" rather than claiming Running
        // in one place and denying it in another.
        count={
          status ? (
            <StatusBadge status={status.text} roleOverride={status.role} />
          ) : undefined
        }
        // What the state word could not say on its own: that this step
        // never got a turn, that this log is finished and will not grow,
        // that the app is waiting on init rather than being quiet.
        description={
          step?.note ? (
            <span
              className={step.mark === "failed" ? "text-err" : "text-fg-fnt"}
            >
              {step.note}
            </span>
          ) : undefined
        }
        actions={
          <>
            {runtime && onOpenLogs && hasLogs && (
              <DetailAction
                label={t("action", "logs")}
                icon={ScrollText}
                onClick={() => onOpenLogs(container.name)}
              />
            )}
            {/* A shell needs a process to attach to. Offered on a
                container that has never started, it can only fail. */}
            {runtime && onOpenShell && container.state.type === "running" && (
              <DetailAction
                label={t("action", "shell")}
                icon={TerminalIcon}
                onClick={() => onOpenShell(container.name)}
              />
            )}
            {!runtime && onUpdateImage && (
              <DetailAction
                label={t("action", "updateImage")}
                icon={ImageIcon}
                onClick={() => onUpdateImage(container.name, container.image)}
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
}
