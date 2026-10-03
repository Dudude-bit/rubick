/**
 * The commonest way to get a configured integration's address wrong, and the
 * one the app used to suggest in its own placeholder.
 *
 * The request is made by this app, on the reader's machine. A Service name
 * that works from a pod resolves to nothing here, and the transport's answer
 * — `dns error: … Name or service not known` — is true and says nothing
 * about the one thing that fixes it.
 */

import { describe, expect, it } from "vitest";

import { explain, unreachable } from "./reachability";

import { translate } from "@/i18n";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const DNS =
  "dns error: failed to lookup address information: Name or service not known";
const REFUSED = "connection refused";

describe("an address only the cluster can resolve", () => {
  it("recognises the fully qualified cluster name whatever went wrong", () => {
    // No DNS failure needed: nothing outside a cluster ever resolves this,
    // so the shape alone settles it.
    expect(
      unreachable(
        "http://prometheus.monitoring.svc.cluster.local:9090",
        REFUSED
      )
    ).toEqual({
      kind: "cluster-dns",
      host: "prometheus.monitoring.svc.cluster.local",
    });
    expect(unreachable("http://prom.monitoring.svc:9090", DNS)).toMatchObject({
      kind: "cluster-dns",
    });
  });

  /** The form the placeholder used to suggest. */
  it("recognises the short name/namespace form when it did not resolve", () => {
    expect(unreachable("http://prometheus.monitoring:9090", DNS)).toEqual({
      kind: "cluster-dns",
      host: "prometheus.monitoring",
    });
  });

  /** A bare service name in the same namespace is the same mistake. */
  it("recognises a single-label host that did not resolve", () => {
    expect(unreachable("http://prometheus:9090", DNS)).toMatchObject({
      kind: "cluster-dns",
    });
  });

  /**
   * The delicate half. `grafana.example.com` has the same shape as
   * `prometheus.monitoring`, so the short form is only claimed when the name
   * genuinely did not resolve — a public host that is merely down keeps the
   * transport's own sentence.
   */
  it("does not blame the cluster for a public host that is simply refusing", () => {
    expect(unreachable("https://prometheus.example.com", REFUSED)).toBeNull();
    expect(unreachable("https://metrics.corp.io:9090", REFUSED)).toBeNull();
  });

  /** A three-label public name that does not resolve is a typo, not this. */
  it("leaves a public name that does not resolve alone", () => {
    expect(unreachable("https://prometheus.example.com", DNS)).toBeNull();
  });

  it("says nothing about an empty address", () => {
    expect(unreachable("", DNS)).toBeNull();
  });

  /** The sentence has to carry the way out, not just the diagnosis. */
  it("names both ways out", () => {
    const said = sayWords(
      explain({ kind: "cluster-dns", host: "prometheus.monitoring" }),
      t
    );
    expect(said).toContain("runs on your machine");
    expect(said).toContain("port-forward");
  });
});
