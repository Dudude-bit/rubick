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
import { Link } from "react-router-dom";
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

import { crdObjectPath, plural } from "../kit";
import { FilterBox, Finding, TroubleRow } from "../page-kit";
import { usePicture } from "./data";
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

/** Past this many troubled certificates, nothing opens itself. */
const AUTO_OPEN = 8;

export default function CertManagerPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "certificates";
  const { data, isPending, error } = usePicture();

  if (error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s certificates
        </h2>
        <p className="text-xs text-fg-mut">
          Every row on this page comes from the cert-manager objects in this API
          server, and that request failed — so the list would be a guess rather
          than an answer.
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
      mark: certificatesMark(certificates, broken),
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
      mark: issuersMark(issuers, unreadIssuers),
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
            : `${plural(certificates.length, "certificate")} across every namespace`
        }
        description="What has a certificate, what is running out, and what has stopped renewing."
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
  rows: CertRow[],
  broken: CertRow[]
): DetailTabMark | undefined {
  if (rows.length === 0) return undefined;
  if (broken.length === 0) return countMark(rows.length);
  return severityMark(
    broken.some((row) => row.state.tone === "err") ? "err" : "warn",
    `${broken.length} of ${rows.length} need attention`
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
  rows: IssuerRow[],
  unread: UnreadKind[]
): DetailTabMark | undefined {
  const broken = rows.filter((issuer) => issuer.ready === false);
  if (broken.length > 0) {
    return severityMark("err", `${plural(broken.length, "issuer")} not ready`);
  }
  if (unread.length > 0) {
    return severityMark(
      "warn",
      unread.length === 1
        ? `${unread[0].kind}s could not be read`
        : "issuers could not be read"
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
  if (kinds.length === 0) return null;
  return (
    <div className="mb-3 flex max-w-[64ch] flex-col gap-2">
      {kinds.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={
            <>
              <span className="font-mono">{kind.crd}</span> could not be listed
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
    return <p className="text-xs text-fg-fnt">Reading the certificates…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          cert-manager is running here and nothing has asked it for a
          certificate.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          No Certificate object exists in any namespace, and no Ingress carries
          the <span className="font-mono">cert-manager.io/cluster-issuer</span>{" "}
          annotation that would make one.
        </p>
      </div>
    );
  }

  const broken = rows.filter((row) => row.state.tone === "err").length;
  const worthALook = rows.filter((row) => row.state.tone === "warn").length;

  return (
    <div className="flex flex-col">
      <Unread
        kinds={unread}
        cost="The walk under a certificate that is stuck stops at the last kind that could be read, so a step missing from it is not a step that did not happen."
      />
      <div className="mb-1 flex items-center gap-3">
        <FilterBox
          value={filter}
          onChange={setFilter}
          placeholder="Filter by name, namespace, host or issuer"
          label="Filter certificates"
        />
        <span className="text-[11px] text-fg-fnt">
          {filter.trim() !== ""
            ? `${shown.length} of ${rows.length}`
            : broken > 0
              ? `${broken} of ${rows.length} broken, and first${worthALook > 0 ? ` · ${worthALook} worth a look` : ""}`
              : worthALook > 0
                ? `nothing broken · ${worthALook} of ${rows.length} worth a look`
                : `${plural(rows.length, "certificate")}, none with a problem`}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-xs text-fg-fnt">
          No certificate, host or issuer here matches that.
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
    // The name is not a link. It sits inside the disclosure button, and an
    // anchor nested in a button is neither valid nor operable — the object's
    // own page is one row down under "Certificate", where it can be one.
    <TroubleRow
      title={row.name}
      meta={
        <>
          {row.namespace}
          {row.dnsNames.length > 0 && ` · ${summarise(row.dnsNames)}`}
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
      {row.steps.length > 0 && <Walk steps={row.steps} />}
      {row.failure && <FailureLine row={row} />}
    </TroubleRow>
  );
}

/** Three names and a tally: a row is a summary, not the whole list. */
function summarise(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function Facts({ row }: { row: CertRow }) {
  return (
    <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
      <span className="text-fg-fnt">Certificate</span>
      <span className="min-w-0">
        <Link
          to={crdObjectPath(CERTIFICATES_CRD, row.namespace, row.name)}
          className="font-mono text-info hover:underline"
        >
          {row.name}
        </Link>
        <span className="ml-2 text-fg-fnt">{row.namespace}</span>
      </span>

      <span className="text-fg-fnt">Names</span>
      <span className="min-w-0 wrap-break-word font-mono text-fg-mid">
        {row.dnsNames.length > 0 ? row.dnsNames.join(", ") : "none in the spec"}
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
          <span className="text-err">none named</span>
        )}
        {row.neverIssued && (
          <span className="ml-2 text-[11px] text-err">
            does not exist yet — nothing can serve TLS from it
          </span>
        )}
      </span>

      <span className="text-fg-fnt">Issuer</span>
      <span className="min-w-0">
        {row.issuer ? (
          <Link
            to={crdObjectPath(
              row.issuer.kind === "ClusterIssuer"
                ? CLUSTER_ISSUERS_CRD
                : ISSUERS_CRD,
              row.issuer.kind === "ClusterIssuer" ? null : row.namespace,
              row.issuer.name
            )}
            className="font-mono text-info hover:underline"
          >
            {row.issuer.name}
          </Link>
        ) : (
          <span className="text-err">none named</span>
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
          <span className="text-fg-fnt">Renews</span>
          <span className="font-mono text-fg-mid">
            {new Date(row.renewalTime).toLocaleString()}
          </span>
        </>
      )}
      {row.failedAttempts !== null && row.failedAttempts > 0 && (
        <>
          <span className="text-fg-fnt">Attempts</span>
          <span className="text-err">
            {plural(row.failedAttempts, "failed attempt")} so far
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
  return (
    <div className="flex flex-col">
      <span className="mb-1 text-[9.5px] uppercase tracking-[0.08em] text-fg-fnt">
        What it is waiting on
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
              <Link
                to={crdObjectPath(step.crd, step.namespace, step.name)}
                className="min-w-0 truncate font-mono text-[11.5px] text-info hover:underline"
              >
                {step.name}
              </Link>
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
  return (
    <Finding
      tone="err"
      title={
        row.neverIssued
          ? "This certificate has never been issued"
          : "This certificate is not renewing"
      }
      verbatim={row.failure}
    >
      {!brief &&
        (row.neverIssued ? (
          <>
            Nothing is serving TLS from{" "}
            <span className="font-mono">{row.secretName ?? "its Secret"}</span>,
            so every host above it is refused or served in the clear.
          </>
        ) : (
          <>
            The certificate already in{" "}
            <span className="font-mono">{row.secretName ?? "its Secret"}</span>{" "}
            is still being served, so this is not an outage yet
            {row.expiry ? ` — it ${row.expiry.text}` : ""}.
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
  if (loading)
    return <p className="text-xs text-fg-fnt">Reading the issuers…</p>;

  // "This cluster has no issuer" is the strongest claim on the page and the
  // only one that would send somebody off to create an object they already
  // have. It is allowed exactly when both kinds were read.
  if (rows.length === 0 && unread.length > 0) {
    return (
      <Unread
        kinds={unread}
        cost="So nothing here can say whether this cluster has an issuer: the list is empty because a read failed, not because there is nothing in it."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-[64ch]">
        <p className="text-xs text-fg-mut">
          This cluster has no Issuer and no ClusterIssuer.
        </p>
        <p className="mt-1.5 text-[11px] text-fg-fnt">
          cert-manager signs nothing without one, so any Certificate here will
          sit unissued until one exists.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Unread
        kinds={unread}
        cost="So this is only what could be read, and an issuer missing from it is not one that does not exist."
      />
      {rows.map((row, index) => (
        <IssuerLine key={row.key} row={row} last={index === rows.length - 1} />
      ))}
    </div>
  );
}

function IssuerLine({ row, last }: { row: IssuerRow; last: boolean }) {
  const state =
    row.ready === null
      ? { text: "no status yet", tone: "warn" as const }
      : row.ready
        ? { text: "ready", tone: "ok" as const }
        : { text: "not ready", tone: "err" as const };

  return (
    <TroubleRow
      title={row.name}
      meta={
        <>
          {row.kind === "ClusterIssuer"
            ? "every namespace"
            : (row.namespace ?? "")}
          {row.type && ` · ${row.type}`}
          {row.detail && ` · ${row.detail}`}
          {` · ${
            row.serves === 0
              ? "no certificate names it"
              : plural(row.serves, "certificate")
          }`}
        </>
      }
      state={state}
      openByDefault={row.ready === false}
      last={last}
    >
      <p className="text-[11.5px]">
        <Link
          to={crdObjectPath(row.crd, row.namespace, row.name)}
          className="font-mono text-info hover:underline"
        >
          {row.name}
        </Link>
        <span className="ml-2 text-fg-fnt">{row.kind}</span>
      </p>
      {row.message ? (
        <Finding
          tone="err"
          title="This issuer is refusing"
          verbatim={row.message}
        >
          {row.serves > 0 &&
            `Nothing it signs can renew while it is in this state — ${plural(row.serves, "certificate")} names it.`}
        </Finding>
      ) : (
        <p className="text-[11.5px] text-fg-mut">
          {row.serves === 0
            ? "It is healthy and no Certificate names it, so it is signing nothing."
            : `It is healthy and signs ${plural(row.serves, "certificate")}.`}
        </p>
      )}
    </TroubleRow>
  );
}
