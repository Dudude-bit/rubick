import { useMemo } from "react";
import { ExternalLink, PinOff } from "lucide-react";

import { ObjectLink } from "@/components/resources/ResourceRef";
import { Journal } from "@/components/changes/ChangesTimeline";
import { useConnections } from "@/hooks/useConnections";
import { trafficChains, unreadWhy } from "@/lib/connections";
import { formatAge } from "@/lib/utils";
import {
  changesFor,
  entryPointsOf,
  openQuestionsOf,
  stateOf,
  waitingFor,
  type ServicePin,
  type ServiceState,
} from "@/lib/my-services";
import { ASK_SHORT } from "@/lib/tell-me-when";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { useT, type T } from "@/i18n/useT";

/** How many ways in one card shows before it stops listing them. */
const WAYS_SHOWN = 3;

/**
 * One pinned service, answering the five things a person would otherwise
 * open four screens for: what state it is in, how traffic reaches it, what
 * changed, what this app is waiting on, and what nobody looked at.
 *
 * The neighbourhood read is the query the object's own page makes, under the
 * same key, so opening a card's service costs no request at all.
 */
export function ServiceCard({
  pin,
  onUnpin,
}: {
  pin: ServicePin;
  onUnpin: () => void;
}) {
  const t = useT();
  const connections = useConnections(pin.kind, pin.name, pin.namespace);
  const entries = useChangeJournalStore((s) => s.entries);
  const watches = useTellMeWhenStore((s) => s.watches);

  const state = stateOf(
    connections.data,
    connections.error ? { message: connections.error.message } : null
  );
  const chains = useMemo(
    () => (connections.data ? trafficChains(connections.data, t) : []),
    [connections.data, t]
  );
  const ways = entryPointsOf(connections.data, chains);
  const unread = openQuestionsOf(connections.data);
  const changes = useMemo(() => changesFor(entries, pin), [entries, pin]);
  const waiting = useMemo(() => waitingFor(watches, pin), [watches, pin]);
  const latest = changes[0] ?? null;

  return (
    <div
      className="flex flex-col rounded border border-hair px-3 py-2.5"
      data-testid="service-card"
    >
      <div className="flex items-baseline gap-2">
        <ObjectLink
          kind={pin.kind}
          name={pin.name}
          namespace={pin.namespace}
          className="truncate text-[13px] font-medium text-fg hover:underline"
        >
          {pin.name}
        </ObjectLink>
        <span className="truncate font-mono text-[11px] text-fg-fnt">
          {pin.namespace}
        </span>
        <StateWords state={state} t={t} />
        <button
          type="button"
          aria-label={t("services", "unpin")}
          onClick={onUnpin}
          className="ml-auto rounded p-0.5 text-fg-fnt hover:bg-hover hover:text-fg-mut"
        >
          <PinOff aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-fg-fnt">{t("services", "wayIn")}</dt>
        <dd className="min-w-0 text-fg-mut">
          {!ways.known ? (
            <span className="text-fg-fnt">{t("services", "notReadYet")}</span>
          ) : ways.entries.length === 0 ? (
            <span>{t("services", "nothingPublishes")}</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {ways.entries.slice(0, WAYS_SHOWN).map((way) => (
                <li
                  key={way.key}
                  className="flex min-w-0 items-baseline gap-1.5"
                >
                  {way.url ? (
                    <ExternalLink
                      aria-hidden="true"
                      className="h-3 w-3 flex-none translate-y-px text-fg-fnt"
                    />
                  ) : null}
                  <span className="truncate font-mono text-fg">
                    {way.url ?? way.label}
                  </span>
                  {way.detail ? (
                    <span className="truncate text-fg-fnt">{way.detail}</span>
                  ) : null}
                  {way.servingKnown && !way.serving ? (
                    <span className="flex-none text-warn">
                      {t("services", "nothingBehind")}
                    </span>
                  ) : null}
                </li>
              ))}
              {ways.entries.length > WAYS_SHOWN ? (
                <li className="text-fg-fnt">
                  {t("services", "moreWays", {
                    n: ways.entries.length - WAYS_SHOWN,
                  })}
                </li>
              ) : null}
            </ul>
          )}
        </dd>

        <dt className="text-fg-fnt">{t("services", "lastChange")}</dt>
        <dd className="min-w-0 truncate text-fg-mut">
          {latest === null ? (
            <span className="text-fg-fnt">{t("services", "nothingSeen")}</span>
          ) : (
            <>
              <span className="font-mono">
                <Journal item={latest} />
              </span>
              <span className="ml-1 text-fg-fnt">
                {formatAge(new Date(latest.at).toISOString(), t)}
              </span>
            </>
          )}
        </dd>

        {waiting.length > 0 ? (
          <>
            <dt className="text-fg-fnt">{t("services", "waitingOn")}</dt>
            <dd className="min-w-0 truncate text-info">
              {waiting
                .map((watch) => t("tell", ASK_SHORT[watch.ask]))
                .join(" · ")}
            </dd>
          </>
        ) : null}

        {unread.length > 0 ? (
          <>
            <dt className="text-warn">{t("services", "notLookedAt")}</dt>
            <dd
              className="min-w-0 truncate text-fg-fnt"
              title={unread.map((kind) => unreadWhy(kind.why, t)).join("\n")}
            >
              {unread.map((kind) => kind.kind).join(", ")}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * The state, and the two answers a count of replicas cannot carry.
 *
 * A service somebody deleted and one this token may not read both arrive as
 * no numbers, and drawing either as "0 ready" tells a person their service is
 * down when it is not there, or when nobody looked.
 */
function StateWords({ state, t }: { state: ServiceState; t: T }) {
  if (state.state === "gone") {
    return (
      <span className="flex-none font-mono text-[11px] text-err">
        {t("services", "gone")}
      </span>
    );
  }
  if (state.state === "unread") {
    return (
      <span
        className="flex-none text-[11px] text-fg-fnt"
        title={state.why || undefined}
      >
        {t("services", "couldNotRead")}
      </span>
    );
  }
  return (
    <span
      className={`flex-none font-mono text-[11px] ${
        state.state === "ready" ? "text-ok" : "text-warn"
      }`}
    >
      {t("services", "readyOf", { ready: state.ready, total: state.total })}
    </span>
  );
}
