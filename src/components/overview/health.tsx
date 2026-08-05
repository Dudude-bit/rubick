import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Cpu,
  MemoryStick,
  Server,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatAge } from "@/lib/utils";
import { formatCPU, formatMemory } from "@/lib/k8s-quantity";
import {
  ResourceType,
  toPlural,
  type ResourceKind,
} from "@/lib/resource-registry";
import type {
  ClusterProblem,
  NodeSummary,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";

/** Reserved share past which the scheduler is the binding constraint. */
const PRESSURE_WARN = 0.85;

/** `formatCPU` renders cores as a bare number ("16.0"), which reads as
 *  nonsense next to a millicore value ("220m / 16.0"). Spell out the unit
 *  here rather than change the shared helper other screens rely on. */
function formatCores(millicores: number): string {
  return millicores < 1000
    ? formatCPU(millicores)
    : `${(millicores / 1000).toFixed(1)} cores`;
}

const DETAIL_ROUTE: Record<string, ResourceKind | undefined> = {
  Pod: ResourceType.Pod,
  Deployment: ResourceType.Deployment,
  Node: ResourceType.Node,
};

/** Deep link to the offending object, when the app has a page for its kind. */
function problemHref(problem: ClusterProblem): string | null {
  const type = DETAIL_ROUTE[problem.kind];
  if (!type) return null;
  if (problem.kind === "Node") return `/${toPlural(type)}/${problem.name}`;
  if (!problem.namespace) return null;
  return `/${toPlural(type)}/${problem.namespace}/${problem.name}`;
}

function ProblemRow({ problem }: { problem: ClusterProblem }) {
  const isCritical = problem.severity === "critical";
  const href = problemHref(problem);

  const body = (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {/* Icon carries the severity too — colour alone would be invisible to
       *  anyone with a red/green deficiency, and these rows are the whole
       *  point of the screen. */}
      {isCritical ? (
        <CircleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
      ) : (
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--status-warning))]"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-sm font-medium",
              isCritical
                ? "text-destructive"
                : "text-[hsl(var(--status-warning))]"
            )}
          >
            {problem.reason}
          </span>
          <span className="truncate font-mono text-sm">{problem.name}</span>
          {problem.namespace && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {problem.namespace}
            </span>
          )}
        </div>
        {problem.detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {problem.detail}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {problem.restarts != null && problem.restarts > 0 && (
          <span className="mr-2">{problem.restarts}&nbsp;restarts</span>
        )}
        <span>{formatAge(problem.since)}</span>
        {href && <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
      </div>
    </div>
  );

  if (!href) {
    return <div className="border-b last:border-b-0">{body}</div>;
  }
  return (
    <Link
      to={href}
      className="block border-b transition-colors last:border-b-0 hover:bg-muted/50"
    >
      {body}
    </Link>
  );
}

