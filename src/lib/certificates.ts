/**
 * How long a certificate has left, and whether that is news.
 *
 * A mark is earned. "Expires in 61 days" is the state almost every
 * certificate is in almost all of the time; colouring it teaches the reader
 * to stop looking, and then the one that says four days looks like the rest.
 *
 * Two thresholds, both about what the reader can still do rather than about
 * round numbers. **14 days** is the last point a normal change fits — raise
 * it, get the certificate, review, deploy, without anybody's evening. **3
 * days** is past the next weekend: no process left, only an interrupt.
 *
 * Both are caps, not the rule. A seven-day Let's Encrypt certificate is born
 * inside the fourteen-day window, and a mark worn from birth is a mark nobody
 * reads (#68) — so on a short certificate the thresholds shrink to a third
 * and a tenth of its lifetime, which puts the warn exactly at cert-manager's
 * default renewal point. A ninety-day certificate never notices.
 *
 * Outside the thresholds there is no mark. The fact is still stated where the
 * certificate is the subject, in the same tone as everything else.
 */

import { sayWords, spanWords, type Saying } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import type {
  CertificateFacts,
  CertificateProblem,
  Stalled,
  StepNote,
} from "@/generated/types";

/** The last point a normal change still fits, or a third of the lifetime. */
const ACT_SOON_DAYS = 14;
/** Past the weekend — an interrupt — or a tenth of the lifetime. */
const NO_PROCESS_LEFT_DAYS = 3;

const DAY = 86_400_000;

export type ExpiryTone = "warn" | "err" | null;

export interface Expiry {
  /** `null` where the fact is true but not news. */
  tone: ExpiryTone;
  /**
   * "expires in 4 days", "expired 3 days ago", "valid for 61 days" — as a
   * key, because an expiry is read inside a query as often as inside a
   * component. Render it with {@link expiryText}.
   */
  text: Saying;
  /** Whole days from now until `notAfter`; negative once it has passed. */
  days: number;
  /**
   * Milliseconds until `notAfter`, negative once it has passed — the same
   * quantity {@link days} rounds off.
   *
   * Ranking by whole days used to decide the order of everything expiring
   * inside one day by name, which is the hour the order matters most. `0`
   * where there is no readable date, so an unreadable one keeps the place
   * `days: 0` gave it rather than silently moving.
   */
  left: number;
  expired: boolean;
  /** cert-manager's own renewal plan has come and gone — see {@link managedExpiryOf}. */
  renewalOverdue: boolean;
}

/**
 * A span in the largest unit that still gives it a number.
 *
 * Every step down exists because the one above it rounds to zero, and "0
 * days" — or "0 hours" in the last hour of a certificate's life — reads as
 * a rendering bug at exactly the moment the reader most needs a number.
 * The floor is a minute: below that the number stops being useful before
 * it stops being true.
 */
export function expiryText(expiry: Expiry, t: T): string {
  return sayWords(expiry.text, t);
}

/**
 * The one sentence a certificate's validity is worth.
 *
 * `notBefore` is checked as well as `notAfter`: a certificate issued with a
 * clock skew, or restored from a backup of a future cluster, is refused by
 * browsers exactly as an expired one is, and it is the failure nobody
 * thinks to look for. It also supplies the lifetime the thresholds scale
 * by; without a readable one the absolute caps are the only honest rule.
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
      text: { key: "certNoExpiryDate" },
      days: 0,
      left: 0,
      expired: false,
      renewalOverdue: false,
    };
  }

  if (!Number.isNaN(notBefore) && notBefore > now) {
    const days = Math.ceil((notBefore - now) / DAY);
    return {
      tone: "err",
      text: { key: "certNotValidYet", values: { n: days } },
      days: Math.floor((notAfter - now) / DAY),
      left: notAfter - now,
      expired: false,
      renewalOverdue: false,
    };
  }

  const left = notAfter - now;
  if (left <= 0) {
    const days = Math.floor(-left / DAY);
    return {
      tone: "err",
      text:
        days === 0
          ? { key: "certExpiredToday" }
          : { key: "certExpiredAgo", values: { n: days } },
      days: -days,
      left,
      expired: true,
      renewalOverdue: false,
    };
  }

  const lifetime =
    !Number.isNaN(notBefore) && notBefore < notAfter
      ? notAfter - notBefore
      : null;
  const interruptAt =
    lifetime === null
      ? NO_PROCESS_LEFT_DAYS * DAY
      : Math.min(NO_PROCESS_LEFT_DAYS * DAY, lifetime / 10);
  const actAt =
    lifetime === null
      ? ACT_SOON_DAYS * DAY
      : Math.min(ACT_SOON_DAYS * DAY, lifetime / 3);

  const days = Math.floor(left / DAY);
  if (left <= interruptAt) {
    return {
      tone: "err",
      text: { key: "certExpiresIn", values: { spanMs: left } },
      days,
      left,
      expired: false,
      renewalOverdue: false,
    };
  }
  if (left <= actAt) {
    return {
      tone: "warn",
      text: { key: "certExpiresIn", values: { spanMs: left } },
      days,
      left,
      expired: false,
      renewalOverdue: false,
    };
  }
  return {
    tone: null,
    text: { key: "certValidFor", values: { spanMs: left } },
    days,
    left,
    expired: false,
    renewalOverdue: false,
  };
}

/**
 * {@link expiryOf}, told what cert-manager intends to do about it.
 *
 * A managed certificate is not renewed by the reader, so "expires in 2
 * days" is not their call to action — `status.renewalTime` is. While the
 * plan is still ahead a would-be warn is not news and the verdict states
 * the plan instead; once the plan has come and gone the silence is over,
 * because cert-manager said it would have renewed by now and has not.
 *
 * The err threshold is a backstop no schedule argues with: hours from an
 * outage is an interrupt whatever the plan says. Expired, not-yet-valid
 * and unreadable certificates keep their plain verdicts too.
 */
