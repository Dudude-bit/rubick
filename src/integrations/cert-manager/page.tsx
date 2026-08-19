/**
 * cert-manager's page: which certificates are in trouble, and why.
 *
 * ## Why a page at all
 *
 * The expiry date is not the reason. `tls.crt` states that itself and this
 * app reads it on a cluster with nothing installed — that fact belongs on the
 * Secret and on the Ingress that serves it, and it already lives there.
 *
 * What has no home is the *walk*: `Certificate` → `CertificateRequest` →
 * `Order` → `Challenge` is four unrelated custom resources, the sentence that
 * says what failed is on the last of them, and no core object can host that
 * shape. So the page is a list ordered by trouble with the walk under the row
 * that has one, and nothing else.
 *
 * ## Ordered by trouble, never by name
 *
 * The reader has one certificate that has not renewed for six days and
 * thirty that are fine, and the alphabet puts the answer wherever the
 * alphabet happens to put it. A row that is anything other than healthy opens
 * itself while there are few enough of them to read; past {@link AUTO_OPEN}
 * nothing opens itself, because a screen where everything is expanded is a
 * screen where nothing is emphasised.
 *
 * ## Where a link goes
 *
 * To the object in this app, every time. Each step of the walk is a real
 * custom resource with a real page, and the whole point of reading this here
 * rather than in `kubectl describe` is that the next click is already in the
 * right place.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck, Stamp } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { DetailTabs } from "@/components/resources/DetailTabs";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/resources/detail-tab";

import { cn } from "@/lib/utils";
import { ResourceType } from "@/lib/resource-registry";
import { FilterBox, Finding, TroubleRow } from "../page-kit";
import { usePicture } from "./data";
import { uncovered } from "./serves";
import {
  CERTIFICATES_CRD,
  CLUSTER_ISSUERS_CRD,
  ISSUERS_CRD,
  troubled,
  type CertRow,
  type CertStep,
  type IssuerRow,
  type UnreadKind,
} from "./model";
import { useT } from "@/i18n/useT";

/** Past this many troubled certificates, nothing opens itself. */
const AUTO_OPEN = 8;