export function ProblemsPanel({
  problems,
  podCount,
}: {
  problems: ClusterProblem[];
  podCount: number;
}) {
  // The healthy state is deliberately one line, not a card full of green
  // checkmarks: when nothing is wrong this screen should get out of the way
  // and let the topology below take the space.
  if (problems.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--status-running))]/30 bg-[hsl(var(--status-running))]/5 px-4 py-3">
        <CheckCircle2
          className="h-4 w-4 text-[hsl(var(--status-running))]"
          aria-hidden="true"
        />
        <span className="text-sm font-medium">No problems detected</span>
        <span className="text-sm text-muted-foreground">
          {podCount} pods, all workloads available
        </span>
      </div>
    );
  }

  const critical = problems.filter((p) => p.severity === "critical").length;

  return (
    <Card className="border-destructive/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleAlert
            className="h-4 w-4 text-destructive"
            aria-hidden="true"
          />
          {problems.length} {problems.length === 1 ? "problem" : "problems"}{" "}
          need attention
          {critical > 0 && problems.length !== critical && (
            <span className="text-sm font-normal text-muted-foreground">
              {critical} critical
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="border-t">
          {problems.map((problem) => (
            <ProblemRow
              key={`${problem.kind}/${problem.namespace ?? "-"}/${problem.name}/${problem.reason}`}
              problem={problem}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PressureBar({
  pressure,
  format,
}: {
  pressure: ResourcePressure;
  format: (value: number) => string;
}) {
  const ratio =
    pressure.allocatable > 0 ? pressure.requested / pressure.allocatable : 0;
  const usageRatio =
    pressure.allocatable > 0 && pressure.usage != null
      ? pressure.usage / pressure.allocatable
      : null;
  const tight = ratio >= PRESSURE_WARN;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span
          className={cn(
            "font-medium",
            tight && "text-[hsl(var(--status-warning))]"
          )}
        >
          {Math.round(ratio * 100)}% reserved
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {format(pressure.requested)} / {format(pressure.allocatable)}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            tight
              ? "bg-[hsl(var(--status-warning))]"
              : "bg-[hsl(var(--status-progressing))]"
          )}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
        {/* Actual usage as a tick, not a second bar: it is context for the
         *  reserved number, not a competing metric. */}
        {usageRatio != null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-foreground/70"
            style={{ left: `${Math.min(100, usageRatio * 100)}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {usageRatio != null && (
        <p className="text-xs text-muted-foreground">
          actually using {format(pressure.usage ?? 0)} (
          {Math.round(usageRatio * 100)}%)
        </p>
      )}
    </div>
  );
}

export function SchedulerPanel({
  scheduler,
  metricsAvailable,
}: {
  scheduler: SchedulerPressure;
  metricsAvailable: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Scheduler headroom</CardTitle>
        {/* Naming the denominator matters: people read a low usage bar as
         *  "room to spare" and then wonder why pods sit Pending. */}
        <p className="text-xs text-muted-foreground">
          Share of allocatable capacity already reserved by pod requests — this,
          not usage, decides whether the next pod schedules.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
            CPU
          </div>
          <PressureBar pressure={scheduler.cpu} format={formatCores} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <MemoryStick className="h-3.5 w-3.5" aria-hidden="true" />
            Memory
          </div>
          <PressureBar
            pressure={scheduler.memory}
            format={(value) => formatMemory(value, 1)}
          />
        </div>
        {!metricsAvailable && (
          <p className="text-xs text-muted-foreground">
            metrics-server unavailable — reserved figures are exact, live usage
            is not shown.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  const cpuRatio =
    node.cpu.allocatable > 0 ? node.cpu.requested / node.cpu.allocatable : 0;
  const memRatio =
    node.memory.allocatable > 0
      ? node.memory.requested / node.memory.allocatable
      : 0;

  return (
    <Link
      to={`/${toPlural(ResourceType.Node)}/${node.name}`}
      className="flex items-center gap-3 border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-muted/50"
    >
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          node.ready
            ? "bg-[hsl(var(--status-running))]"
            : "bg-[hsl(var(--status-error))]"
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-sm">{node.name}</span>
          {node.roles.map((role) => (
            <span key={role} className="text-xs text-muted-foreground">
              {role}
            </span>
          ))}
          {!node.schedulable && (
            <span className="text-xs text-[hsl(var(--status-warning))]">
              cordoned
            </span>
          )}
          {!node.ready && (
            <span className="text-xs text-destructive">NotReady</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="w-28 shrink-0">
            cpu {Math.round(cpuRatio * 100)}% reserved
          </span>
          <span className="w-32 shrink-0">
            mem {Math.round(memRatio * 100)}% reserved
          </span>
          <span>
            {node.podCount} pods
            {node.podCapacity != null && ` / ${node.podCapacity}`}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function NodesPanel({ nodes }: { nodes: NodeSummary[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" aria-hidden="true" />
          Nodes
          <span className="text-sm font-normal text-muted-foreground">
            {nodes.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="border-t">
          {nodes.map((node) => (
            <NodeRow key={node.name} node={node} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function WarningsPanel({ warnings }: { warnings: WarningGroup[] }) {
  if (warnings.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Warning events</CardTitle>
        <p className="text-xs text-muted-foreground">
          last hour, grouped by reason
        </p>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="border-t">
          {warnings.map((warning) => (
            <div
              key={warning.reason}
              className="flex items-start gap-3 border-b px-4 py-2 last:border-b-0"
            >
              <span className="font-mono text-sm text-[hsl(var(--status-warning))]">
                {warning.reason}
              </span>
              {warning.count > 1 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  &times;{warning.count}
                </span>
              )}
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {warning.object && (
                  <span className="font-mono">{warning.object}</span>
                )}
                {warning.object && warning.sample && " — "}
                {warning.sample}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatAge(warning.lastSeen)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
