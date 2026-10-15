import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  IngressClassBinding,
  PolicyDoor,
  TlsCertificate,
} from "@/generated/types";
import type { DoorRead } from "./policy-door";
import type { ServiceHealthInput } from "./service-health";
import {
  ingressHealthOf,
  ingressHealthWords,
  type IngressInputs,
  type NamespaceBacking,
} from "./ingress-health";

const t: T = (section, key, values) => translate("en", section, key, values);

const SERVED: IngressClassBinding = {
  requested: "nginx",
  resolved: "nginx",
  controller: "k8s.io/ingress-nginx",
  viaDefault: false,
  available: [],
};
const UNSERVED: IngressClassBinding = {
  ...SERVED,
  resolved: null,
  controller: null,
};

function serving(ready: number): ServiceHealthInput {
  return {
    type: "ClusterIP",
    selectorless: false,
    ready,
    draining: 0,
    notReady: 0,
    unrouted: 0,
  };
}

const BACKING: NamespaceBacking = new Map([
  ["web", serving(0)],
  ["api", serving(2)],
]);

function ingress(
  backends: string[],
  secretName: string | null = null
): IngressInputs["ingress"] {
  return {
    name: "shop",
    namespace: "net",
    className: "nginx",
    rules: [
      {
        host: "shop.example.test",
        paths: backends.map((name) => ({
          path: `/${name}`,
          pathType: "Prefix",
          backendService: name,
          backendPort: "80",
          resourceBackend: null,
        })),
      },
    ],
    defaultBackend: null,
    tlsConfigs: secretName
      ? [{ hosts: ["shop.example.test"], secretName, isCatchAll: false }]
      : [],
    loadBalancerIps: [],
  };
}

const verdict = (inputs: IngressInputs) =>
  ingressHealthWords(ingressHealthOf(inputs), t);