export default function CertManagerPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "certificates";
  const { data, isPending, error } = usePicture();

  if (error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadCertificates")}
        </h2>
        <p className="text-xs text-fg-mut">
          {t("empty", "couldNotReadCertificatesBody")}
        </p>
        <p className="text-[11px] text-fg-fnt">{error.message}</p>
      </Section>
    );
  }

  const certificates = data?.certificates ?? [];
  const issuers = data?.issuers ?? [];
  const broken = troubled(certificates);

  // Which tab owes the reader the sentence depends on which read failed: an
  // unread issuer kind is the difference between "there is none" and "nobody
  // here knows", and an unread walk kind only shortens the walk.
  const unreadIssuers = (data?.unread ?? []).filter(
    (kind) => kind.crd === ISSUERS_CRD || kind.crd === CLUSTER_ISSUERS_CRD
  );
  const unreadWalk = (data?.unread ?? []).filter(
    (kind) => kind.crd !== ISSUERS_CRD && kind.crd !== CLUSTER_ISSUERS_CRD
  );

  const tabs: DetailTab[] = [
    {
      id: "certificates",
      label: "Certificates",
      glyph: viewGlyph(ShieldCheck),
      mark: certificatesMark(t, certificates, broken),
      content: (
        <CertificatesTab
          rows={certificates}
          loading={isPending}
          unread={unreadWalk}
        />
      ),
    },
    {
      id: "issuers",
      label: "Issuers",
      glyph: viewGlyph(Stamp),
      mark: issuersMark(t, issuers, unreadIssuers),
      content: (
        <IssuersTab rows={issuers} loading={isPending} unread={unreadIssuers} />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="cert-manager"
        count={
          isPending
            ? undefined
            : t("count", "certificatesAcrossNamespaces", {
                n: certificates.length,
              })
        }
        description={t("empty", "certManagerPageHint")}
      />
      <DetailTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={(next) => {
          const updated = new URLSearchParams(params);
          updated.set("tab", next);
          setParams(updated, { replace: true });
        }}
      />
    </div>
  );
}

/**
 * A count is inventory and a colour is why you came, so the mark never
 * carries both: thirty certificates with two failing renewals says two.
 */
function certificatesMark(
  t: ReturnType<typeof useT>,
  rows: CertRow[],
  broken: CertRow[]
): DetailTabMark | undefined {
  if (rows.length === 0) return undefined;
  if (broken.length === 0) return countMark(rows.length);
  return severityMark(
    broken.some((row) => row.state.tone === "err") ? "err" : "warn",
    t("count", "needAttentionOfTotal", { n: broken.length, total: rows.length })
  );
}

/**
 * The same rule, plus the one a count cannot express.
 *
 * A list short by an unknown amount is not a number, and an empty one nobody
 * was allowed to read is not an empty tab — leaving either unmarked is how a
 * reader gets to the strongest claim on the page without being warned that
 * the page is guessing.
 */
function issuersMark(
  t: ReturnType<typeof useT>,
  rows: IssuerRow[],
  unread: UnreadKind[]
): DetailTabMark | undefined {
  const broken = rows.filter((issuer) => issuer.ready === false);
  if (broken.length > 0) {
    return severityMark(
      "err",
      t("count", "issuersNotReady", { n: broken.length })
    );
  }
  if (unread.length > 0) {
    return severityMark(
      "warn",
      unread.length === 1
        ? t("empty", "crdCouldNotBeListed", { crd: `${unread[0].kind}s` })
        : t("empty", "issuersCouldNotBeRead")
    );
  }
  return rows.length === 0 ? undefined : countMark(rows.length);
}

/**
 * What could not be read, in the API server's own words, above whatever was.
 *
 * One block per kind rather than one rolled-up line: two kinds fail for two
 * reasons — a denial on the cluster-scoped one and a timeout on the other is
 * an ordinary pair — and the sentence for each is what the reader will act
 * on. `cost` is said once underneath, because it is the same cost either way
 * and it is the half that says why this is on screen at all.
 */
function Unread({ kinds, cost }: { kinds: UnreadKind[]; cost: string }) {
  const t = useT();
  if (kinds.length === 0) return null;
  return (
    <div className="mb-3 flex max-w-[64ch] flex-col gap-2">
      {kinds.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={
            <>
              <span className="font-mono">{kind.crd}</span>{" "}
              {t("empty", "couldNotBeListed")}
            </>
          }
          verbatim={kind.reason}
        />
      ))}
      <p className="text-[11px] text-fg-fnt">{cost}</p>
    </div>
  );
}

// --- certificates -------------------------------------------------------

function CertificatesTab({
  rows,
  loading,
  unread,
}: {
  rows: CertRow[];
  loading: boolean;
  /** Kinds the walk needs and did not get. */
  unread: UnreadKind[];
}) {
  const t = useT();
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.namespace.toLowerCase().includes(needle) ||
        (row.secretName ?? "").toLowerCase().includes(needle) ||
        (row.issuer?.name ?? "").toLowerCase().includes(needle) ||
        row.dnsNames.some((host) => host.toLowerCase().includes(needle))
    );
  }, [rows, filter]);

  if (loading) {
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingCertificates")}</p>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "nothingAskedForCertificate")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {t("empty", "noCertificateObjectAnywhere")
            .split("{annotation}")
            .map((part, i) => (
              <span key={i}>
                {i > 0 && (
                  <span className="font-mono">
                    cert-manager.io/cluster-issuer
                  </span>
                )}
                {part}
              </span>
            ))}
        </p>
      </div>
    );
  }

  const broken = rows.filter((row) => row.state.tone === "err").length;
  const worthALook = rows.filter((row) => row.state.tone === "warn").length;

  return (
    <div className="flex flex-col">
      <Unread kinds={unread} cost={t("empty", "certWalkCost")} />
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={setFilter}
          placeholder={t("action", "filterCertificatesPlaceholder")}
          label={t("action", "filterCertificates")}
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? t("count", "shownOfTotal", {
                n: shown.length,
                total: rows.length,
              })
            : broken > 0
              ? `${t("count", "brokenAndFirst", { n: broken, total: rows.length })}${
                  worthALook > 0
                    ? ` · ${t("count", "worthALook", { n: worthALook })}`
                    : ""
                }`
              : worthALook > 0
                ? `${t("empty", "nothingBroken")} · ${t("count", "worthALookOfTotal", { n: worthALook, total: rows.length })}`
                : t("count", "certificatesNoneWithProblem", {
                    n: rows.length,
                  })}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          {t("empty", "noCertificateMatchesFilter")}
        </p>
      ) : (
        shown.map((row) => (
          <CertificateRow
            key={row.key}
            row={row}
            openByDefault={row.state.tone === "err" && broken <= AUTO_OPEN}
          />
        ))
      )}
    </div>
  );
}

