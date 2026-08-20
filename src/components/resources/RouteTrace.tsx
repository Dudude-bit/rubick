/**
 * The trace a route's Overview tab IS: eight links in debug order, the
 * first broken one already expanded when the page opens. Nothing to
 * discover, nothing to press — see `lib/route-trace` for what each link
 * means and whose word it rests on.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import {
  CopyableAddresses,
  CopyableValue,
} from "@/components/ui/copyable-value";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useBackingLists } from "@/integrations";
import {
  routeTraces,
  type RouteTrace,
  type TraceStep,
} from "@/lib/route-trace";
import { Spinner } from "@/components/ui/spinner";
import { policiesOnService, policyVerdict } from "@/lib/gateway-policies";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import type {
  BackendTlsPolicyInfo,
  ResolveProbe,
  RouteInfo,
  TcpProbe,
} from "@/generated/types";

/** Gateways change with a deploy, not by the second — same as the lists. */
const ROUTING_STALE = 60_000;

const MARKS: Record<TraceStep["state"], string | null> = {
  ok: "✓",
  err: "✕",
  warn: "~",
  blind: "?",
  off: null,
};

const MARK_TONE: Record<TraceStep["state"], string> = {
  ok: "border-ok/40 text-ok",
  err: "border-err bg-err/12 text-err",
  warn: "border-warn/50 text-warn",
  blind: "border-dashed border-hair text-fg-fnt",
  off: "border-hair text-fg-fnt",
};

const WHO: Record<TraceStep["who"], string> = {
  infra: "infra",
  yours: "your side",
  controller: "controller",
  machine: "this machine",
};

/** The two sides of a quote, in each step's own vocabulary. */
const QUOTE_LABELS: Record<string, [string, string]> = {
  listener: ["the route asks for", "the listener serves"],
  namespace: ["the route lives in", "the listener allows"],
  backend: ["the ref asks for port", "the Service serves"],
};

