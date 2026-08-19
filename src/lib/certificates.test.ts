import { describe, expect, it } from "vitest";

import {
  covers,
  expiryOf,
  managedExpiryOf,
  overdueBy,
  uncoveredHosts,
} from "./certificates";

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

  /**
   * Would break if the fourteen-day threshold outlived the certificate — a
   * seven-day Let's Encrypt certificate is *born* inside it, and a mark it
   * wears from birth is a mark nobody reads (#68).
   */
  it("keeps quiet about a short certificate with most of its life left", () => {
    const expiry = expiryOf(
      facts("2026-08-14T12:00:00Z", "2026-08-07T12:00:00Z"),
      NOW
    );
    expect(expiry.tone).toBeNull();
    expect(expiry.text).toBe("valid for 5 days");
  });

  /**
   * Would break if a short certificate never earned a mark at all. The
   * thresholds shrink with the lifetime — a third and a tenth of it — they
   * do not disappear.
   */
  it("scales both thresholds to a short certificate's lifetime", () => {
    expect(
      expiryOf(facts("2026-08-11T12:00:00Z", "2026-08-04T12:00:00Z"), NOW)
    ).toMatchObject({ tone: "warn", text: "expires in 2 days" });
    expect(
      expiryOf(facts("2026-08-10T00:00:00Z", "2026-08-03T00:00:00Z"), NOW)
    ).toMatchObject({ tone: "err", text: "expires in 12 hours" });
  });

  /**
   * Would break if a sub-day warning printed "expires in 0 days", which
   * reads as a rendering bug exactly where the reader most needs a number.
   */
  it("counts sub-day thresholds in hours", () => {
    const expiry = expiryOf(
      facts("2026-08-09T17:00:00Z", "2026-08-08T17:00:00Z"),
      NOW
    );
    expect(expiry).toMatchObject({ tone: "warn", text: "expires in 5 hours" });
  });

  /**
   * Would break if an unreadable `notBefore` silenced the marks — with no
   * lifetime to scale by, the absolute thresholds are the only honest ones.
   */
  it("falls back to the absolute thresholds without a start date", () => {
    expect(expiryOf(facts("2026-08-14T12:00:00Z", ""), NOW).tone).toBe("warn");
  });
});

describe("managedExpiryOf", () => {
  /**
   * Would break if the app second-guessed cert-manager's own schedule. A
   * certificate whose renewal is still ahead is not news, however little of
   * its short life remains — and the verdict states the plan.
   */
  it("trusts a renewal that is still ahead", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-11T12:00:00Z", "2026-08-04T12:00:00Z"),
      "2026-08-10T12:00:00Z",
      NOW
    );
    expect(expiry.tone).toBeNull();
    expect(expiry.text).toBe("renews in 1 day");
    expect(expiry.renewalOverdue).toBe(false);
  });

  it("counts a renewal due today in hours", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-11T12:00:00Z", "2026-08-04T12:00:00Z"),
      "2026-08-09T15:00:00Z",
      NOW
    );
    expect(expiry.text).toBe("renews in 3 hours");
  });

  /**
   * Would break if a healthy long certificate started narrating its
   * schedule. "Valid for 61 days" is the sentence it always had; the plan
   * only replaces a warning that would otherwise be false.
   */
  it("leaves a quiet certificate's sentence alone", () => {
    const expiry = managedExpiryOf(
      facts("2026-10-09T12:00:00Z"),
      "2026-09-09T12:00:00Z",
      NOW
    );
    expect(expiry.tone).toBeNull();
    expect(expiry.text).toBe("valid for 61 days");
  });

  /**
   * Would break if a missed renewal read as healthy. Past `renewalTime` the
   * silence is over: cert-manager said it would have renewed by now and has
   * not, and that is the fact worth colouring.
   */
  it("calls a missed renewal overdue", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-11T12:00:00Z", "2026-08-04T12:00:00Z"),
      "2026-08-09T01:00:00Z",
      NOW
    );
    expect(expiry).toMatchObject({
      tone: "warn",
      text: "renewal overdue — expires in 2 days",
      renewalOverdue: true,
    });
  });

  /**
   * Would break if a plan on paper could talk the app out of an emergency.
   * Ten hours from an outage is an interrupt whatever the schedule says.
   */
  it("keeps the emergency mark despite a future renewal", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-09T22:00:00Z", "2026-08-02T22:00:00Z"),
      "2026-08-09T14:00:00Z",
      NOW
    );
    expect(expiry).toMatchObject({
      tone: "err",
      text: "expires in 10 hours",
      renewalOverdue: false,
    });
  });

  it("escalates an overdue renewal that is nearly out of time", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-10T02:00:00Z", "2026-08-03T02:00:00Z"),
      "2026-08-09T00:00:00Z",
      NOW
    );
    expect(expiry).toMatchObject({
      tone: "err",
      text: "renewal overdue — expires in 14 hours",
      renewalOverdue: true,
    });
  });

  /** Would break if "renewal overdue" outranked "expired", which is worse. */
  it("says expired, not overdue, once it is dead", () => {
    const expiry = managedExpiryOf(
      facts("2026-08-08T12:00:00Z", "2026-08-01T12:00:00Z"),
      "2026-08-06T12:00:00Z",
      NOW
    );
    expect(expiry).toMatchObject({
      tone: "err",
      expired: true,
      text: "expired 1 day ago",
      renewalOverdue: false,
    });
  });

  /** Would break if the absence of a plan changed the plain verdict. */
  it("is exactly expiryOf when cert-manager named no renewal time", () => {
    const plain = facts("2026-08-11T12:00:00Z", "2026-08-04T12:00:00Z");
    expect(managedExpiryOf(plain, null, NOW)).toEqual(expiryOf(plain, NOW));
  });
});

describe("overdueBy", () => {
  it("says how far past the plan a renewal is", () => {
    expect(overdueBy("2026-08-09T01:00:00Z", NOW)).toBe("11 hours overdue");
    expect(overdueBy("2026-08-07T12:00:00Z", NOW)).toBe("2 days overdue");
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
