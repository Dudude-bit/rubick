import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { commands } from "@/lib/commands";
import { BalancerAddress } from "../-object/BalancerAddress";
import { ClusterIpValue } from "../-object/ClusterIpValue";
import {
  IngressHealthView,
  ServiceHealthView,
  ServiceNotReady,
} from "../-object/health-views";
import { ReachCell, ResolvedPeers } from "../-object/network-policy-cells";
import { notGovernedSentence, portText, reachOf } from "@/lib/network-policy";
import type { PolicyDirection } from "@/generated/types";
import {
  list,
  ref,
  source,
  type PeekSource,
  type PeekSources,
} from "./peek-sources-kit";
import { None } from "@/components/ui/none";

interface SliceShape {
  metadata?: { labels?: Record<string, string> | null };
  endpoints?: Array<{ conditions?: { ready?: boolean | null } | null }> | null;
  ports?: Array<{
    name?: string | null;
    port?: number | null;
    protocol?: string | null;
  }> | null;
}

/**
 * An EndpointSlice is read whole, like any kind the app has no schema for,
 * and its Service's verdict goes above the facets: the same one the
 * Service's page and peek show. A slice with no ports is the `web` case,
 * addresses kube-proxy routes nothing to, and it is said in words.
 */
export function endpointSliceSource(
  base: PeekSource,
  whole: (data: unknown) => unknown = (data) => data
): PeekSource {
  return {
    fetch: base.fetch,
    summarise: (data, target, t, kind) => {
      const summary = base.summarise(data, target, t, kind);
      const slice = (whole(data) ?? {}) as SliceShape;
      const service = slice.metadata?.labels?.["kubernetes.io/service-name"];
      const endpoints = slice.endpoints ?? [];
      // The API reads an unset `ready` as true.
      const ready = endpoints.filter(
        (endpoint) => endpoint.conditions?.ready !== false
      ).length;
      const ports = (slice.ports ?? []).map(
        (port) =>
          `${port.name ? `${port.name}:` : ""}${port.port ?? "*"}/${port.protocol ?? "TCP"}`
      );
      return {
        ...summary,
        groups: [
          {
            title: t("nav", "backends"),
            items: [
              ...(service
                ? [
                    {
                      label: "Service",
                      value: ref("Service", service, target.namespace),
                    },
                    {
                      label: t("columns", "status"),
                      value: (
                        <ServiceHealthView
                          name={service}
                          namespace={target.namespace ?? null}
                        />
                      ),
                    },
                  ]
                : []),
              {
                label: t("columns", "endpoints"),
                value: t("count", "readyOfTotal", {
                  ready,
                  total: endpoints.length,
                }),
                tone: ready < endpoints.length ? ("warn" as const) : undefined,
              },
              {
                label: t("columns", "ports"),
                value:
                  ports.length > 0
                    ? ports.join(" · ")
                    : t("readings", "sliceNoPorts"),
                mono: ports.length > 0,
                tone:
                  ports.length === 0 && endpoints.length > 0
                    ? ("err" as const)
                    : undefined,
              },
            ],
          },
          ...summary.groups,
        ],
      };
    },
  };
}

