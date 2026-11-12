/**
 * "Is this vendor here" has three answers, and the Integrations pane had
 * two. `found` is `null` when the detection scan could not look — a refused
 * CRD list — and folding that into "not installed" states an absence about
 * the one cluster where nobody checked, two clicks from the vendor's own
 * page saying otherwise.
 */

import { describe, expect, it } from "vite-plus/test";

import { classlessTakersOf, isInstalled } from "./index";

describe("whether a vendor is here", () => {
  it("does not call a scan that could not look an absence", () => {
    expect(isInstalled(null, false, true)).toBeNull();
    expect(isInstalled(null, false, false)).toBeNull();
  });

  it("is settled by an address that answers, whatever the scan saw", () => {
    expect(isInstalled(null, true, true)).toBe(true);
    expect(isInstalled(false, true, true)).toBe(true);
  });

  it("still says absent when the scan really looked and found nothing", () => {
    expect(isInstalled(false, false, true)).toBe(false);
    expect(isInstalled(false, false, false)).toBe(false);
  });

  it("still says present when the scan found the kinds", () => {
    expect(isInstalled(true, false, false)).toBe(true);
  });
});

describe("who here takes an Ingress that names no class", () => {
  const scan = (installed: Record<string, boolean | null>) =>
    Object.entries(installed).map(([id, installed]) => ({
      id,
      installed,
      version: null,
    }));

  /**
   * Traefik and GKE's controller take such an Ingress by default; ingress-nginx
   * does not. Fails if one found is not named, if a controller that does not
   * is, or if "none" is said before every one that does was looked for.
   */
  it("names the ones found, and says none only once each was looked for", () => {
    const none = { traefik: false, "gke-ingress": false };
    expect(classlessTakersOf(scan(none), false)).toEqual([]);
    expect(
      classlessTakersOf(scan({ ...none, "ingress-nginx": true }), false)
    ).toEqual([]);
    expect(classlessTakersOf(scan({ ...none, traefik: true }), false)).toEqual([
      "Traefik",
    ]);
    expect(
      classlessTakersOf(scan({ traefik: true, "gke-ingress": true }), false)
    ).toEqual(["Traefik", "GKE Ingress"]);
  });

  /** A refused CRD list, a scan that failed and one still out are none of them "none found". */
  it("does not call a scan that could not look an absence", () => {
    expect(
      classlessTakersOf(scan({ traefik: null, "gke-ingress": null }), false)
    ).toBe("unread");
    expect(classlessTakersOf(scan({ traefik: false }), false)).toBe("unread");
    expect(classlessTakersOf(undefined, true)).toBe("unread");
    expect(classlessTakersOf(undefined, false)).toBe("reading");
  });
});
