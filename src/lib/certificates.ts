/**
 * How long a certificate has left, and whether that is news.
 *
 * The app's discipline is that a mark is earned. "Expires in 61 days" is
 * the state almost every certificate in every cluster is in almost all of
 * the time — colouring it teaches the reader to stop looking, and then the
 * one that says four days looks like all the others.
 *
 * So two thresholds, and both of them are about what the reader can still
 * do rather than about round numbers:
 *
 * - **14 days** is the last point a normal change fits: raise it, get the
 *   certificate, review it, deploy it, without anybody's evening. Inside
 *   that window the reader has to start, so it is worth a warn.
 * - **3 days** is past the next weekend. There is no process left at that
 *   point, only an interrupt, and that is a different colour.
 *
 * Above fourteen days there is no mark at all. The fact is still stated
 * where the certificate is the subject — a Secret page that would not say
 * when its certificate expires is absurd — but it is stated in the same
 * tone as everything else on the page.
 */

import type { CertificateFacts } from "@/generated/types";

/** The last point a normal change still fits. */
export const ACT_SOON_DAYS = 14;
/** Past the weekend: an interrupt rather than a change. */
const NO_PROCESS_LEFT_DAYS = 3;

const DAY = 86_400_000;

export type ExpiryTone = "warn" | "err" | null;

export interface Expiry {
  /** `null` where the fact is true but not news. */
  tone: ExpiryTone;
  /** "expires in 4 days", "expired 3 days ago", "valid for 61 days". */
  text: string;
  /** Whole days from now until `notAfter`; negative once it has passed. */
  days: number;
  expired: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The one sentence a certificate's validity is worth.
 *
 * `notBefore` is checked as well as `notAfter`: a certificate issued with a
 * clock skew, or restored from a backup of a future cluster, is refused by
 * browsers exactly as an expired one is, and it is the failure nobody
 * thinks to look for.
 */
export function expiryOf(
  facts: Pick<CertificateFacts, "notAfter" | "notBefore">,
  now: number = Date.now()
): Expiry {
  const notAfter = Date.parse(facts.notAfter);
  const notBefore = Date.parse(facts.notBefore);

  if (Number.isNaN(notAfter)) {
    return {
      tone: "warn",
      text: "no readable expiry date",
      days: 0,
      expired: false,
    };
  }

  if (!Number.isNaN(notBefore) && notBefore > now) {
    const days = Math.ceil((notBefore - now) / DAY);
    return {
      tone: "err",
      text: `not valid for another ${plural(days, "day")}`,
      days: Math.floor((notAfter - now) / DAY),
      expired: false,
    };
  }

  const left = notAfter - now;
  if (left <= 0) {
    const days = Math.floor(-left / DAY);
    return {
      tone: "err",
      text: days === 0 ? "expired today" : `expired ${plural(days, "day")} ago`,
      days: -days,
      expired: true,
    };
  }

  const days = Math.floor(left / DAY);
  if (days <= NO_PROCESS_LEFT_DAYS) {
    const hours = Math.floor(left / 3_600_000);
    return {
      tone: "err",
      text:
        hours < 24
          ? `expires in ${plural(hours, "hour")}`
          : `expires in ${plural(days, "day")}`,
      days,
      expired: false,
    };
  }
  if (days <= ACT_SOON_DAYS) {
    return {
      tone: "warn",
      text: `expires in ${plural(days, "day")}`,
      days,
      expired: false,
    };
  }
  return {
    tone: null,
    text: `valid for ${plural(days, "day")}`,
    days,
    expired: false,
  };
}

/** Who vouched for it, in the words the certificate itself uses. */
export function issuedBy(facts: CertificateFacts): string {
  if (facts.selfSigned)
    return "self-signed — nothing above it vouched for this";
  return facts.issuer ? `issued by ${facts.issuer}` : "issuer not named";
}

/**
 * Whether a certificate's names cover a host.
 *
 * A wildcard covers exactly one label, which is the rule browsers apply:
 * `*.example.com` serves `shop.example.com` and refuses
 * `a.shop.example.com`. Wrong in the lenient direction, the app would call
 * a setup fine that every browser rejects.
 */
export function covers(dnsNames: string[], host: string): boolean {
  const wanted = host.replace(/\.$/, "").toLowerCase();
  return dnsNames.some((name) => {
    const given = name.replace(/\.$/, "").toLowerCase();
    if (given.startsWith("*.")) {
      const suffix = given.slice(1);
      if (!wanted.endsWith(suffix)) return false;
      const label = wanted.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".");
    }
    return given === wanted;
  });
}

/**
 * The hosts an Ingress serves that its certificate does not name.
 *
 * A certificate that is perfectly valid for the wrong name is the failure
 * that reads as working everywhere else in the app.
 */
export function uncoveredHosts(
  facts: CertificateFacts,
  hosts: string[]
): string[] {
  return hosts.filter(
    (host) => host && host !== "*" && !covers(facts.dnsNames, host)
  );
}
