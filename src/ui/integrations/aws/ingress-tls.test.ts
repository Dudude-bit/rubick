/**
 * The widest instance of "a layer that does not read the layer above it".
 *
 * The AWS Load Balancer Controller does not read `spec.tls` at all — the
 * certificate is an ACM ARN in an annotation, or one it discovers in ACM by
 * hostname. Every core surface in this app answered "is this served over
 * TLS" from `spec.tls`, so every ALB Ingress read as plain HTTP: the list
 * column, the detail page, the peek, the traffic chain of every workload
 * behind one, and the `http://` link offered to open it with.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { getIngress: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { ingressTls } from "./ingress-tls";

import { translate } from "@/i18n";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const ingress = (annotations: Record<string, string>, className = "alb") =>
  ({ name: "shop", namespace: "web", className, annotations }) as never;

const ask = () => [
  { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
];

describe("whether an ALB Ingress serves TLS", () => {
  it("reads the certificate ARN the annotation names", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({
        "alb.ingress.kubernetes.io/certificate-arn":
          "arn:aws:acm:eu-west-1:1234:certificate/abcd-1234",
      })
    );

    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
    expect(sayWords(answers[0].by, t)).toContain("abcd-1234");
  });

  /**
   * The controller finds the certificate in ACM by hostname, which this app
   * cannot see. The listener set is what settles it without inventing a
   * certificate in an account nobody handed us.
   */
  it("takes an HTTPS listener as evidence when no ARN is written down", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({
        "alb.ingress.kubernetes.io/listen-ports":
          '[{"HTTP": 80}, {"HTTPS": 443}]',
      })
    );

    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
  });

  /** Listeners naming only HTTP is a real answer, not a silence. */
  it("says plain HTTP when the listener set says so", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({ "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP": 80}]' })
    );

    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(false);
  });

  /**
   * Nothing said either way. Guessing at a certificate in an account this app
   * cannot read would be the same wrong sentence in the other direction, so
   * `spec.tls` keeps the last word.
   */
  it("says nothing when the annotations say nothing", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(ingress({}));
    await expect(ingressTls(ask())).resolves.toEqual([[]]);
  });

  /** Somebody else's Ingress is not this controller's to speak for. */
  it("has no opinion about an Ingress of another class", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress(
        {
          "alb.ingress.kubernetes.io/certificate-arn":
            "arn:aws:acm:x:1:certificate/y",
        },
        "nginx"
      )
    );
    await expect(ingressTls(ask())).resolves.toEqual([[]]);
  });

  /** One failing read must not take the rest of a page's rows with it. */
  it("answers the other rows when one read fails", async () => {
    vi.mocked(commands.getIngress)
      .mockRejectedValueOnce(new Error("forbidden"))
      .mockResolvedValueOnce(
        ingress({
          "alb.ingress.kubernetes.io/certificate-arn":
            "arn:aws:acm:eu-west-1:1234:certificate/abcd",
        })
      );

    const answers = await ingressTls([
      { namespace: "web", name: "gone", hosts: ["a.example.com"] },
      { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
    ]);
    expect(answers[0]).toEqual([]);
    expect(answers[1][0].terminated).toBe(true);
  });
});
