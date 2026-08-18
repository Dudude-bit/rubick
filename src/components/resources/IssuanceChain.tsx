/**
 * How a certificate came to be, and where that stopped working.
 *
 * A failed certificate is four objects deep — `Certificate` →
 * `CertificateRequest` → `Order` → `Challenge` — and the sentence that says
 * what actually went wrong is on the last one. The app used to show those
 * as four unrelated custom resources and leave the reader to walk them.
 *
 * **A chain that has not failed is quiet.** Most certificates renew fine
 * forever, and the walk exists for the one that did not; drawn on every
 * healthy certificate it would stop being read long before it was needed.
 * So a certificate that is simply serving gets one line.
 *
 * This draws whatever the `certificate.issuance` capability returned. It
 * does not know which extension answered, and there is nothing here that
 * mentions one.
 */

import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import type { Issuance } from "@/hooks/useCertificateIssuance";
import type { IssuanceStep, IssuanceStory } from "@/generated/types";
import { T } from "@/i18n/T";

/** "in 31 days", "6 days ago" — a date nobody has to subtract. */
function relative(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const days = Math.round((at - now) / 86_400_000);
  if (days === 0) return "today";
  return days > 0
    ? `in ${days} day${days === 1 ? "" : "s"}`
    : `${-days} day${days === -1 ? "" : "s"} ago`;
}

function issuerLine(story: IssuanceStory): string {
  return `${story.issuer} · ${story.issuerKind}`;
}

function Step({ step, last }: { step: IssuanceStep; last: boolean }) {
  return (
    <div className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5">
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            "mt-[5px] h-[7px] w-[7px] flex-none rounded-full border-[1.5px]",
            step.failed ? "border-err" : "border-fg bg-fg"
          )}
        />
        {!last && (
          <span
            aria-hidden="true"
            className={cn("min-h-[14px] w-px flex-1", "bg-hair")}
          />
        )}
      </div>
      <div className={cn("min-w-0", last ? "" : "pb-3")}>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-fg">{step.name}</span>
          <span className="text-[11px] text-fg-fnt">
            {step.kind} · {step.state}
          </span>
        </span>
        {step.note && <p className="text-[11px] text-fg-mut">{step.note}</p>}
      </div>
    </div>
  );
}

/**
 * The full block, for the page whose subject is the certificate.
 *
 * Every one of the three states an extension-backed surface owes is here:
 * absent, working, and there-but-not-answering. The middle one is the trap
 * — an extension that silently falls back looks exactly like one that was
 * never installed, and the reader concludes the app is broken.
 */
export function IssuanceSection({
  issuance,
  secretName,
}: {
  issuance: Issuance;
  secretName: string;
}) {
  // Not installed: the core answer above this stands whole, and there is
  // nothing to offer. Unlike a service with an address, an extension is not
  // something a button here could connect.
  if (!issuance.available) return null;

  if (issuance.error) {
    return (
      <Section>
        <SectionHeader title="Renewal" />
        <p className="text-xs text-warn">
          The certificate above was read from the Secret. Who renews it could
          not be read: {issuance.error.message}
        </p>
      </Section>
    );
  }

  if (!issuance.stories.has(secretName)) return null;
  const story = issuance.stories.get(secretName) ?? null;

  if (!story) {
    return (
      <Section>
        <SectionHeader title="Renewal" />
        <p className="text-xs text-fg-fnt">
          <T section="empty" k="nothingManagesSecret" />
        </p>
      </Section>
    );
  }

  if (!story.inFlight) {
    return (
      <Section>
        <SectionHeader title="Renewal" />
        <p className="text-xs text-fg-mut">
          Renewed automatically by{" "}
          <span className="font-mono">{story.certificate}</span>
          {story.renewalTime
            ? `, next ${relative(story.renewalTime)}`
            : ""} · {issuerLine(story)}
        </p>
      </Section>
    );
  }

  // Failed and stuck are different: cert-manager retries forever, so a
  // pending challenge with a reason on it is the common shape and is not
  // yet an error. Only an object that gave up gets the err tone.
  const failed = story.steps.some((step) => step.failed);
  const tone = failed ? "text-err" : story.failure ? "text-warn" : undefined;
  return (
    <Section>
      <SectionHeader
        title="Renewal"
        count={
          <span className={tone}>
            {failed ? "failed" : story.failure ? "not finished" : "in progress"}
            {story.since ? ` · started ${relative(story.since)}` : ""}
            {story.attempts ? ` · ${story.attempts} failed attempts` : ""}
          </span>
        }
      />
      <div className="flex flex-col">
        {story.steps.map((step, index) => (
          <Step
            key={`${step.kind}-${step.name}`}
            step={step}
            last={index === story.steps.length - 1}
          />
        ))}
      </div>
      {/* The sentence the whole walk exists to reach. */}
      {story.failure && (
        <p
          className={cn(
            "mt-2 wrap-break-word font-mono text-[11px]",
            failed ? "text-err" : "text-warn"
          )}
        >
          {story.failure}
        </p>
      )}
    </Section>
  );
}

/**
 * The one line the traffic chain can afford beside the certificate hop.
 *
 * The chain is a path, not a report: it says whether renewal is a problem
 * and leaves the four objects to the Secret's own page.
 */
export function RenewalNote({
  issuance,
  secretName,
}: {
  issuance: Issuance;
  secretName: string;
}) {
  if (!issuance.available || issuance.error) return null;
  const story = issuance.stories.get(secretName);
  if (!story) return null;

  if (!story.inFlight) {
    return (
      <p className="text-[11px] text-fg-fnt">
        {issuerLine(story)}
        {story.renewalTime
          ? ` · renews automatically ${relative(story.renewalTime)}`
          : ""}
      </p>
    );
  }
  // The verbatim reason runs to three wrapped lines of ACME URLs. That is
  // right on a page and wrong on a chain hop, so the hop says which object
  // has not finished and the Renewal block below carries the words.
  return (
    <p className="text-[11px] text-warn">
      Renewal has not finished
      {story.since ? `, since ${relative(story.since)}` : ""}
      {story.stalled ? ` — ${story.stalled}` : ""}
    </p>
  );
}