function CertificateRow({
  row,
  openByDefault,
}: {
  row: CertRow;
  openByDefault: boolean;
}) {
  return (
    // The name *is* a link now. It used to be plain text with a note saying
    // why — an anchor nested in the disclosure button is neither valid nor
    // operable — and `reference` is that constraint solved rather than
    // documented: the title leaves the button and becomes its own control.
    <TroubleRow
      title={row.name}
      reference={{
        kind: "Certificate",
        name: row.name,
        namespace: row.namespace,
        crd: CERTIFICATES_CRD,
      }}
      meta={
        <>
          {row.namespace}
          {row.dnsNames.length > 0 && ` · ${summarise(row.dnsNames)}`}
          {row.use.hosts.length > 0 &&
            ` · serving ${summarise([
              ...new Set(row.use.hosts.map((entry) => entry.host)),
            ])}`}
          {row.issuer && ` · ${row.issuer.name}`}
        </>
      }
      state={row.state}
      openByDefault={openByDefault}
      // A failure is why the reader is here, so it survives the row being
      // closed — collapsing hides the walk, never the sentence.
      brief={row.failure ? <FailureLine row={row} brief /> : undefined}
    >
      <Facts row={row} />
      <ServingLine row={row} />
      {row.steps.length > 0 && <Walk steps={row.steps} />}
      {row.failure && <FailureLine row={row} />}
    </TroubleRow>
  );
}

/**
 * What this certificate is actually serving, which the object never says.
 *
 * The reference runs the other way — an Ingress names the Secret, the
 * Certificate names nothing — so until now a row could say `Ready`, thirty
 * days left, and leave the reader to work out which address stops answering
 * when it does not renew.
 */