function StepDetail({ step }: { step: TraceStep }) {
  const copy = useCopyToClipboard();
  if (!step.detail) return null;
  const [asksLabel, servesLabel] = QUOTE_LABELS[step.id] ?? [
    "asks for",
    "serves",
  ];
  // No box: the diagnosis is the step continued, hanging on the same rail —
  // the rail's own red stretch carries the severity, not a border.
  return (
    <div className="mb-4 mt-0.5">
      {/* The box is gone, so the title carries the severity itself. */}
      <h4
        className={cn(
          "text-xs font-semibold",
          step.state === "err"
            ? "text-err"
            : step.state === "warn"
              ? "text-warn"
              : "text-fg"
        )}
      >
        {step.detail.title}
      </h4>
      {step.detail.quote && (
        <div className="my-2 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-xs">
          <span className="text-fg-fnt">{asksLabel}</span>
          <span className="font-mono text-err">{step.detail.quote.asks}</span>
          <span className="text-fg-fnt">{servesLabel}</span>
          <span className="font-mono text-fg">{step.detail.quote.serves}</span>
        </div>
      )}
      <p className="mt-1 max-w-[76ch] text-xs text-fg-mut">
        {step.detail.body}
      </p>
      {step.detail.scaffold && (
        <>
          <pre className="mt-2 overflow-x-auto rounded-md border border-hair bg-canvas px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-mut">
            {step.detail.scaffold}
          </pre>
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                copy(step.detail!.scaffold!, "ReferenceGrant manifest copied")
              }
            >
              Copy manifest
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The step's sentence, with the object it names drawn as the same peekable
 * `ResourceRef` every other surface draws — the name stays inside the
 * prose, a click opens the peek, a modified click opens a tab, and a kind
 * with no page degrades to plain text inside the component itself.
 */
function Say({ step }: { step: TraceStep }) {
  const subject = step.subject;
  const at = subject ? step.say.indexOf(subject.name) : -1;
  if (!subject || at < 0) {
    return <>{step.say}</>;
  }
  // A sentence that spells the object as `namespace/name` still gets ONE
  // reference — the resource outranks its namespace, so the prefix rides
  // inside the ref, dim, the way `showNamespace` draws it everywhere else.
  const prefix = step.say.slice(0, at);
  const spellsNamespace =
    subject.namespace != null && prefix.endsWith(`${subject.namespace}/`);
  return (
    <>
      {spellsNamespace
        ? prefix.slice(0, -(subject.namespace!.length + 1))
        : prefix}
      <ResourceRef
        kind={subject.kind}
        name={subject.name}
        namespace={subject.namespace}
        showKind={false}
        showNamespace={spellsNamespace}
      />
      {step.say.slice(at + subject.name.length)}
    </>
  );
}

function StepRow({
  step,
  index,
  note,
}: {
  step: TraceStep;
  index: number;
  /** A quiet line under the row — what a policy adds to this hop. */
  note?: React.ReactNode;
}) {
  const off = step.state === "off";
  return (
    <li className="relative">
      {index < 7 && (
        <span
          className={cn(
            "absolute bottom-0 left-[9px] top-[24px] w-px",
            // The broken stretch is red for exactly as long as its
            // diagnosis runs — the rail carries the severity, no box.
            step.state === "err" ? "bg-err/40" : "bg-hair"
          )}
        />
      )}
      {/* The mark is a flex sibling of the words and the chip, so the row's
          own centring lines all three up — no hand-tuned offsets to drift. */}
      <div className="flex min-h-[26px] flex-wrap items-center gap-2 pb-2">
        <span
          className={`z-[1] flex h-5 w-5 flex-none items-center justify-center rounded-full border bg-raise text-[11px] ${MARK_TONE[step.state]}`}
        >
          {MARKS[step.state] ?? index + 1}
        </span>
        <span className={off ? "text-xs text-fg-fnt" : "text-xs text-fg-mid"}>
          <Say step={step} />
          {!off &&
            step.forwardPort != null &&
            step.subject?.namespace != null && (
              <>
                {" "}
                <ClickableServicePort
                  prefix=":"
                  port={step.forwardPort}
                  serviceName={step.subject.name}
                  namespace={step.subject.namespace}
                  className="text-xs"
                />
              </>
            )}
        </span>
        {!off && step.addresses && step.addresses.length > 0 && (
          <CopyableAddresses
            values={step.addresses}
            label="Gateway address"
            className="text-xs text-fg"
          />
        )}
        {step.freshness && (
          <span className="rounded-full border border-warn/45 px-1.5 text-[10px] text-warn">
            about generation {step.freshness.observed} — you are on{" "}
            {step.freshness.current}
          </span>
        )}
        <span className="ml-auto whitespace-nowrap rounded-full border border-hair px-1.5 text-[10px] uppercase tracking-wide text-fg-fnt">
          {off ? "not reached" : WHO[step.who]}
        </span>
      </div>
      {!off && note && <div className="pb-2 pl-8 text-xs">{note}</div>}
      {step.detail && (
        <div className="pl-8">
          <StepDetail step={step} />
        </div>
      )}
    </li>
  );
}

/**
 * What a BackendTLSPolicy adds to the backend hop: the gateway speaks TLS
 * to this Service, with this SNI, trusted this way — GEP-713's reverse
 * lookup, drawn at the hop it affects instead of on a list nobody reads.
 */
function BackendPolicyNote({
  policies,
  service,
}: {
  policies: BackendTlsPolicyInfo[];
  service: { name: string; namespace: string };
}) {
  const { crdFor } = useCrdIndex();
  const attached = policiesOnService(policies, service);
  if (attached.length === 0) return null;
  const crd =
    crdFor("gateway.networking.k8s.io", "BackendTLSPolicy") ?? undefined;
  return (
    <div className="flex flex-col gap-0.5">
      {attached.map((policy) => {
        const verdict = policyVerdict(policy);
        return (
          <p
            key={policy.name}
            className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-fg-fnt"
          >
            <span>TLS to this backend:</span>
            <ResourceRef
              kind="BackendTLSPolicy"
              name={policy.name}
              namespace={policy.namespace}
              crd={crd}
              showKind={false}
            />
            <span>
              — SNI{" "}
              <CopyableValue
                value={policy.hostname}
                label={`SNI ${policy.hostname}`}
                quietMark
              />
              {policy.wellKnownCa
                ? `, trusts the ${policy.wellKnownCa} bundle`
                : policy.caCertRefs.length > 0
                  ? `, CA from ${policy.caCertRefs.join(", ")}`
                  : ""}
            </span>
            <span
              className={
                verdict.tone === "ok"
                  ? "text-ok"
                  : verdict.tone === "err"
                    ? "text-err"
                    : "text-warn"
              }
            >
              · {verdict.word}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/** One probe step's lifecycle, drawn line by line as it actually runs. */
type ProbeStep<T> =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "loading" }
  | { status: "finished"; result: T }
  | { status: "error"; message: string };

/** The mark a step wears: dim dot, spinner, verdict dot. */
function StepMark({
  status,
  tone,
}: {
  status: ProbeStep<unknown>["status"];
  tone: "ok" | "err" | "mut";
}) {
  if (status === "loading") {
    return <Spinner size="xs" className="relative top-px flex-none" />;
  }
  if (status === "idle" || status === "pending") {
    return (
      <span className="relative top-px h-2 w-2 flex-none rounded-full border border-dashed border-hair" />
    );
  }
  return (
    <span
      className={`relative top-px h-2 w-2 flex-none rounded-full ${
        tone === "ok" ? "bg-ok" : tone === "err" ? "bg-err" : "bg-fg-fnt"
      }`}
    />
  );
}

/**
 * DNS and one TCP connect, from this machine, on click only. It says where
 * it stands: a laptop's view of DNS is not the cluster's, and the page
 * never pretends otherwise.
 *
 * Both steps are drawn before anything runs, and each one moves through
 * its own life — waiting, spinning, answered — because the two are two
 * real commands, not one call wearing a spinner.
 */
function ProbePanel({ trace, kind }: { trace: RouteTrace; kind: string }) {
  const [dns, setDns] = useState<ProbeStep<ResolveProbe>>({ status: "idle" });
  const [tcp, setTcp] = useState<ProbeStep<TcpProbe>>({ status: "idle" });

  const { host, address, port } = trace.probe;
  if (host == null && address == null) return null;
  // A TCP connect to a UDP port times out on a perfectly healthy listener —
  // the check would report a break that is not there, so it is not offered.
  const udp = kind === "UDPRoute";
  const probeable = host != null || (address != null && !udp);

  const running = dns.status === "loading" || tcp.status === "loading";

  const run = async () => {
    let resolvedFirst: string | undefined;
    if (host != null) {
      setDns({ status: "loading" });
      if (!udp) setTcp({ status: "pending" });
      try {
        const result = await commands.probeResolveHost(
          host,
          address,
          port ?? 80
        );
        resolvedFirst = result.resolved[0];
        setDns({ status: "finished", result });
      } catch (error) {
        setDns({ status: "error", message: String(error) });
      }
    }
    if (udp) return;

    // The gateway's address is the thing traffic must reach; the resolved
    // one is the fallback so the probe still says *something* on a cluster
    // that published none.
    const connectTo = address ?? resolvedFirst;
    if (connectTo == null) {
      setTcp({ status: "error", message: "nothing to connect to" });
      return;
    }
    setTcp({ status: "loading" });
    try {
      const result = await commands.probeTcpConnect(connectTo, port ?? 80);
      setTcp({ status: "finished", result });
    } catch (error) {
      setTcp({ status: "error", message: String(error) });
    }
  };

  const dnsTone =
    dns.status === "finished"
      ? dns.result.error || dns.result.matchesGateway === false
        ? "err"
        : dns.result.matchesGateway
          ? "ok"
          : "mut"
      : "err";
  const tcpTone =
    tcp.status === "finished" && tcp.result.error == null ? "ok" : "err";
  const connectTarget =
    address ?? (dns.status === "finished" ? dns.result.resolved[0] : null);

  return (
    <div className="mt-4 rounded-lg border border-hair bg-raise px-3 py-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-xs font-semibold text-fg">From this machine</span>
        <span className="text-[11px] text-fg-fnt">
          checked from your laptop, not from inside the cluster — a VPN or split
          DNS can disagree
        </span>
        {probeable && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={running}
            onClick={run}
          >
            {running ? "Probing…" : "Probe"}
          </Button>
        )}
      </div>
      <ul className="mt-2 space-y-1 text-xs" aria-live="polite">
        {host == null ? (
          <li className="flex items-baseline gap-2">
            <span className="relative top-px h-2 w-2 flex-none rounded-full bg-fg-fnt" />
            <span className="text-fg-fnt">
              no hostname on this route — DNS has nothing to check; the
              gateway&apos;s address is dialled directly
            </span>
          </li>
        ) : (
          <li className="flex items-baseline gap-2">
            <StepMark status={dns.status} tone={dnsTone} />
            <span className={dns.status === "idle" ? "text-fg-fnt" : undefined}>
              <CopyableValue value={host} label={`Host ${host}`} quietMark />{" "}
              {dns.status === "idle" && "— DNS, not checked yet"}
              {dns.status === "loading" && "— resolving…"}
              {dns.status === "error" && (
                <span className="text-err">— {dns.message}</span>
              )}
              {dns.status === "finished" &&
                (dns.result.error ? (
                  <>
                    <span className="text-err">does not resolve from here</span>{" "}
                    {/* The resolver's own words are jargon; they stay, but
                        quietly — the sentence before them is the finding. */}
                    <span className="text-fg-fnt">— {dns.result.error}</span>
                  </>
                ) : (
                  <>
                    resolves to{" "}
                    {dns.result.resolved.map((ip, index) => (
                      <span key={ip}>
                        {index > 0 && ", "}
                        <CopyableValue
                          value={ip}
                          label={`Resolved address ${ip}`}
                          quietMark
                          className={
                            dns.result.matchesGateway === false
                              ? "text-err"
                              : undefined
                          }
                        />
                      </span>
                    ))}
                    {dns.result.matchesGateway === false && address && (
                      <span className="text-err">
                        {" "}
                        — not the gateway&apos;s{" "}
                        <CopyableValue
                          value={address}
                          label={`Gateway address ${address}`}
                          quietMark
                          className="text-err"
                        />
                        . DNS still points somewhere else; traffic never arrives
                        at this cluster.
                      </span>
                    )}
                    {dns.result.matchesGateway === true &&
                      " — the gateway's address"}
                  </>
                ))}
            </span>
          </li>
        )}
        {udp ? (
          <li className="flex items-baseline gap-2">
            <span className="relative top-px h-2 w-2 flex-none rounded-full bg-fg-fnt" />
            <span className="text-fg-fnt">
              UDP
              {port != null &&
                (address ? (
                  <>
                    {" "}
                    {/* Not probed is not not-copyable: the dialable pair is
                        still what nc -u takes. */}
                    <CopyableValue
                      value={`${address}:${port}`}
                      label={`Copy ${address}:${port}`}
                      quietMark
                    >
                      :{port}
                    </CopyableValue>
                  </>
                ) : (
                  ` :${port}`
                ))}{" "}
              — a TCP connect proves nothing about a UDP listener, so this
              machine does not pretend to check it
            </span>
          </li>
        ) : (
          <li className="flex items-baseline gap-2">
            <StepMark status={tcp.status} tone={tcpTone} />
            <span
              className={
                tcp.status === "idle" || tcp.status === "pending"
                  ? "text-fg-fnt"
                  : undefined
              }
            >
              TCP :{port ?? 80}
              {connectTarget && (
                <>
                  {" "}
                  to{" "}
                  {/* The clipboard gets the dialable pair — the same rule
                      every hostless door follows. */}
                  <CopyableValue
                    value={`${connectTarget}:${port ?? 80}`}
                    label={`Copy ${connectTarget}:${port ?? 80}`}
                    quietMark
                  >
                    {connectTarget}
                  </CopyableValue>
                </>
              )}{" "}
              {tcp.status === "idle" && "— not checked yet"}
              {tcp.status === "pending" && "— waiting for DNS"}
              {tcp.status === "loading" && "— connecting…"}
              {tcp.status === "error" && (
                <span className="text-err">— {tcp.message}</span>
              )}
              {tcp.status === "finished" &&
                (tcp.result.error ? (
                  <span className="text-err">— {tcp.result.error}</span>
                ) : (
                  <>
                    answers in{" "}
                    <span className="tabular-nums">{tcp.result.ms} ms</span>
                  </>
                ))}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function TraceCard({
  trace,
  route,
  named,
  policies,
}: {
  trace: RouteTrace;
  route: RouteInfo;
  named: boolean;
  policies: BackendTlsPolicyInfo[];
}) {
  return (
    <div>
      <div className="mb-3 mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`h-2 w-2 flex-none rounded-full ${
            trace.serving
              ? "bg-ok shadow-[0_0_0_4px_hsl(152_44%_49%/0.14)]"
              : "bg-err shadow-[0_0_0_4px_hsl(358_81%_68%/0.18)]"
          }`}
        />
        <span className="font-semibold text-fg">
          {trace.serving ? "Serving" : "Not serving"}
        </span>
        <span className="text-xs text-fg-mut">
          <CopyableAddresses
            values={route.hostnames}
            label="Hostname"
            empty="all hosts the listener serves"
          />
          {trace.stopStep != null &&
            ` — stops at step ${trace.stopStep} of ${trace.steps.length}`}
        </span>
        {named && (
          <span className="ml-auto inline-flex items-baseline gap-1 text-[11px] text-fg-fnt">
            via Gateway
            <ResourceRef
              kind="Gateway"
              name={trace.gateway.name}
              namespace={trace.gateway.namespace}
              showKind={false}
              showNamespace
            />
          </span>
        )}
      </div>
      <ol className="list-none">
        {trace.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            index={index}
            note={
              step.id === "backend" &&
              step.subject?.kind === "Service" &&
              step.subject.namespace != null ? (
                <BackendPolicyNote
                  policies={policies}
                  service={{
                    name: step.subject.name,
                    namespace: step.subject.namespace,
                  }}
                />
              ) : undefined
            }
          />
        ))}
      </ol>
      {trace.steps.at(-1)?.state === "blind" && (
        <ProbePanel trace={trace} kind={route.kind} />
      )}
    </div>
  );
}

export function RouteTraceSection({ route }: { route: RouteInfo }) {
  const detection = useGatewayApi().data;
  const served = useMemo(
    () => new Set(detection?.kinds.map((kind) => kind.kind) ?? []),
    [detection]
  );

  // Unscoped on purpose, twice over: routes attach to Gateways in other
  // namespaces, and the class claim is cluster-scoped. Same key as the
  // routes list's map, so table → detail reuses one cache entry.
  const gateways = useQuery({
    queryKey: ["gateway-map-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    enabled: served.has("Gateway"),
  });
  const classes = useQuery({
    queryKey: ["gateway-classes"],
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: served.has("GatewayClass"),
  });
  const backing = useBackingLists();

  // GEP-713 reverse lookup: the policy names the Service, never the other
  // way round, so the trace scans the namespace's policies once.
  const policiesQuery = useQuery({
    queryKey: ["backend-tls-policies", route.namespace],
    queryFn: () => commands.listBackendTlsPolicies(route.namespace),
    staleTime: ROUTING_STALE,
    enabled: served.has("BackendTLSPolicy"),
  });
  const policies = policiesQuery.data ?? [];

  const traces = useMemo(
    () =>
      routeTraces(route, {
        gateways: gateways.data ?? [],
        classes: classes.data ?? [],
        topologyKnown: gateways.data !== undefined,
        backing: {
          services: backing.data?.services ?? [],
          published: backing.data?.published ?? [],
          backingKnown: backing.data !== undefined,
        },
      }),
    [route, gateways.data, classes.data, backing.data]
  );

  const mesh = route.parentRefs.filter((parent) => parent.kind !== "Gateway");

  return (
    <div className="mt-4">
      {route.parentRefs.length === 0 && (
        <p className="text-xs text-err">
          No parentRefs — this route attaches to nothing and serves no traffic.
        </p>
      )}
      <div className="space-y-6">
        {traces.map((trace) => (
          <TraceCard
            key={`${trace.gateway.namespace}/${trace.gateway.name}`}
            trace={trace}
            route={route}
            named={traces.length > 1}
            policies={policies}
          />
        ))}
      </div>
      {mesh.length > 0 && (
        <p className="mt-3 text-xs text-fg-fnt">
          {mesh.map((parent) => `${parent.kind} ${parent.name}`).join(", ")} —
          mesh routing (GAMMA), not interpreted by this app.
        </p>
      )}
    </div>
  );
}