export const NETWORK_SOURCES: PeekSources = {
  Service: source(commands.getService, (service, _target, t) => ({
    createdAt: service.createdAt,
    groups: [
      {
        title: t("columns", "routing"),
        items: [
          {
            label: t("columns", "status"),
            value: (
              <ServiceHealthView
                name={service.name}
                namespace={service.namespace}
              />
            ),
          },
          { label: t("columns", "type"), value: service.type },
          ...(service.type === "ExternalName"
            ? [
                {
                  label: t("columns", "externalName"),
                  value: (
                    <CopyableAddress
                      value={service.externalName}
                      label={t("columns", "externalName")}
                    />
                  ),
                },
              ]
            : []),
          {
            label: t("columns", "clusterIp"),
            value: <ClusterIpValue clusterIp={service.clusterIp} />,
          },
          {
            label: t("columns", "ports"),
            // Every port forwards, like everywhere else — the service-side
            // number is the click, the target and protocol stay prose.
            value:
              service.ports.length === 0 ? (
                <None />
              ) : (
                <span className="inline-flex flex-wrap items-baseline gap-x-2 font-mono">
                  {service.ports.map((port, index) => (
                    <span key={`${port.port}-${index}`}>
                      <ClickableServicePort
                        port={port.port}
                        serviceName={service.name}
                        namespace={service.namespace}
                        className="text-xs"
                      />
                      →{port.targetPort}/{port.protocol}
                    </span>
                  ))}
                </span>
              ),
          },
          {
            label: t("columns", "externalIps"),
            value: (
              <CopyableAddresses
                values={service.externalIps}
                label={t("columns", "externalIp")}
              />
            ),
          },
          ...(service.type === "LoadBalancer"
            ? [
                {
                  label: t("columns", "loadBalancer"),
                  value: <BalancerAddress service={service} />,
                },
              ]
            : []),
          // An ExternalName is a DNS alias: it has no selector to be
          // missing and no endpoints to be written by hand.
          ...(service.type === "ExternalName"
            ? []
            : [
                {
                  label: t("nav", "selector"),
                  value: list(
                    Object.entries(service.selector).map(
                      ([key, value]) => `${key}=${value}`
                    ),
                    t("empty", "endpointsByHand")
                  ),
                  mono: true,
                },
              ]),
        ],
      },
    ],
  })),

  // The peek draws what the list draws, and for the same reason: without an
  // entry here the panel falls through to the generic manifest walker, which
  // flattens `ingress.0.from.0.namespaceSelector` into a dotted path and
  // silently loses the AND between a peer's two selectors.
  NetworkPolicy: source(
    (name, namespace) => commands.getNetworkPolicy(name, namespace),
    (policy, _target, t) => {
      const reach = reachOf(policy.selected);
      const directions: ["Ingress" | "Egress", PolicyDirection, boolean][] = [
        ["Ingress", policy.ingress, false],
        ["Egress", policy.egress, true],
      ];
      return {
        createdAt: policy.createdAt,
        groups: [
          {
            title: t("columns", "selector"),
            items: [
              {
                label: t("columns", "selects"),
                value:
                  policy.selects.kind === "written"
                    ? policy.selects.query
                    : policy.selects.kind === "everything"
                      ? t("empty", "everyPodHere")
                      : t("empty", "noSelectorOnPolicy"),
                mono: policy.selects.kind === "written",
              },
              {
                label: t("columns", "pods"),
                // The list's own cell, so the three answers keep the list's
                // words and colours. A refused pod list is not a policy with
                // nothing behind it, nor a count.
                value: <ReachCell policy={policy} />,
                tone: reach.kind === "nothing" ? ("warn" as const) : undefined,
              },
            ],
          },
          // Rules only where `policyTypes` names the direction. The object
          // keeps an `ingress:` block the policy does not govern, and drawing
          // it told a reader ingress was restricted to those peers while the
          // list row and the detail page both said the policy makes no claim
          // about it — and while ingress was in fact wide open.
          ...directions.map(([title, direction, outbound]) => ({
            title,
            count: direction.governed
              ? direction.rules.length || undefined
              : undefined,
            items: direction.governed
              ? direction.rules.map((rule) => ({
                  label:
                    rule.ports.length === 0
                      ? t("empty", "everyPort")
                      : rule.ports.map((port) => portText(port, t)).join(", "),
                  value:
                    rule.peers.length === 0 ? (
                      <span className="text-warn">
                        {t("empty", outbound ? "toAnywhere" : "fromAnywhere")}
                      </span>
                    ) : (
                      <ResolvedPeers
                        peers={rule.peers}
                        home={policy.namespace}
                      />
                    ),
                }))
              : [],
            emptyMessage: direction.governed
              ? t("empty", "deniesAll")
              : notGovernedSentence(policy, title, t),
          })),
        ],
      };
    }
  ),

  Ingress: source(commands.getIngress, (ingress, target, t) => ({
    createdAt: ingress.createdAt,
    groups: [
      {
        title: t("columns", "routing"),
        items: [
          {
            label: t("columns", "status"),
            value: <IngressHealthView ingress={ingress} />,
          },
          {
            label: t("columns", "class"),
            value: ingress.className || t("empty", "clusterDefault"),
          },
          {
            label: t("columns", "address"),
            value: ingress.loadBalancerIps.length ? (
              <CopyableAddresses
                values={ingress.loadBalancerIps}
                label={t("columns", "ingressAddress")}
              />
            ) : (
              <None />
            ),
          },
          {
            label: t("columns", "tlsHosts"),
            value: list(ingress.tlsHosts),
            mono: true,
          },
        ],
      },
      {
        title: t("columns", "rules"),
        count: ingress.rules.length || undefined,
        items: [
          ...ingress.rules.flatMap((rule) =>
            rule.paths.map((path) => ({
              label: `${rule.host || "*"}${path.path}`,
              // The path is the label; the value is where it goes, and where
              // it goes is a Service in this ingress's own namespace.
              value: path.backendService ? (
                <>
                  {ref("Service", path.backendService, target.namespace)}
                  <span className="font-mono text-fg-fnt">
                    :{path.backendPort}
                  </span>
                </>
              ) : (
                t("empty", "noBackend")
              ),
            }))
          ),
          // The fallback is a rule too — for a rules-less Ingress it is the
          // whole object, and "No rules" over it was the peek calling a
          // working edge dead.
          ...(ingress.defaultBackend?.backendService
            ? [
                {
                  label: t("empty", "anythingUnmatched"),
                  value: (
                    <>
                      {ref(
                        "Service",
                        ingress.defaultBackend.backendService,
                        target.namespace
                      )}
                      <span className="font-mono text-fg-fnt">
                        :{ingress.defaultBackend.backendPort}
                      </span>
                    </>
                  ),
                },
              ]
            : []),
        ],
        emptyMessage: t("empty", "noRulesNoBackend"),
      },
    ],
  })),

  Endpoints: source(commands.getEndpoints, (endpoints, target, t) => {
    const addresses = endpoints.subsets.flatMap((subset) => subset.addresses);
    const notReady = endpoints.subsets.flatMap(
      (subset) => subset.notReadyAddresses
    );
    const listed = [
      ...addresses.map((address) => ({ address, ready: true })),
      ...notReady.map((address) => ({ address, ready: false })),
    ];
    return {
      verdictOfService: endpoints.name,
      createdAt: endpoints.createdAt,
      groups: [
        {
          title: t("nav", "backends"),
          items: [
            {
              label: t("columns", "status"),
              value: (
                <ServiceHealthView
                  name={endpoints.name}
                  namespace={target.namespace ?? null}
                  follow={false}
                />
              ),
            },
            {
              label: t("columns", "notReadyCount"),
              value: notReady.length ? (
                <ServiceNotReady
                  name={endpoints.name}
                  namespace={target.namespace ?? null}
                >
                  {notReady.length}
                </ServiceNotReady>
              ) : (
                0
              ),
              mono: true,
            },
            {
              label: t("columns", "ports"),
              value: list(
                endpoints.subsets.flatMap((subset) =>
                  subset.ports.map((port) => `${port.port}/${port.protocol}`)
                )
              ),
              mono: true,
            },
          ],
        },
        {
          title: "Pods",
          count: listed.length,
          items: listed.slice(0, 8).map(({ address, ready }) => ({
            label: (
              <CopyableAddress
                value={address.ip}
                label={t("columns", "address")}
              />
            ),
            value: (
              <span className="inline-flex items-baseline gap-1.5">
                {address.targetRef
                  ? ref(
                      address.targetRef.kind,
                      address.targetRef.name,
                      target.namespace
                    )
                  : (address.hostname ?? <None />)}
                {!ready && (
                  <span className="text-[11px]">
                    <ServiceNotReady
                      name={endpoints.name}
                      namespace={target.namespace ?? null}
                    >
                      {t("readings", "epNotReady")}
                    </ServiceNotReady>
                  </span>
                )}
              </span>
            ),
          })),
          emptyMessage: t("empty", "listsNoAddress"),
        },
      ],
    };
  }),
};
