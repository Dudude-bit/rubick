import {
  CopyableAddress,
  CopyableAddresses,
} from "@/components/ui/copyable-value";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { commands } from "@/lib/commands";
import { Peer, ReachCell } from "./network-policy-cells";
import { directionFact, portText, reachOf } from "@/lib/network-policy";
import type { PolicyDirection } from "@/generated/types";
import { list, ref, source, type PeekSources } from "./peek-sources-kit";

/** A LoadBalancer the cloud has not answered for yet. */
function pendingBalancer(service: {
  type: string;
  externalIps: string[];
  loadBalancerIps: string[];
}): boolean {
  return (
    service.type === "LoadBalancer" &&
    service.loadBalancerIps.length === 0 &&
    service.externalIps.length === 0
  );
}

export const NETWORK_SOURCES: PeekSources = {
  Service: source(commands.getService, (service, _target, t) => ({
    createdAt: service.createdAt,
    groups: [
      {
        title: t("columns", "routing"),
        items: [
          { label: t("columns", "type"), value: service.type },
          {
            label: t("columns", "clusterIp"),
            value: (
              <CopyableAddress
                value={service.clusterIp}
                label={t("columns", "clusterIp")}
                fallback={t("empty", "none")}
              />
            ),
          },
          {
            label: t("columns", "ports"),
            // Every port forwards, like everywhere else — the service-side
            // number is the click, the target and protocol stay prose.
            value:
              service.ports.length === 0 ? (
                t("empty", "none")
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
            label: t("columns", "external"),
            // A LoadBalancer with no address yet is the single most common
            // reason a Service does not work, and folding it in here made it
            // look like a ClusterIP's ordinary blank — same em dash, same
            // grey. The page has always named the state; so does this.
            value: pendingBalancer(service) ? (
              t("empty", "pendingInline")
            ) : (
              <CopyableAddresses
                values={[...service.externalIps, ...service.loadBalancerIps]}
                label={t("columns", "externalAddress")}
              />
            ),
            tone: pendingBalancer(service) ? ("warn" as const) : undefined,
          },
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
      const directions: [string, PolicyDirection, boolean][] = [
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
                      <span className="flex flex-col gap-0.5">
                        {rule.peers.map((peer, j) => (
                          <Peer key={j} peer={peer} />
                        ))}
                      </span>
                    ),
                }))
              : [],
            emptyMessage: directionFact(direction, t).value,
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
            label: t("columns", "class"),
            value: ingress.className || t("empty", "clusterDefault"),
          },
          {
            label: t("columns", "address"),
            // The empty state keeps its own tone, so it stays plain text
            // rather than the component's faint fallback.
            value: ingress.loadBalancerIps.length ? (
              <CopyableAddresses
                values={ingress.loadBalancerIps}
                label={t("columns", "ingressAddress")}
              />
            ) : (
              t("empty", "notAssignedYet")
            ),
            tone: ingress.loadBalancerIps.length ? undefined : "warn",
          },
          {
            label: t("columns", "tlsHosts"),
            value: list(ingress.tlsHosts, t("empty", "none")),
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
    return {
      status: addresses.length ? "Ready" : "Unavailable",
      createdAt: endpoints.createdAt,
      groups: [
        {
          title: t("nav", "backends"),
          items: [
            {
              label: t("columns", "ready"),
              value: addresses.length,
              mono: true,
            },
            {
              label: t("columns", "notReadyCount"),
              value: notReady.length,
              mono: true,
              tone: notReady.length ? "warn" : undefined,
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
          count: addresses.length,
          items: addresses.slice(0, 8).map((address) => ({
            label: (
              <CopyableAddress
                value={address.ip}
                label={t("columns", "address")}
              />
            ),
            value: address.targetRef
              ? ref(
                  address.targetRef.kind,
                  address.targetRef.name,
                  target.namespace
                )
              : (address.hostname ?? "—"),
          })),
          emptyMessage: t("empty", "nothingBackingService"),
        },
      ],
    };
  }),
};
