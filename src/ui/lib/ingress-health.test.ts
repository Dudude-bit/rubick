import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IngressClassBinding, TlsCertificate } from "@/generated/types";
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
    expect(said.reason).toContain("IngressClass nginx");
  });

  /**
   * Lena read "...никто не обслуживает, поэтому этот Ingress никто не
   * подхватывает" as machine Russian, then "IngressClass nginx не обслуживает
   * ни один контроллер" as the class serving no controller.
   */
  it("says in plain Russian that no controller serves the class", () => {
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
      "IngressClass nginx не обслуживается ни одним контроллером, и этот Ingress никто не обрабатывает."
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
      "IngressClass nginx не обслуживается ни одним контроллером, и этот Ingress никто не обрабатывает. Нет Secret с именем checkout-tls для его TLS."
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
