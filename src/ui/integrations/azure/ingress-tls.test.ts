/**
 * AGIC keeps its certificate on the Application Gateway and names it in an
 * annotation, and the docs are explicit that the annotation is ignored when
 * `spec.tls` is present — so the two are alternatives, and the annotation-only
 * shape is the ordinary one. Read through `spec.tls` alone it was plain HTTP.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { getIngress: vi.fn(), resolveIngressClass: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { ingressTls } from "./ingress-tls";

import { translate } from "@/i18n";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const ingress = (annotations: Record<string, string>) =>
  ({
    name: "shop",
    namespace: "web",
    className: null,
    annotations: {
      "kubernetes.io/ingress.class": "azure/application-gateway",
      ...annotations,
    },
  }) as never;

const ask = () => [
  { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
];

/** The IngressClass AGIC's chart installs, and somebody else's beside it. */
const classes = (isDefault = false) => ({
  available: [
    {
      name: "azure-application-gateway",
      controller: "azure/application-gateway",
      isDefault,
      parameters: null,
    },
    {
      name: "nginx",
      controller: "k8s.io/ingress-nginx",
      isDefault: false,
      parameters: null,
    },
  ],
});
const CERTIFICATE = {
  "appgw.ingress.kubernetes.io/appgw-ssl-certificate": "wildcard-2026",
};
const written = (
  className: string | null,
  annotations: Record<string, string> = CERTIFICATE
) => ({ name: "shop", namespace: "web", className, annotations }) as never;

beforeEach(() => {
  vi.mocked(commands.resolveIngressClass).mockResolvedValue(classes() as never);
});

describe("which Ingresses AGIC serves", () => {
  /**
   * The documented way to write one: `spec.ingressClassName:
   * azure-application-gateway` and no annotation. The class name was
   * compared with the controller's `azure/application-gateway`, which no
   * class can be called, so the host read as plain HTTP. Fails if the class
   * is matched by anything but its controller.
   */
  it("reads an Ingress that names AGIC's class in spec.ingressClassName", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      written("azure-application-gateway")
    );
    const [answers] = await ingressTls(ask());
    expect(answers).toHaveLength(1);
    expect(answers[0].terminated).toBe(true);
  });

  /**
   * AGIC reads the annotation before the field. Fails if a class in the
   * field outvotes an annotation that names another controller.
   */
  it("leaves an Ingress whose annotation names another controller", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      written("azure-application-gateway", {
        ...CERTIFICATE,
        "kubernetes.io/ingress.class": "nginx",
      })
    );
    await expect(ingressTls(ask())).resolves.toEqual([[]]);
  });

  /** An Ingress naming no class is AGIC's only where AGIC's class is the default. */
  it("takes an Ingress with no class only where its own class is the default", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(written(null));
    await expect(ingressTls(ask())).resolves.toEqual([[]]);

    vi.mocked(commands.resolveIngressClass).mockResolvedValue(
      classes(true) as never
    );
    const [answers] = await ingressTls(ask());
    expect(answers[0]?.terminated).toBe(true);
  });

  /**
   * With `ingressclasses` refused nobody can say whose a class named in the
   * field is. Silence there is read as plain HTTP. Fails if the unread list
   * is taken for "not AGIC's", or stops an annotated Ingress being answered.
   */
  it("could not say for a class in the field when the classes could not be listed", async () => {
    vi.mocked(commands.resolveIngressClass).mockRejectedValue(
      new Error("ingressclasses is forbidden")
    );
    vi.mocked(commands.getIngress).mockResolvedValue(
      written("azure-application-gateway")
    );
    await expect(ingressTls(ask())).resolves.toEqual([
      [
        {
          host: "shop.example.com",
          terminated: null,
          by: {
            key: "verbatimLine",
            values: { said: "ingressclasses is forbidden" },
          },
        },
      ],
    ]);

    vi.mocked(commands.getIngress).mockResolvedValue(ingress(CERTIFICATE));
    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
  });
});

describe("whether an AGIC Ingress serves TLS", () => {
  it("names the certificate installed on the gateway", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({
        "appgw.ingress.kubernetes.io/appgw-ssl-certificate": "wildcard-2026",
      })
    );

    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
    expect(sayWords(answers[0].by, t)).toContain("wildcard-2026");
  });

  /** A redirect is only ever built beside a listener to redirect to. */
  it("takes an ssl-redirect as evidence of a listener", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({ "appgw.ingress.kubernetes.io/ssl-redirect": "true" })
    );
    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
  });

  it("says nothing about an Ingress AGIC does not claim", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue({
      name: "shop",
      namespace: "web",
      className: "nginx",
      annotations: {
        "appgw.ingress.kubernetes.io/appgw-ssl-certificate": "wildcard-2026",
      },
    } as never);
    await expect(ingressTls(ask())).resolves.toEqual([[]]);
  });

  /**
   * A GET that failed came back as an empty answer, which every caller reads
   * as "AGIC has nothing to say" and so as plain HTTP. Fails if a failed
   * read is silence rather than a host nobody could tell about.
   */
  it("leaves the hosts of an Ingress it could not read unknown", async () => {
    vi.mocked(commands.getIngress).mockRejectedValue(new Error("forbidden"));

    await expect(ingressTls(ask())).resolves.toEqual([
      [
        {
          host: "shop.example.com",
          terminated: null,
          by: { key: "verbatimLine", values: { said: "forbidden" } },
        },
      ],
    ]);
  });
});
