import { describe, expect, it } from "vitest";

import { covers, expiryOf, uncoveredHosts } from "./certificates";

const at = (iso: string) => Date.parse(iso);
const facts = (notAfter: string, notBefore = "2026-01-01T00:00:00Z") => ({
  notAfter,
  notBefore,
});

const NOW = at("2026-08-09T12:00:00Z");

describe("expiryOf", () => {
  /**
   * Would break if the app started marking certificates that are simply
   * fine. Two months out is the state nearly every certificate is in, and
   * a colour on it is what teaches a reader to ignore the colour.
   */
  it("says nothing loud about a certificate with months left", () => {
    const expiry = expiryOf(facts("2026-10-09T12:00:00Z"), NOW);
    expect(expiry.tone).toBeNull();
    expect(expiry.text).toBe("valid for 61 days");
  });

  /**
   * Would break if the two thresholds moved. Fourteen days is the last
   * point a normal change fits; three is past the weekend, where there is
   * no process left and the reader is being interrupted.
   */
  it("warns inside a fortnight and escalates inside three days", () => {
    expect(expiryOf(facts("2026-08-24T12:00:00Z"), NOW).tone).toBeNull();
    expect(expiryOf(facts("2026-08-23T12:00:00Z"), NOW).tone).toBe("warn");
    expect(expiryOf(facts("2026-08-13T12:00:00Z"), NOW)).toMatchObject({
      tone: "warn",
      text: "expires in 4 days",
    });
    expect(expiryOf(facts("2026-08-12T12:00:00Z"), NOW).tone).toBe("err");
  });

  /**
   * Would break if the last day before an outage were rounded to "0 days",
   * which reads as a rendering bug rather than as an emergency.
   */
  it("counts the last day in hours", () => {
    expect(expiryOf(facts("2026-08-09T20:00:00Z"), NOW).text).toBe(
      "expires in 8 hours"
    );
  });

  /** Would break if an already-dead certificate stopped reading as dead. */
  it("says how long ago it expired", () => {
    expect(expiryOf(facts("2026-08-06T12:00:00Z"), NOW)).toMatchObject({
      tone: "err",
      expired: true,
      text: "expired 3 days ago",
    });
  });

  /**
   * Would break if a certificate that is not valid yet were drawn as
   * healthy. Browsers refuse it exactly as they refuse an expired one, and
   * it is the failure nobody thinks to look for.
   */
  it("refuses a certificate whose start date has not arrived", () => {
    const expiry = expiryOf(
      facts("2027-01-01T00:00:00Z", "2026-09-01T00:00:00Z"),
      NOW
    );
    expect(expiry.tone).toBe("err");
    expect(expiry.text).toContain("not valid for another");
  });
});

describe("covers", () => {
  /**
   * Would break if a wildcard were matched leniently — the app would then
   * call a certificate that every browser rejects a covering one.
   */
  it("lets a wildcard cover one label and no more", () => {
    expect(covers(["*.example.com"], "shop.example.com")).toBe(true);
    expect(covers(["*.example.com"], "a.shop.example.com")).toBe(false);
    expect(covers(["*.example.com"], "example.com")).toBe(false);
    expect(covers(["shop.example.com"], "SHOP.example.com.")).toBe(true);
  });

  /**
   * Would break if a certificate valid for the wrong name stopped being
   * reported — the failure that reads as working on every other screen.
   */
  it("names the hosts a certificate does not cover", () => {
    const cert = {
      subject: null,
      issuer: null,
      dnsNames: ["shop.example.com"],
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2027-01-01T00:00:00Z",
      serial: "01",
      selfSigned: false,
      chainLength: 1,
    };
    expect(
      uncoveredHosts(cert, ["shop.example.com", "api.example.com"])
    ).toEqual(["api.example.com"]);
  });
});