describe("one verdict for an Ingress on its page, its peek and the list", () => {
  /**
   * storefront, admin and api-public all looked healthy in the list while
   * their pages said no controller serves the class. Fails if the list's
   * verdict stops reading the class binding.
   */
  it("says no controller when nothing serves the class", () => {
    const said = verdict({
      ingress: ingress(["api"]),
      binding: { known: true, value: UNSERVED },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(said.code).toBe("noController");
    expect(said.role).toBe("err");
    expect(said.reason).toContain("No IngressClass named nginx");
  });

  /**
   * Lena read "...никто не обслуживает, поэтому этот Ingress никто не
   * подхватывает" as machine Russian, then "IngressClass nginx не обслуживает
   * ни один контроллер" as the class serving no controller.
   */
  it("says in plain Russian that the cluster has no IngressClass by that name", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const said = ingressHealthWords(
      ingressHealthOf({
        ingress: ingress(["api"]),
        binding: { known: true, value: UNSERVED },
        backing: { known: true, value: BACKING },
        certificates: undefined,
      }),
      ru
    );
    expect(said.reason).toBe(
      "В этом кластере нет IngressClass с именем nginx, поэтому этот Ingress никто не обрабатывает."
    );
  });

  /** The tooltip ended "...для его TLS" with no full stop after a first sentence that had one. */
  it("ends every sentence of a reason with a full stop", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const said = ingressHealthWords(
      ingressHealthOf({
        ingress: ingress(["api"], "checkout-tls"),
        binding: { known: true, value: UNSERVED },
        backing: { known: true, value: BACKING },
        certificates: new Map<string, TlsCertificate>([
          [
            "checkout-tls",
            {
              secretName: "checkout-tls",
              certificate: null,
              problem: { says: "noSecret" },
            },
          ],
        ]),
      }),
      ru
    );
    expect(said.reason).toBe(
      "В этом кластере нет IngressClass с именем nginx, поэтому этот Ingress никто не обрабатывает. Нет Secret с именем checkout-tls для его TLS."
    );
  });

  it("names a backend Service that does not exist", () => {
    const said = verdict({
      ingress: ingress(["admin-ui"]),
      binding: { known: true, value: SERVED },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(said.code).toBe("backendMissing");
    expect(said.reason).toContain("No Service named admin-ui");
  });

  it("names a TLS Secret that does not exist", () => {
    const certificates = new Map<string, TlsCertificate>([
      [
        "api-tls",
        {
          secretName: "api-tls",
          certificate: null,
          problem: { says: "noSecret" },
        },
      ],
    ]);
    const said = verdict({
      ingress: ingress(["api"], "api-tls"),
      binding: { known: true, value: SERVED },
      backing: { known: true, value: BACKING },
      certificates,
    });
    expect(said.code).toBe("tlsSecretMissing");
    expect(said.reason).toContain("api-tls");
  });

  /**
   * Traefik without `router.tls` serves the host as plain HTTP and never
   * presents the Secret. The page led with a red "missing TLS Secret" while
   * Traefik's own page and the trace said plain HTTP and nothing of it.
   */
  it("says nothing of a missing Secret its controller never presents", () => {
    const missing = new Map<string, TlsCertificate>([
      [
        "api-tls",
        {
          secretName: "api-tls",
          certificate: null,
          problem: { says: "noSecret" },
        },
      ],
    ]);
    const health = ingressHealthOf({
      ingress: ingress(["api"], "api-tls"),
      binding: { known: true, value: SERVED },
      backing: { known: true, value: BACKING },
      certificates: missing,
      servedPlain: (host) => host === "shop.example.test",
    });
    expect(health.problems).toEqual([]);
    expect(health.unread).toEqual([]);
  });

  /**
   * root-web's Ingress said "root-web takes no traffic" while the trace
   * under it said why: Pod Security refuses the pods. The badge already
   * says the backend is down, so the line leads with the Service's reason.
   */
  it("says why a backend takes no traffic, in its Service's words", () => {
    const service = {
      kind: "Service",
      name: "web",
      namespace: "net",
      existence: "present",
      facts: null,
    } as const;
    const said = verdict({
      ingress: ingress(["web"]),
      binding: { known: true, value: SERVED },
      backing: {
        known: true,
        value: new Map([
          [
            "web",
            {
              ...serving(0),
              stop: {
                reason: "podsRefused",
                service,
                selector: "app=web",
                workloads: [{ ...service, kind: "Deployment" }],
                said: 'pods "web-1" is forbidden: exceeded quota: two-pods, requested: pods=1, used: pods=2, limited: pods=2',
              },
            },
          ],
        ]),
      },
      certificates: undefined,
    });
    expect(said.code).toBe("backendDown");
    expect(said.reason).toBe(
      "web: ResourceQuota two-pods refuses its pods: no room for pods."
    );
  });

  /**
   * checkout's Ingress was "served" while deny-all-ingress shut the pods
   * behind it and Traefik answered 502. Fails if two ready addresses read
   * as a live backend over a policy that admits nobody.
   */
  it("calls a backend a policy shuts down, naming the policy", () => {
    const said = verdict({
      ingress: ingress(["web"]),
      binding: { known: true, value: SERVED },
      backing: {
        known: true,
        value: new Map([
          [
            "web",
            {
              ...serving(2),
              stop: {
                reason: "policyRefuses",
                service: {
                  kind: "Service",
                  name: "web",
                  namespace: "net",
                  existence: "present",
                  facts: null,
                },
                policies: ["deny-all-ingress"],
                ports: [8080],
                noRules: true,
                client: null,
              },
            },
          ],
        ]),
      },
      certificates: undefined,
    });
    expect(said.code).toBe("backendDown");
    expect(said.reason).toBe(
      "web: NetworkPolicy deny-all-ingress admits no connection to these pods."
    );
  });

  /**
   * The list called shop "served" while allow-traefik admitted only Traefik
   * and nginx served the class, so every request got a 502. Fails if the
   * class's controller stops being judged at the backend's policies, or a
   * controller nobody asked about is refused.
   */
  it("calls a backend whose policies refuse the class's controller down", () => {
    const door: PolicyDoor = {
      state: "guarded",
      isolating: ["allow-traefik"],
      unsettled: [],
      ports: [
        {
          name: "http",
          servicePort: 80,
          port: 8080,
          protocol: "TCP",
          rules: [
            {
              policy: "allow-traefik",
              byName: false,
              peers: [
                {
                  pods: { kind: "notSaid" },
                  namespaces: {
                    kind: "written",
                    query: "kubernetes.io/metadata.name=traefik",
                  },
                  ipBlock: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const nginx: DoorRead = {
      name: "ingress-nginx",
      clients: {
        known: true,
        value: [
          {
            name: "ingress-nginx-controller-5f",
            namespace: "ingress-nginx",
            labels: {},
            ip: "10.42.0.12",
            hostNetwork: false,
          },
        ],
      },
      namespaces: {
        known: true,
        value: ["traefik", "ingress-nginx"].map((name) => ({
          name,
          labels: { "kubernetes.io/metadata.name": name },
        })),
      },
    };
    const inputs = (ask?: IngressInputs["door"]): IngressInputs => ({
      ingress: ingress(["web"]),
      binding: { known: true, value: SERVED },
      backing: {
        known: true,
        value: new Map([["web", { ...serving(2), door }]]),
      },
      certificates: undefined,
      door: ask,
    });
    const said = verdict(
      inputs((controller) =>
        controller === "k8s.io/ingress-nginx" ? nginx : null
      )
    );
    expect(said.code).toBe("backendDown");
    expect(said.reason).toBe(
      "web: NetworkPolicy allow-traefik admits no connection from ingress-nginx."
    );
    expect(verdict(inputs()).code).not.toBe("backendDown");
    expect(verdict(inputs(() => null)).code).not.toBe("backendDown");
  });

  /**
   * Marco, who may list pods and not Deployments, read idle-web's Ingress as
   * "its pods could not be read" beside a trace that had read them and could
   * not read the workloads. Fails if an unconfirmed backend stops saying
   * which read is missing in its Service's words.
   */
  it("says which read an unconfirmed backend is missing, in its Service's words", () => {
    const said = verdict({
      ingress: ingress(["web"]),
      binding: { known: true, value: SERVED },
      backing: {
        known: true,
        value: new Map([
          [
            "web",
            {
              ...serving(0),
              stop: {
                reason: "selectsNothing",
                service: {
                  kind: "Service",
                  name: "web",
                  namespace: "net",
                  existence: "present",
                  facts: null,
                },
                selector: "app=web",
                near: null,
                makersRead: false,
              },
            },
          ],
        ]),
      },
      certificates: undefined,
    });
    expect(said.code).toBe("backendUnconfirmed");
    expect(said.reason).toBe(
      "web: No pod carries app=web: workloads not read, so whether one is scaled to zero is not known."
    );
  });

  /** One dead path out of two degrades the Ingress; it does not kill it. */
  it("warns when one backend of several publishes nothing", () => {
    const said = verdict({
      ingress: ingress(["web", "api"]),
      binding: { known: true, value: SERVED },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(said.code).toBe("backendDown");
    expect(said.role).toBe("warn");
  });

  /**
   * The class binding or the Services were refused: "not checked", never
   * "served". Fails if an unread input is skipped instead of carried.
   */
  it("says not checked when an input could not be read", () => {
    const said = verdict({
      ingress: { ...ingress(["api"]), loadBalancerIps: ["203.0.113.7"] },
      binding: { known: false, why: "ingressclasses is forbidden" },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(said.code).toBe("unknown");
    expect(said.role).toBe("neutral");
    expect(said.reason).toContain("ingressclasses is forbidden");

    const stillReading = verdict({
      ingress: ingress(["api"]),
      binding: { known: false, why: null },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(stillReading).toMatchObject({ code: "reading", role: "neutral" });

    const backingRefused = verdict({
      ingress: { ...ingress(["api"]), loadBalancerIps: ["203.0.113.7"] },
      binding: { known: true, value: SERVED },
      backing: { known: false, why: "services is forbidden" },
      certificates: undefined,
    });
    expect(backingRefused.code).toBe("unknown");
  });

  it("calls an addressed Ingress with live backends served", () => {
    const said = verdict({
      ingress: { ...ingress(["api"]), loadBalancerIps: ["203.0.113.7"] },
      binding: { known: true, value: SERVED },
      backing: { known: true, value: BACKING },
      certificates: undefined,
    });
    expect(said).toMatchObject({ code: "serving", role: "ok" });
  });
});
