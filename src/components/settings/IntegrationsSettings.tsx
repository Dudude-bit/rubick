import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { ConnectIntegration } from "@/components/settings/ConnectIntegration";
import { SettingsGroup } from "@/components/settings/settings-row";
import { useSettingSearchMatch } from "@/components/settings/settings-search";
import { Button } from "@/components/ui/button";
import {
  EXTENSION_NAMES,
  useIntegrations,
  type IntegrationStatus,
  type VendorFact,
} from "@/integrations";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

/**
 * The one screen allowed to name an extension.
 *
 * Everywhere else asks for a capability. Here the reader is asking a
 * different question — what does this cluster have, and is it working —
 * and the answer is a list of names with what each one is currently doing
 * underneath it.
 *
 * **Two kinds of row, and the difference is real.** A *detected* extension
 * has no Connect button and no fields, because there is nothing to connect
 * or fill in: its CRDs exist in this cluster's API server or they do not.
 * A *configured* one is the opposite — it is only here because somebody
 * gave it an address, so its row carries that address, when it last
 * answered, and a way to change it. Neither kind gets an install button:
 * the app does not put things into anybody's cluster, so a dimmed row
 * saying what it *would* give is the whole of what absence is allowed to
 * say for a detected extension, and a Connect button is the whole of what
 * it is allowed to say for a configured one.
 *
 * And a broken one says so *here*, once, instead of leaving the reader to
 * infer it from a chart somewhere else that quietly went shorter.
 *
 * A status list, not a dashboard. No charts, no per-object tables, no
 * editing beyond the address: every fact ends in a link to the objects that
 * own it, and the reader continues in the part of the app built for them.
 */
export function IntegrationsSettings({ active = true }: { active?: boolean }) {
  const t = useT();
  const { statuses, isPending, error } = useIntegrations({ facts: active });
  // The sidebar sends an extension that owns no screen here rather than
  // nowhere, and a pane of fourteen rows is not an answer to "show me
  // Prometheus" unless it says which row that is.
  const [params] = useSearchParams();
  const asked = params.get("vendor");

  if (error) {
    return (
      <div className="max-w-[64ch] py-8">
        <h3 className="text-xs font-medium text-fg">
          {t("empty", "couldNotReadCrds")}
        </h3>
        <p className="mt-1.5 text-xs text-fg-mut">
          {t("empty", "crdDetectionFailed")}
        </p>
        <p className="mt-2 text-[11px] text-fg-fnt">{error.message}</p>
      </div>
    );
  }

  // Two groups, because the two kinds answer to different rules and a
  // reader scanning this screen is asking two different questions: what does
  // this cluster already have, and what could I plug in.
  const configured = statuses.filter((status) => status.connection !== null);
  const detected = statuses.filter((status) => status.connection === null);
  const anyDetected = detected.some((status) => status.installed);

  return (
    <div className="flex flex-col gap-6">
      {configured.length > 0 && (
        <SettingsGroup title={t("settings", "configuredGroup")}>
          {configured.map((status) => (
            <ExtensionRow
              key={status.vendor.id}
              status={status}
              isPending={isPending}
              asked={asked === status.vendor.id}
            />
          ))}
        </SettingsGroup>
      )}
      {!isPending && !anyDetected ? (
        <NothingInstalled />
      ) : (
        <SettingsGroup title={t("settings", "detectedGroup")}>
          {detected.map((status) => (
            <ExtensionRow
              key={status.vendor.id}
              status={status}
              isPending={isPending}
              asked={asked === status.vendor.id}
            />
          ))}
        </SettingsGroup>
      )}
    </div>
  );
}

/**
 * Naming what was looked for is the point.
 *
 * "No integrations" leaves the reader wondering whether the app checked,
 * checked for the right things, or is broken. The names and the method
 * answer all three, and they double as the list of what supporting one
 * would buy.
 */
function NothingInstalled() {
  const t = useT();
  const visible = useSettingSearchMatch(
    "integrations extensions",
    EXTENSION_NAMES.join(" ")
  );
  return (
    <div className={cn("max-w-[64ch] py-8", !visible && "hidden")}>
      <h3 className="text-xs font-medium text-fg">
        {t("empty", "nothingInstalledKnown")}
      </h3>
      <p className="mt-1.5 text-xs text-fg-mut">
        {t("empty", "everyExtensionOptional")}
      </p>
      <p className="mt-2 text-[11px] text-fg-fnt">
        {t("empty", "lookedForExtensions", {
          list: sentenceList(EXTENSION_NAMES, t("empty", "listAnd")),
        })}
      </p>
    </div>
  );
}

/** "a, b and c" — the list reads as a sentence, because it is one. */
function sentenceList(names: readonly string[], and: string): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