export function managedExpiryOf(
  facts: Pick<CertificateFacts, "notAfter" | "notBefore">,
  renewalTime: string | null,
  now: number = Date.now()
): Expiry {
  const base = expiryOf(facts, now);
  const renewal = renewalTime === null ? NaN : Date.parse(renewalTime);
  const notAfter = Date.parse(facts.notAfter);
  const notBefore = Date.parse(facts.notBefore);
  if (
    Number.isNaN(renewal) ||
    Number.isNaN(notAfter) ||
    base.expired ||
    (!Number.isNaN(notBefore) && notBefore > now)
  ) {
    return base;
  }

  if (renewal > now) {
    if (base.tone !== "warn") return base;
    return {
      ...base,
      tone: null,
      text: { key: "certRenewsIn", values: { spanMs: renewal - now } },
    };
  }
  return {
    ...base,
    tone: base.tone === "err" ? "err" : "warn",
    text: { key: "certRenewalOverdue", values: { spanMs: notAfter - now } },
    renewalOverdue: true,
  };
}

/** How far past its own plan a renewal is: "11 hours overdue". */
export function overdueBy(
  renewalTime: string,
  t: T,
  now: number = Date.now()
): string {
  return t("readings", "certOverdueBy", {
    span: spanWords(now - Date.parse(renewalTime), t),
  });
}

/** Who vouched for it, in the words the certificate itself uses. */
export function issuedBy(facts: CertificateFacts, t: T): string {
  if (facts.selfSigned) return t("readings", "certSelfSigned");
  return facts.issuer
    ? t("readings", "certIssuedBy", { name: facts.issuer })
    : t("readings", "certIssuerNotNamed");
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

/**
 * Why there is nothing to describe, in the reader's language.
 *
 * The backend names the reason instead of writing it: it runs before anyone
 * knows who is reading, and two of the five carry the API server's own words
 * inside a sentence that is ours.
 */
export function problemWords(problem: CertificateProblem, t: T): string {
  switch (problem.says) {
    case "noSecret":
      return t("readings", "certNoSecret");
    case "secretUnreadable":
      return t("readings", "certSecretUnreadable", { said: problem.said });
    case "noTlsCrt":
      return t("readings", "certNoTlsCrt");
    case "noPemCertificate":
      return t("readings", "certNoPem");
    case "unparseable":
      return t("readings", "certUnparseable", { said: problem.said });
  }
}

/**
 * What makes a step in the issuance chain that step.
 *
 * `said` is the controller's own message and is quoted; the other two are
 * the app's own clause, with the cluster's words as values inside it.
 */
export function stepNoteWords(note: StepNote, t: T): string {
  switch (note.says) {
    case "said":
      return note.text;
    case "attempt":
      return t("readings", "stepAttempt", { revision: note.revision });
    case "challengeOn":
      return t("readings", "stepChallengeOn", {
        kind: note.kind,
        domain: note.domain,
      });
  }
}

/** Which object in the issuance chain has not finished. */
export function stalledWords(stalled: Stalled, t: T): string {
  switch (stalled.says) {
    case "notRequested":
      return t("readings", "stalledNotRequested");
    case "requestNotIssued":
      return t("readings", "stalledRequestNotIssued");
    case "challengePending":
      return t("readings", "stalledChallengePending", {
        kind: stalled.kind,
        domain: stalled.domain,
      });
    case "orderNotCompleted":
      return t("readings", "stalledOrderNotCompleted");
  }
}
