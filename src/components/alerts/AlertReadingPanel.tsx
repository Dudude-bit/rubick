import { useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { isRoutableKind } from "@/components/resources/ResourceRef";
import { formatAge } from "@/lib/utils";
import {
  clusterChoices,
  type AlertReading,
  type Provenance,
} from "@/lib/alerts";
import { useClusterStore } from "@/stores/clusterStore";
import { useT, type T } from "@/i18n/useT";

/** How far either side of the alert the window reaches. */
export const ALERT_WINDOW_MS = 20 * 60_000;

export interface AlertTarget {
  context: string;
  path: string;
  namespace: string | null;
  kind: string;
  name: string;
}

/**
 * What the app read out of a pasted alert, before anything opens.
 *
 * Every recognised value names the line it came from, because a wrong read is
 * only cheap while it is still on this screen. Nothing here is resolved
 * against the cluster: the alert is a claim somebody's rule made at a moment
 * that has passed, and this panel is about what the text says, not about
 * what is true now.
 */
export function AlertReadingPanel({
  reading,
  onOpen,
}: {
  reading: AlertReading;
  onOpen: (target: AlertTarget) => void;
}) {
  const t = useT();
  const contexts = useClusterStore((s) => s.contexts);
  const currentContext = useClusterStore((s) => s.currentContext);
  const names = useMemo(() => contexts.map((c) => c.name), [contexts]);

  const cluster = useMemo(
    () => clusterChoices(reading, names),
    [reading, names]
  );
  const [pickedContext, setPickedContext] = useState<string | null>(null);
  const [pickedObject, setPickedObject] = useState(0);
  const [pickedNamespace, setPickedNamespace] = useState<string | null>(null);

  const context = cluster.settled ?? pickedContext;
  const object = reading.objects[pickedObject] ?? null;
  const namespace = reading.namespace?.value ?? pickedNamespace;

  const path = useMemo(() => {
    if (!object) return null;
    if (!isRoutableKind(object.kind, namespace)) return null;
    const url = getResourceDetailUrl(object.kind, object.name, namespace);
    if (reading.firedAt === null) return url;
    return `${url}?since=${new Date(reading.firedAt.value).toISOString()}`;
  }, [object, namespace, reading.firedAt]);

  const namespacePath =
    namespace !== null && namespace !== undefined
      ? `/namespaces/${namespace}`
      : null;

  const open = (target: string | null, kind: string, name: string) => {
    if (target === null || context === null) return;
    onOpen({
      context,
      path: target,
      namespace: namespace ?? null,
      kind,
      name,
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-fg-fnt">
          {t("alerts", "readAsAnAlert")}
        </span>
        <span className="ml-auto rounded border border-hair px-1.5 text-[10px] uppercase tracking-wide text-fg-fnt">
          {t("alerts", FORMAT_KEY[reading.format])}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="truncate font-mono text-[13px] font-medium text-fg">
          {reading.alertName ?? t("alerts", "unnamedAlert")}
        </span>
        {reading.severity ? (
          <span className="flex-none rounded border border-err/45 px-1 text-[10px] uppercase tracking-wide text-err">
            {reading.severity}
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
        <dt className={context === null ? "text-warn" : "text-fg-fnt"}>
          {t("alerts", "cluster")}
        </dt>
        <dd className="min-w-0">
          {context !== null && cluster.settled !== null ? (
            <Value
              value={context}
              from={{ how: "key", key: "cluster" }}
              t={t}
            />
          ) : (
            <Choices
              note={t(
                "alerts",
                reading.cluster === null ? "noClusterNamed" : "clusterNotYours"
              )}
              items={cluster.choices.map((choice) => ({
                key: choice.context,
                label: choice.context,
                why: t("alerts", WHY_KEY[choice.why]),
                mine: choice.context === currentContext,
              }))}
              picked={pickedContext}
              onPick={setPickedContext}
            />
          )}
        </dd>

        <dt
          className={
            namespace === null || namespace === undefined
              ? "text-warn"
              : "text-fg-fnt"
          }
        >
          {t("alerts", "namespace")}
        </dt>
        <dd className="min-w-0">
          {reading.namespace ? (
            <Value
              value={reading.namespace.value}
              from={reading.namespace.from}
              t={t}
            />
          ) : reading.unkeyed.length > 0 ? (
            <Choices
              note={t("alerts", "whichIsTheNamespace")}
              items={reading.unkeyed.map((value) => ({
                key: value,
                label: value,
                why: t("alerts", "noKeysToReadItBy"),
                mine: false,
              }))}
              picked={pickedNamespace}
              onPick={setPickedNamespace}
            />
          ) : (
            <span className="text-warn">{t("alerts", "notNamed")}</span>
          )}
        </dd>

        <dt
          className={reading.objects.length === 0 ? "text-warn" : "text-fg-fnt"}
        >
          {t("alerts", "object")}
        </dt>
        <dd className="min-w-0">
          {reading.objects.length === 0 ? (
            <span>
              <span className="text-warn">{t("alerts", "notNamed")}</span>{" "}
              <span className="text-fg-fnt">
                {t("alerts", "nothingSaysAKind")}
              </span>
            </span>
          ) : reading.objects.length === 1 ? (
            <Value
              value={reading.objects[0].name}
              kind={reading.objects[0].kind}
              from={reading.objects[0].from}
              t={t}
            />
          ) : (
            <Choices
              note={t("alerts", "namesSeveral", {
                n: reading.objects.length,
              })}
              items={reading.objects.map((entry, index) => ({
                key: `${entry.kind}/${entry.name}`,
                label: entry.name,
                kind: entry.kind,
                why: t(
                  "alerts",
                  entry.role === "subject" ? "theSubject" : "alsoNamed"
                ),
                mine: false,
                index,
              }))}
              picked={
                reading.objects[pickedObject]
                  ? `${reading.objects[pickedObject].kind}/${reading.objects[pickedObject].name}`
                  : null
              }
              onPick={(_key, index) => setPickedObject(index ?? 0)}
            />
          )}
        </dd>

        {reading.container ? (
          <>
            <dt className="text-fg-fnt">{t("alerts", "container")}</dt>
            <dd className="min-w-0">
              <Value
                value={reading.container.value}
                from={reading.container.from}
                t={t}
              />
            </dd>
          </>
        ) : null}

        <dt className="text-fg-fnt">{t("alerts", "since")}</dt>
        <dd className="min-w-0">
          {reading.firedAt === null ? (
            <span className="text-fg-fnt">{t("alerts", "notDated")}</span>
          ) : (
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-fg">
                {new Date(reading.firedAt.value).toLocaleString()}
              </span>
              <From from={reading.firedAt.from} t={t} />
              <span className="text-fg-fnt">
                {formatAge(new Date(reading.firedAt.value).toISOString(), t)}
              </span>
            </span>
          )}
        </dd>

        {reading.ignored.length > 0 ? (
          <>
            <dt className="text-fg-fnt">{t("alerts", "ignored")}</dt>
            <dd className="min-w-0 truncate">
              <span className="font-mono text-fg-fnt">
                {reading.ignored.join(", ")}
              </span>{" "}
              <span className="text-fg-fnt">
                {t("alerts", "namesTheMonitoring")}
              </span>
            </dd>
          </>
        ) : null}
      </dl>

      {reading.claim ? (
        <p className="border-l-2 border-hair py-1 pl-2.5 text-[11.5px] text-fg-mid">
          {reading.claim}
          <span className="mt-1 block text-[10.5px] text-fg-fnt">
            {t("alerts", "theAlertsWords")}
          </span>
        </p>
      ) : null}

      {reading.objects.some((entry) => entry.from.how === "shape") ? (
        <p className="border-l-2 border-warn/50 py-1 pl-2.5 text-[11.5px] text-fg-mut">
          {t("alerts", "guessedFromShape")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          autoFocus
          disabled={path === null || context === null}
          onClick={() => object && open(path, object.kind, object.name)}
          className="flex items-center gap-1.5 rounded border border-info/40 bg-info/12 px-2.5 py-1 text-[11.5px] text-info disabled:pointer-events-none disabled:opacity-40"
        >
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
          {object
            ? t("alerts", "openThis", { kind: object.kind, name: object.name })
            : t("alerts", "openIt")}
        </button>
        {namespacePath && context !== null ? (
          <button
            type="button"
            onClick={() =>
              open(namespacePath, "Namespace", namespace as string)
            }
            className="text-[11px] text-fg-fnt hover:text-fg-mut"
          >
            {t("alerts", "orTheNamespace", { namespace: namespace as string })}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const FORMAT_KEY = {
  alertmanagerText: "formatAlertmanager",
  alertmanagerSubject: "formatSubject",
  grafana: "formatGrafana",
  datadog: "formatDatadog",
} as const;

const WHY_KEY = {
  namedExactly: "whyNamedExactly",
  nameAppearsInIt: "whyNameAppears",
  inTheSourceHost: "whyInSourceHost",
  yoursToPick: "whyYours",
} as const;

function Value({
  value,
  kind,
  from,
  t,
}: {
  value: string;
  kind?: string;
  from: Provenance;
  t: T;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {kind ? <span className="font-mono text-fg-mut">{kind}</span> : null}
      <span className="truncate font-mono text-fg">{value}</span>
      <From from={from} t={t} />
    </span>
  );
}

/**
 * Where the value came from, in the words of the text it came from.
 *
 * A field read off `namespace =` and one recognised because it looked like a
 * pod name are not the same claim, and drawing them alike is how a person
 * stops checking either.
 */
function From({ from, t }: { from: Provenance; t: T }) {
  if (from.how === "key") {
    return (
      <span className="font-mono text-[10.5px] text-fg-fnt">{`${from.key} =`}</span>
    );
  }
  if (from.how === "alertName") {
    return (
      <span className="text-[10.5px] text-fg-fnt">
        {t("alerts", "fromTheAlertName")}
      </span>
    );
  }
  if (from.how === "sourceHost") {
    return (
      <span className="text-[10.5px] text-fg-fnt">
        {t("alerts", "fromTheSourceHost")}
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-warn">{t("alerts", "byShape")}</span>
  );
}

interface ChoiceItem {
  key: string;
  label: string;
  kind?: string;
  why: string;
  mine: boolean;
  index?: number;
}

/** A list the arrow keys walk, because this is a palette and hands are on the keyboard. */
function Choices({
  note,
  items,
  picked,
  onPick,
}: {
  note: string;
  items: ChoiceItem[];
  picked: string | null;
  onPick: (key: string, index?: number) => void;
}) {
  const group = useRef<HTMLDivElement>(null);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[10.5px] text-fg-fnt">{note}</span>
      <div
        ref={group}
        role="radiogroup"
        className="flex flex-col gap-0.5"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          event.stopPropagation();
          const buttons = [
            ...(group.current?.querySelectorAll("button") ?? []),
          ] as HTMLButtonElement[];
          const at = buttons.indexOf(
            document.activeElement as HTMLButtonElement
          );
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = buttons[(at + step + buttons.length) % buttons.length];
          next?.focus();
        }}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={item.key === picked}
            onClick={() => onPick(item.key, item.index)}
            onFocus={() => onPick(item.key, item.index)}
            className={`flex min-w-0 items-baseline gap-2 rounded px-1.5 py-0.5 text-left ${
              item.key === picked ? "bg-hover" : ""
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-none translate-y-[-1px] rounded-full ${
                item.key === picked ? "bg-info" : "bg-fg-fnt"
              }`}
            />
            {item.kind ? (
              <span className="font-mono text-fg-mut">{item.kind}</span>
            ) : null}
            <span className="truncate font-mono text-fg">{item.label}</span>
            <span className="ml-auto flex-none pl-2 text-[10.5px] text-fg-fnt">
              {item.why}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
