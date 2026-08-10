import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import {
  backendConfigRefs,
  backendConfigSummary,
  certificateTone,
  failingDomains,
  healthCheckOf,
} from "./model";

const resource = (
  spec: unknown,
  status: unknown = null
): CustomResourceInfo => ({
  name: "specimen",
  namespace: "k8s-gui-test",
  uid: "0",
  apiVersion: "cloud.google.com/v1",
  kind: "BackendConfig",
  spec,
  status,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
});

describe("what a Service asks for", () => {
  it("reads both spellings of the annotation, and the current one first", () => {
    /** Would break if a cluster upgraded in place stopped being read. GKE
     *  moved the annotation out of `beta.` and never rewrote the Services
     *  that were already there, so both are live on real clusters and the
     *  GA one wins where somebody has both. */
    expect(
      backendConfigRefs({
        "cloud.google.com/backend-config": '{"default":"current"}',
        "beta.cloud.google.com/backend-config": '{"default":"old"}',
      })
    ).toEqual([{ name: "current", port: null }]);

    expect(
      backendConfigRefs({
        "beta.cloud.google.com/backend-config": '{"default":"old"}',
      })
    ).toEqual([{ name: "old", port: null }]);
  });

  it("keeps the per-port form apart from the default one", () => {
    /** Would break if a per-port config were reported as applying to the
     *  whole Service. "every port" and "port 80" are different claims, and
     *  the second one is why a backend somebody configured is untouched. */
    expect(
      backendConfigRefs({
        "cloud.google.com/backend-config": '{"ports":{"80":"web","443":"tls"}}',
      })
    ).toEqual([
      { name: "web", port: "80" },
      { name: "tls", port: "443" },
    ]);
  });

  it("treats an annotation it cannot parse as naming nothing", () => {
    /** Would break if a malformed annotation produced a guess. GKE applies
     *  no configuration either when it cannot parse this, so "none" is the
     *  true answer rather than a fallback — and inventing a name from
     *  half-parsed JSON would send the reader looking for an object nobody
     *  ever wrote. */
    expect(
      backendConfigRefs({ "cloud.google.com/backend-config": "{" })
    ).toEqual([]);
    expect(
      backendConfigRefs({ "cloud.google.com/backend-config": '"a string"' })
    ).toEqual([]);
    expect(backendConfigRefs({})).toEqual([]);
  });
});

describe("what a BackendConfig configures", () => {
  it("prints only the fields the object actually sets", () => {
    /** Would break if an unset field were printed as its default. A
     *  BackendConfig that names no request path has not asked for `/` — GKE
     *  fills that in from the backend — and printing one would tell the
     *  reader this object says something it does not. */
    expect(
      healthCheckOf(resource({ healthCheck: { type: "HTTP", port: 8080 } }))
    ).toBe("health check HTTP :8080");
    expect(healthCheckOf(resource({ timeoutSec: 30 }))).toBeNull();
    expect(
      healthCheckOf(
        resource({
          healthCheck: { type: "HTTP", port: 8080, requestPath: "/healthz" },
        })
      )
    ).toBe("health check HTTP :8080/healthz");
  });

  it("says so plainly when a config sets nothing", () => {
    /** Would break if an empty BackendConfig drew a blank note. It exists,
     *  it is attached, and it changes nothing — which is a real answer and
     *  a different one from "there is no config here". */
    expect(backendConfigSummary(resource({}))).toBe("sets nothing");
  });

  it("gathers what changes a request into one clause", () => {
    expect(
      backendConfigSummary(
        resource({
          healthCheck: { type: "HTTP", port: 8080, requestPath: "/healthz" },
          timeoutSec: 30,
          cdn: { enabled: true },
          iap: { enabled: false },
          securityPolicy: { name: "block-bots" },
        })
      )
    ).toBe(
      "health check HTTP :8080/healthz · 30s timeout · CDN on · Cloud Armor block-bots"
    );
  });
});

describe("how far a managed certificate got", () => {
  it("uses the controller's own vocabulary and calls the rest unknown", () => {
    /** Would break if a status this app has not seen were sorted into one of
     *  the buckets. The words are gke-managed-certs' own; anything else is a
     *  version of it we have not read, and guessing which way it leans is
     *  how a working certificate gets drawn red. */
    expect(certificateTone("Active")).toBe("ok");
    expect(certificateTone("Provisioning")).toBe("warn");
    expect(certificateTone("FailedNotVisible")).toBe("err");
    expect(certificateTone("ProvisioningFailedPermanently")).toBe("err");
    expect(certificateTone("RenewalFailed")).toBe("err");
    expect(certificateTone("SomethingGoogleAddedLater")).toBe("unknown");
  });

  it("never reads an absent status as a state", () => {
    /** The rule this whole tier stands on. The controller writes "" for a
     *  certificate it has not looked at, and a cluster whose controller is
     *  not running writes nothing at all — those are indistinguishable from
     *  here and neither is a verdict about the certificate. */
    expect(certificateTone(null)).toBe("unknown");
    expect(certificateTone("")).toBe("unknown");
  });

  it("names the domain that is stuck rather than the certificate", () => {
    /** Would break if the per-domain status stopped being read. A
     *  certificate covering four domains reports "Provisioning" at the top
     *  level for as long as one of them is FailedNotVisible, and the domain
     *  whose DNS was never pointed here is the only actionable fact. */
    const certificate = resource(
      { domains: ["shop.example.com", "www.example.com"] },
      {
        certificateStatus: "Provisioning",
        domainStatus: [
          { domain: "shop.example.com", status: "Active" },
          { domain: "www.example.com", status: "FailedNotVisible" },
        ],
      }
    );
    expect(failingDomains(certificate)).toEqual([
      { domain: "www.example.com", status: "FailedNotVisible" },
    ]);
  });
});
