import { Link } from "react-router-dom";

import { SettingsGroup } from "@/components/settings/settings-row";
import { useSettingSearchMatch } from "@/components/settings/settings-search";
import {
  EXTENSION_NAMES,
  useIntegrations,
  type IntegrationStatus,
  type VendorFact,
} from "@/integrations";
import { cn } from "@/lib/utils";

/**
 * The one screen allowed to name an extension.
 *
 * Everywhere else asks for a capability. Here the reader is asking a
 * different question — what does this cluster have, and is it working —
 * and the answer is a list of names with what each one is currently doing
 * underneath it.
 *
 * No Connect button and no fields, because there is nothing to connect or
 * fill in: an in-cluster extension is detected, not configured. Its CRDs
 * exist in this cluster's API server or they do not. And no install
 * button on the absent ones either — the app does not put things into
 * anybody's cluster, so a dimmed row saying what it *would* give is the
 * whole of what absence is allowed to say.
 *
 * A status list, not a dashboard. No charts, no per-object tables, no
 * editing: every fact ends in a link to the objects that own it, and the
 * reader continues in the part of the app built for them.
 */
export function IntegrationsSettings({ active = true }: { active?: boolean }) {
  const { statuses, isPending, error } = useIntegrations({ facts: active });

  if (error) {
    return (
      <div className="max-w-[64ch] py-8">
        <h3 className="text-xs font-medium text-fg">
          Could not read this cluster&rsquo;s CRDs
        </h3>
        <p className="mt-1.5 text-xs text-fg-mut">
          Every extension here is detected by asking the API server for the
          custom resource definitions it installs, and that request failed — so
          this list would be a guess rather than an answer.
        </p>
        <p className="mt-2 text-[11px] text-fg-fnt">{error.message}</p>
      </div>
    );
  }

  const installed = statuses.filter((status) => status.installed);
  if (!isPending && installed.length === 0) {
    return <NothingInstalled />;
  }

  return (
    <SettingsGroup>
      {statuses.map((status) => (
        <ExtensionRow
          key={status.vendor.id}
          status={status}
          isPending={isPending}
        />
      ))}
    </SettingsGroup>
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
  const visible = useSettingSearchMatch(
    "integrations extensions",
    EXTENSION_NAMES.join(" ")
  );
  return (
    <div className={cn("max-w-[64ch] py-8", !visible && "hidden")}>
      <h3 className="text-xs font-medium text-fg">
        Nothing installed that this app knows how to use
      </h3>
      <p className="mt-1.5 text-xs text-fg-mut">
        The cluster works exactly as it does now — every extension here is
        optional, and none of them is needed to read a pod.
      </p>
      <p className="mt-2 text-[11px] text-fg-fnt">
        Looked for {sentenceList(EXTENSION_NAMES)} by asking the API server for
        their CRDs. None of them are in this cluster.
      </p>
    </div>
  );
}

/** "a, b and c" — the list reads as a sentence, because it is one. */
function sentenceList(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ExtensionRow({
  status,
  isPending,
}: {
  status: IntegrationStatus;
  isPending: boolean;
}) {
  const { vendor, extension, installed, version, facts } = status;
  const Icon = extension.icon;
  const visible = useSettingSearchMatch(vendor.name, extension.gives);

  return (
    <div
      className={cn(
        "grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-hair py-2.5",
        // Dimmed rather than hidden: the absent ones are the list of what
        // this cluster could gain, and that is worth reading once.
        !installed && !isPending && "opacity-55",
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
          {installed ? "Gives " : "Would give "}
          <span className="text-fg-mut">{extension.gives}</span>
        </div>
        {installed && <Facts facts={facts} />}
      </div>
      <span
        className={cn(
          "whitespace-nowrap text-[11px]",
          isPending ? "text-fg-fnt" : installed ? "text-ok" : "text-fg-fnt"
        )}
      >
        {isPending ? "looking…" : installed ? "detected" : "not installed"}
      </span>
    </div>
  );
}

/**
 * What it is doing for you, as the second half of the sentence "gives"
 * starts.
 *
 * A count is quiet and a problem is coloured — the same discipline the
 * condition rows and the tab marks follow. "7 certificates" is inventory;
 * "1 renewal failing" is why you came.
 */
function Facts({ facts }: { facts: IntegrationStatus["facts"] }) {
  if (facts.state === "none") return null;
  if (facts.state === "loading") {
    return <p className="mt-1.5 text-[11px] text-fg-fnt">reading…</p>;
  }
  if (facts.state === "failed") {
    return (
      <p className="mt-1.5 text-[11px] text-warn">
        It is installed, but its objects could not be read — {facts.reason}
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
