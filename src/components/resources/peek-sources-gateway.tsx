import {
  CopyableAddresses,
  CopyableValue,
} from "@/components/ui/copyable-value";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { commands } from "@/lib/commands";
import { failingCondition } from "@/lib/condition-health";
import { verdictOf, type Verdict } from "@/lib/route-verdict";
import {
  redirectOnly,
  parentCarriesTraffic,
  answeredByItsController,
  selfAnswered,
  gatewayProgrammed,
} from "@/lib/route-trace";
import type { KeyValue } from "./key-values";
import type { RouteInfo } from "@/generated/types";
import {
  conditionItem,
  ref,
  source,
  type PeekSource,
  type PeekSources,
} from "./peek-sources-kit";

/**
 * The badge for a route's Accepted verdict. A verdict nobody has given is
 * `null`, which the peek says out loud; `undefined` would erase the badge.
 */
function acceptedBadge(verdict: Verdict): string | null {
  switch (verdict.state) {
    case "true":
      return "Accepted";
    case "false":
      return "Refused";
    case "pending":
      return verdict.said.status;
    case "none":
    case "undecided":
      return null;
  }
}

/**
 * One reading for the five route kinds — the object is one shape, and a
 * peek that flattened it to dotted paths said nothing a person could act
 * on. Parents up, backends down, the controllers' verdicts in their own
 * polarity-aware tones, every name a peek and every port a forward.
 */
