/**
 * What an Application Gateway was told about this Service, for the traffic
 * chain.
 *
 * The gap this fills is the plainest in the tier: GKE and the AWS controller
 * both answer `service.edge`, so a Service behind either shows what its cloud
 * was told, and a Service behind an Application Gateway showed nothing at
 * all. Not because there is nothing to say — AGIC takes twenty-five
 * annotations — but because nobody had read them.
 *
 * The reference runs backwards, like GKE's: AGIC's settings live on the
 * **Ingress**, and they apply to every backend it routes to. So this reads
 * the Ingresses that name this Service and reports what each one configures
 * for it.
 *
 * Nothing here is a verdict. An annotation is what the gateway *will be
 * told*; whether the probe it describes is passing lives in the Azure API,
 * one credential up.
 */

import type { Saying } from "@/i18n/say";
import { commands } from "@/lib/commands";

import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";
import type { EdgeConfig } from "../registry";
import { claimsIngress } from "./ingress-tls";

const PREFIX = "appgw.ingress.kubernetes.io/";

/**
 * The annotations worth a line, in the order they change what a request
 * does: how the backend is reached, how long it is given, how it is checked,
 * and what is in front of it.
 */
const READ: Array<{ key: string; say: (value: string) => Saying | null }> = [
  {
    key: "backend-protocol",
    say: (v) => ({ key: "agicSpeaks", values: { protocol: v } }),
  },
  {
    key: "backend-path-prefix",
    say: (v) => ({ key: "agicRewritesPath", values: { path: v } }),
  },
  {
    key: "backend-hostname",
    say: (v) => ({ key: "agicSendsHost", values: { host: v } }),
  },
  {
    key: "request-timeout",
    say: (v) => ({ key: "agicRequestTimeout", values: { n: Number(v) } }),
  },
  {
    key: "connection-draining-timeout",
    say: (v) => ({ key: "agicDraining", values: { n: Number(v) } }),
  },
  {
    key: "health-probe-path",
    say: (v) => ({ key: "agicProbes", values: { path: v } }),
  },
  {
    key: "health-probe-status-codes",
    say: (v) => ({ key: "agicAccepts", values: { codes: v } }),
  },
  {
    key: "health-probe-unhealthy-threshold",
    say: (v) => ({ key: "agicOutAfter", values: { n: Number(v) } }),
  },
  {
    key: "cookie-based-affinity",
    say: (v) => (v === "true" ? { key: "agicCookieAffinity" } : null),
  },
  {
    key: "ssl-redirect",
    say: (v) => (v === "true" ? { key: "agicSslRedirect" } : null),
  },
  {
    key: "use-private-ip",
    say: (v) => (v === "true" ? { key: "agicPrivateIp" } : null),
  },
  {
    key: "rewrite-rule-set",
    say: (v) => ({ key: "agicRewriteSet", values: { name: v } }),
  },
  {
    key: "waf-policy-for-path",
    // A WAF policy is a resource id a hundred and sixty characters long; the
    // name at the end is what the reader recognises.
    say: (v) => ({ key: "agicWaf", values: { name: v.split("/").pop() ?? v } }),
  },
];

export async function serviceEdge({
  namespace,
  name,
}: {
  namespace: string;
  name: string;
}): Promise<EdgeConfig[]> {
  const ingresses = await commands.listIngresses(null);

  return ingresses.flatMap((ingress): EdgeConfig[] => {
    if (ingress.namespace !== namespace) return [];
    if (!claimsIngress(ingress)) return [];
    const routes = ingress.rules.some((rule) =>
      rule.paths.some((path) => path.backendService === name)
    );
    if (!routes) return [];

    const said = READ.flatMap(({ key, say }) => {
      const value = ingress.annotations[`${PREFIX}${key}`];
      if (value === undefined || value === "") return [];
      const line = say(value);
      return line ? [line] : [];
    });

    return [
      {
        source: {
          kind: "Ingress",
          name: ingress.name,
          to: getResourceDetailUrl(
            ResourceType.Ingress,
            ingress.name,
            ingress.namespace
          ),
        },
        // An AGIC Ingress with no annotations is a real and common object: it
        // gets the gateway's defaults, and saying so is better than a blank.
        summary: said.length > 0 ? said : [{ key: "azureGatewayDefaults" }],
        problem: null,
      },
    ];
  });
}