function ServingLine({ row }: { row: CertRow }) {
  const t = useT();
  const wrong = uncovered(row.use);

  if (row.use.hosts.length === 0) {
    return (
      <p className="max-w-[68ch] text-[11px] text-fg-fnt">
        {t("empty", "noIngressMountsSecret")
          .split(/(\{namespace\}|\{secret\})/)
          .map((part, i) =>
            part === "{namespace}" || part === "{secret}" ? (
              <span key={i} className="font-mono">
                {part === "{namespace}"
                  ? row.namespace
                  : (row.secretName ?? t("empty", "itsSecret"))}
              </span>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        {row.use.unusedIsCertain
          ? t("empty", "nothingServingCertificate")
          : t("empty", "routingCrdMayMount")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
        <span className="text-fg-fnt">{t("empty", "servingLabel")}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          {row.use.hosts.map((entry) => (
            <span
              key={`${entry.ingress.name}/${entry.host}`}
              className="min-w-0"
            >
              <span
                className={cn(
                  "font-mono",
                  entry.covered ? "text-fg-mid" : "text-err"
                )}
              >
                {entry.host}
              </span>
              <span className="ml-2 text-fg-fnt">
                from{" "}
                <ResourceRef
                  kind={ResourceType.Ingress}
                  name={entry.ingress.name}
                  namespace={entry.ingress.namespace}
                  showKind={false}
                />
              </span>
            </span>
          ))}
        </span>
      </div>
      {wrong.length > 0 && (
        <Finding
          tone="err"
          title={<>{t("count", "servedOnNames", { n: wrong.length })}</>}
        >
          {t("count", "servedNotInDnsNames", { n: wrong.length })
            .split(/(\{names\}|\{field\})/)
            .map((part, i) =>
              part === "{names}" ? (
                <span key={i} className="font-mono">
                  {[
                    ...new Set(
                      wrong.map((entry: { host: string }) => entry.host)
                    ),
                  ].join(", ")}
                </span>
              ) : part === "{field}" ? (
                <span key={i} className="font-mono">
                  spec.dnsNames
                </span>
              ) : (
                <span key={i}>{part}</span>
              )
            )}
        </Finding>
      )}
    </div>
  );
}

/** Three names and a tally: a row is a summary, not the whole list. */
function summarise(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function Facts({ row }: { row: CertRow }) {
  const t = useT();
  return (
    <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
      <span className="text-fg-fnt">Certificate</span>
      <span className="min-w-0">
        <ResourceRef
          kind="Certificate"
          name={row.name}
          namespace={row.namespace}
          crd={CERTIFICATES_CRD}
          showKind={false}
        />
        <span className="ml-2 text-fg-fnt">{row.namespace}</span>
      </span>

      <span className="text-fg-fnt">{t("empty", "namesLabel")}</span>
      <span className="min-w-0 wrap-break-word font-mono text-fg-mid">
        {row.dnsNames.length > 0
          ? row.dnsNames.join(", ")
          : t("empty", "noneInTheSpec")}
      </span>

      <span className="text-fg-fnt">Secret</span>
      <span className="min-w-0">
        {row.secretName ? (
          <ResourceRef
            kind="Secret"
            name={row.secretName}
            namespace={row.namespace}
            showKind={false}
          />
        ) : (
          <span className="text-err">{t("empty", "noneNamed")}</span>
        )}
        {row.neverIssued && (
          <span className="ml-2 text-[11px] text-err">
            {t("empty", "secretDoesNotExistYet")}
          </span>
        )}
      </span>

      <span className="text-fg-fnt">Issuer</span>
      <span className="min-w-0">
        {row.issuer ? (
          <ResourceRef
            kind={row.issuer.kind}
            name={row.issuer.name}
            namespace={
              row.issuer.kind === "ClusterIssuer" ? null : row.namespace
            }
            crd={
              row.issuer.kind === "ClusterIssuer"
                ? CLUSTER_ISSUERS_CRD
                : ISSUERS_CRD
            }
            showKind={false}
          />
        ) : (
          <span className="text-err">{t("empty", "noneNamed")}</span>
        )}
        {row.issuer && (
          <span className="ml-2 text-fg-fnt">{row.issuer.kind}</span>
        )}
      </span>

      {/* Only where cert-manager has said so. A renewal date this app worked
          out from a validity period would be a guess about somebody else's
          scheduler. */}
      {row.renewalTime && (
        <>
          <span className="text-fg-fnt">{t("empty", "renewsLabel")}</span>
          <span className="font-mono text-fg-mid">
            {new Date(row.renewalTime).toLocaleString()}
          </span>
        </>
      )}
      {row.failedAttempts !== null && row.failedAttempts > 0 && (
        <>
          <span className="text-fg-fnt">{t("empty", "attemptsLabel")}</span>
          <span className="text-err">
            {t("count", "failedAttemptsSoFar", { n: row.failedAttempts })}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The walk, left as four rows rather than drawn as a chain.
 *
 * Traefik's chain is fixed-width and fixed-order — five columns, every host
 * — and this is not: a certificate for four hosts has one Challenge per host,
 * and the note under each is a sentence rather than a name. Boxes in a row
 * would clip exactly the string the reader came for.
 */
function Walk({ steps }: { steps: CertStep[] }) {
  const t = useT();
  return (
    <div className="flex flex-col">
      <span className="mb-1 text-[9.5px] uppercase tracking-[0.08em] text-fg-fnt">
        {t("empty", "whatItIsWaitingOn")}
      </span>
      {steps.map((step, index) => (
        <div
          key={`${step.kind}/${step.name}`}
          className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5"
        >
          {/* The run of line below a step carries the colour of what comes
              next, so the segment leading into the failure turns red. */}
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`mt-[5px] h-[7px] w-[7px] flex-none rounded-full border-[1.5px] ${
                step.failed ? "border-err" : "border-fg"
              }`}
            />
            {index < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={`min-h-[12px] w-px flex-1 ${
                  steps[index + 1].failed ? "bg-err/40" : "bg-hair"
                }`}
              />
            )}
          </div>
          <div
            className={index < steps.length - 1 ? "min-w-0 pb-2" : "min-w-0"}
          >
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[10px] uppercase tracking-[0.06em] text-fg-fnt">
                {step.kind}
              </span>
              <span className="min-w-0 truncate">
                <ResourceRef
                  kind={step.kind}
                  name={step.name}
                  namespace={step.namespace}
                  crd={step.crd}
                  showKind={false}
                />
              </span>
              <span
                className={`text-[11px] ${step.failed ? "text-err" : "text-fg-mut"}`}
              >
                {step.state}
              </span>
            </span>
            {step.note && (
              <p className="mt-0.5 select-text wrap-break-word font-mono text-[11px] text-fg-mut">
                {step.note}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The deepest sentence on the walk, in the controller's own words.
 *
 * Never paraphrased and never truncated to a tidy width: a rewritten error is
 * a second guess at somebody else's failure, and this string is what the
 * reader will paste into a search.
 */
function FailureLine({ row, brief }: { row: CertRow; brief?: boolean }) {
  const t = useT();
  return (
    <Finding
      tone="err"
      title={
        row.neverIssued
          ? t("empty", "certNeverIssued")
          : t("empty", "certNotRenewing")
      }
      verbatim={row.failure}
    >
      {!brief &&
        (row.neverIssued ? (
          <>
            {t("empty", "nothingServingTlsFrom")
              .split("{secret}")
              .map((part, i) => (
                <span key={i}>
                  {i > 0 && (
                    <span className="font-mono">
                      {row.secretName ?? t("empty", "itsSecret")}
                    </span>
                  )}
                  {part}
                </span>
              ))}
          </>
        ) : (
          <>
            {(row.expiry
              ? t("empty", "certificateStillServedUntil", {
                  expiry: row.expiry.text,
                })
              : t("empty", "certificateStillServed")
            )
              .split("{secret}")
              .map((part, i) => (
                <span key={i}>
                  {i > 0 && (
                    <span className="font-mono">
                      {row.secretName ?? t("empty", "itsSecret")}
                    </span>
                  )}
                  {part}
                </span>
              ))}
          </>
        ))}
    </Finding>
  );
}

// --- issuers ------------------------------------------------------------

function IssuersTab({
  rows,
  loading,
  unread,
}: {
  rows: IssuerRow[];
  loading: boolean;
  /** Which of the two issuer kinds this reader could not read. */
  unread: UnreadKind[];
}) {
  const t = useT();
  if (loading)
    return (
      <p className="text-xs text-fg-fnt">{t("empty", "readingIssuers")}</p>
    );

  // "This cluster has no issuer" is the strongest claim on the page and the
  // only one that would send somebody off to create an object they already
  // have. It is allowed exactly when both kinds were read.
  if (rows.length === 0 && unread.length > 0) {
    return <Unread kinds={unread} cost={t("empty", "issuersUnknownCost")} />;
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          {t("empty", "noIssuerNoClusterIssuer")}
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          {t("empty", "certManagerNeedsIssuer")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Unread kinds={unread} cost={t("empty", "issuersPartialCost")} />
      {rows.map((row, index) => (
        <IssuerLine key={row.key} row={row} last={index === rows.length - 1} />
      ))}
    </div>
  );
}

function IssuerLine({ row, last }: { row: IssuerRow; last: boolean }) {
  const t = useT();
  const state =
    row.ready === null
      ? { text: t("empty", "noStatusYet"), tone: "warn" as const }
      : row.ready
        ? { text: t("empty", "readyLower"), tone: "ok" as const }
        : { text: t("empty", "notReadyLower"), tone: "err" as const };

  return (
    <TroubleRow
      title={row.name}
      reference={{
        kind: row.kind,
        name: row.name,
        namespace: row.namespace,
        crd: row.crd,
      }}
      meta={
        <>
          {row.kind === "ClusterIssuer"
            ? t("empty", "everyNamespace")
            : (row.namespace ?? "")}
          {row.type && ` · ${row.type}`}
          {row.detail && ` · ${row.detail}`}
          {` · ${
            row.serves === 0
              ? t("empty", "noCertificateNamesIt")
              : t("count", "certificates", { n: row.serves })
          }`}
        </>
      }
      state={state}
      openByDefault={row.ready === false}
      last={last}
    >
      <p className="text-[11.5px]">
        <ResourceRef
          kind={row.kind}
          name={row.name}
          namespace={row.namespace}
          crd={row.crd}
          showKind={false}
        />
        <span className="ml-2 text-fg-fnt">{row.kind}</span>
      </p>
      {row.message ? (
        <Finding
          tone="err"
          title={t("empty", "issuerRefusing")}
          verbatim={row.message}
        >
          {row.serves > 0 &&
            t("count", "nothingSignsCanRenew", { n: row.serves })}
        </Finding>
      ) : (
        <p className="text-[11.5px] text-fg-mut">
          {row.serves === 0
            ? t("empty", "healthySigningNothing")
            : t("count", "healthyAndSigns", { n: row.serves })}
        </p>
      )}
    </TroubleRow>
  );
}