function gatewayRouteSource(kind: string): PeekSource {
  return source(
    (name, namespace) => commands.getGatewayRoute(kind, name, namespace),
    (route: RouteInfo, _target, t) => {
      const redirects = redirectOnly(route);
      return {
        status: acceptedBadge(verdictOf(route.parents, "Accepted")),
        createdAt: route.createdAt,
        groups: [
          {
            title: t("columns", "serves"),
            items: [
              {
                label: t("columns", "hostnames"),
                value: (
                  <CopyableAddresses
                    values={route.hostnames}
                    label={t("columns", "hostname")}
                    empty={t("empty", "gwAllHostsListenerServes")}
                  />
                ),
              },
            ],
          },
          {
            title: t("columns", "parents"),
            count: route.parentRefs.length || undefined,
            items: route.parentRefs.map((parent) => ({
              label: parent.kind,
              value:
                // A ListenerSet parent links like a Gateway parent, because
                // it is one: the set names the Gateway on itself. Labelling it
                // mesh here while the routes list traced it to a Gateway was
                // one object with two answers on two screens.
                parentCarriesTraffic(parent) ? (
                  <span className="inline-flex flex-wrap items-baseline gap-x-1">
                    {ref(
                      parent.kind,
                      parent.name,
                      parent.namespace ?? route.namespace
                    )}
                    {parent.sectionName && (
                      <span className="text-fg-fnt">:{parent.sectionName}</span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex flex-wrap items-baseline gap-x-1">
                    {ref(
                      parent.kind,
                      parent.name,
                      parent.namespace ?? route.namespace
                    )}
                    <span className="text-fg-fnt">
                      — {t("empty", "meshGamma")}
                    </span>
                  </span>
                ),
            })),
            emptyMessage: t("empty", "gwNoParentRefsPage"),
          },
          {
            title: t("columns", "backends"),
            items: route.rules.flatMap((rule) =>
              rule.backendRefs.map((backend): KeyValue => {
                const at = backend.namespace ?? route.namespace;
                return {
                  label: backend.kind,
                  value:
                    backend.kind === "Service" ? (
                      <span className="inline-flex flex-wrap items-baseline gap-x-1">
                        {ref("Service", backend.name, at)}
                        {backend.port != null && (
                          <ClickableServicePort
                            prefix=":"
                            port={backend.port}
                            serviceName={backend.name}
                            namespace={at}
                            className="text-xs"
                          />
                        )}
                        {backend.weight != null && (
                          <span className="text-fg-fnt">
                            ·{" "}
                            {t("empty", "backendWeight", { n: backend.weight })}
                          </span>
                        )}
                      </span>
                    ) : (
                      `${backend.kind} ${backend.name}`
                    ),
                };
              })
            ),
            emptyMessage: redirects
              ? t("empty", "gwRedirectsNoBackends")
              : selfAnswered(route)
                ? t("empty", "gwFilterNoBackends")
                : answeredByItsController(
                      route,
                      route.parents[0]?.controllerName
                    ).length > 0
                  ? t("empty", "gwRowControllerConfigured")
                  : `${t("empty", "gwNoBackendRefsSay")}.`,
          },
          {
            title: t("columns", "verdicts"),
            items: route.parents.flatMap((entry) =>
              entry.conditions.map(conditionItem)
            ),
            emptyMessage: t("empty", "gwNoStatusPeek"),
          },
        ],
      };
    }
  );
}

export const GATEWAY_SOURCES: PeekSources = {
  Gateway: source(commands.getGateway, (gateway, _target, t) => {
    const programmed = gatewayProgrammed(gateway);
    return {
      status: !programmed
        ? null
        : programmed.status === "True"
          ? "Programmed"
          : (programmed.reason ?? programmed.status),
      createdAt: gateway.createdAt,
      groups: [
        {
          title: "Gateway",
          items: [
            { label: "Class", value: ref("GatewayClass", gateway.className) },
            {
              label: t("columns", "addresses"),
              value: (
                <CopyableAddresses
                  values={gateway.addresses}
                  label={t("columns", "gatewayAddress")}
                  empty={t("empty", "nonePublished")}
                />
              ),
            },
          ],
        },
        {
          title: t("columns", "listeners"),
          count: gateway.listeners.length || undefined,
          items: gateway.listeners.map((listener) => {
            // By each condition's own polarity: `Conflicted=False` is the
            // healthy answer.
            const broken = failingCondition(listener.conditions);
            const address = gateway.addresses[0];
            return {
              label: listener.name,
              value: (
                <span className="inline-flex flex-wrap items-baseline gap-x-1 font-mono">
                  {address ? (
                    // The dialable pair rides the click; the label stays
                    // the listener's own :port.
                    <CopyableValue
                      value={`${address}:${listener.port}`}
                      label={`Copy ${address}:${listener.port}`}
                      quietMark
                    >
                      :{listener.port}
                    </CopyableValue>
                  ) : (
                    <>:{listener.port}</>
                  )}{" "}
                  {listener.protocol}
                  {listener.hostname && (
                    <CopyableValue
                      value={listener.hostname}
                      label={`Listener hostname ${listener.hostname}`}
                      quietMark
                    />
                  )}
                  {listener.attachedRoutes != null && (
                    <span className="font-sans text-fg-fnt">
                      · {t("count", "nRoutes", { n: listener.attachedRoutes })}
                    </span>
                  )}
                  {broken && (
                    <span className="text-err">
                      — {broken.reason ?? t("empty", "brokenWord")}
                    </span>
                  )}
                </span>
              ),
              tone: broken ? ("err" as const) : undefined,
            };
          }),
          emptyMessage: t("empty", "gwNoListeners"),
        },
        {
          title: t("columns", "conditions"),
          items: gateway.conditions.map(conditionItem),
          emptyMessage: t("empty", "gwNoConditionsYet"),
        },
      ],
    };
  }),
  GatewayClass: source(
    (name) => commands.getGatewayClass(name),
    (cls, _target, t) => ({
      status:
        cls.accepted === true
          ? "Claimed"
          : cls.accepted === false
            ? "Refused"
            : "Unclaimed",
      createdAt: cls.createdAt,
      groups: [
        {
          title: "GatewayClass",
          items: [
            {
              label: t("columns", "controller"),
              value: cls.controllerName,
              mono: true,
            },
            {
              label: t("columns", "claim"),
              value:
                cls.accepted === true
                  ? t("empty", "claimedBy", { name: cls.controllerName })
                  : cls.accepted === false
                    ? t("empty", "refusedBy", { name: cls.controllerName })
                    : t("empty", "gwClassNoAnswer"),
              tone:
                cls.accepted === true
                  ? undefined
                  : cls.accepted === false
                    ? ("err" as const)
                    : ("warn" as const),
            },
            ...(cls.description
              ? [{ label: "Description", value: cls.description }]
              : []),
          ],
        },
      ],
    })
  ),
  HTTPRoute: gatewayRouteSource("HTTPRoute"),
  GRPCRoute: gatewayRouteSource("GRPCRoute"),
  TLSRoute: gatewayRouteSource("TLSRoute"),
  TCPRoute: gatewayRouteSource("TCPRoute"),
  UDPRoute: gatewayRouteSource("UDPRoute"),
};