function ExtensionRow({
  status,
  isPending,
  asked,
}: {
  status: IntegrationStatus;
  isPending: boolean;
  /** Whether the reader arrived here asking for this row by name. */
  asked?: boolean;
}) {
  const t = useT();
  const { vendor, extension, installed, version, facts, connection } = status;
  const Icon = extension.icon;
  const visible = useSettingSearchMatch(vendor.name, extension.gives);
  const [editing, setEditing] = React.useState(false);
  const row = React.useRef<HTMLDivElement>(null);

  // Scrolled to on arrival, and only then: doing it on every render would
  // fight the reader every time they scrolled away from it.
  React.useEffect(() => {
    if (!asked || !visible) return;
    row.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [asked, visible]);

  // A configured vendor is never "looking…": nothing is being detected, and
  // its own state says whether the address has been read yet.
  const configured =
    connection !== null && connection.state !== "notConfigured";
  const pending = connection ? connection.state === "reading" : isPending;
  // The facts belong under a configured row even when it is not answering —
  // that is where its address and its refusal are printed.
  const showFacts = connection ? configured : installed;

  return (
    <div
      ref={row}
      className={cn(
        "grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-hair py-2.5",
        // Dimmed rather than hidden: the absent ones are the list of what
        // this cluster could gain, and that is worth reading once.
        !installed && !configured && !pending && "opacity-55",
        // A ring rather than a fill, and it stays: the reader came here for
        // this row and may sit on it for a while, so a flash that has already
        // faded by the time the pane settles would have said nothing.
        asked && "-mx-2 rounded-[5px] px-2 ring-1 ring-info",
        !visible && "hidden"
      )}
      hidden={!visible}
    >
      <Icon className="mt-0.5 size-4 text-fg-mut" aria-hidden />
      <div className="min-w-0">
        <div className="text-xs text-fg-mid">
          {vendor.name}
          {version && (
            <span className="ml-2 font-mono text-[11px] text-fg-fnt">
              {version}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-fnt">
          {installed || configured
            ? t("empty", "gives")
            : t("empty", "wouldGive")}{" "}
          <span className="text-fg-mut">{extension.gives}</span>
        </div>
        {showFacts && <Facts facts={facts} />}
      </div>
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "whitespace-nowrap text-[11px]",
            pending
              ? "text-fg-fnt"
              : connection
                ? connection.state === "connected"
                  ? "text-ok"
                  : connection.state === "unreachable"
                    ? "text-err"
                    : "text-fg-fnt"
                : installed
                  ? "text-ok"
                  : "text-fg-fnt"
          )}
        >
          {pending
            ? connection
              ? t("empty", "asking")
              : t("empty", "looking")
            : connection
              ? t("empty", CONNECTION_WORD[connection.state])
              : installed
                ? t("empty", "detected")
                : t("empty", "notInstalled")}
        </span>
        {connection && !pending && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditing(true)}
            >
              {configured ? t("action", "edit") : t("action", "connect")}
            </Button>
            <ConnectIntegration
              vendorId={vendor.id}
              vendorName={vendor.name}
              gives={extension.gives}
              open={editing}
              onOpenChange={setEditing}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The word for each state, and there are four because there are four.
 *
 * "not configured" is not "not installed": the app has no idea whether the
 * thing exists, only that nobody has given it an address.
 */
const CONNECTION_WORD: Record<string, keyof typeof en.empty> = {
  reading: "asking",
  notConfigured: "notConfigured",
  connected: "connected",
  unreachable: "noAnswer",
};

/**
 * What it is doing for you, as the second half of the sentence "gives"
 * starts.
 *
 * A count is quiet and a problem is coloured — the same discipline the
 * condition rows and the tab marks follow. "7 certificates" is inventory;
 * "1 renewal failing" is why you came.
 */
function Facts({ facts }: { facts: IntegrationStatus["facts"] }) {
  const t = useT();
  if (facts.state === "none") return null;
  if (facts.state === "loading") {
    return (
      <p className="mt-1.5 text-[11px] text-fg-fnt">
        {t("action", "readingInline")}
      </p>
    );
  }
  if (facts.state === "failed") {
    return (
      <p className="mt-1.5 text-[11px] text-warn">
        {t("empty", "installedButUnreadable", { reason: facts.reason })}
      </p>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
      {facts.facts.map((fact) => (
        <Fact key={fact.text} fact={fact} />
      ))}
    </div>
  );
}

function Fact({ fact }: { fact: VendorFact }) {
  const tone =
    fact.tone === "err"
      ? "text-err"
      : fact.tone === "warn"
        ? "text-warn"
        : "text-fg-mut";
  if (!fact.to) return <span className={tone}>{fact.text}</span>;
  return (
    <Link to={fact.to} className="text-info hover:underline">
      {fact.text}
    </Link>
  );
}
