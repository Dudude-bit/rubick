import { useState, type CSSProperties } from "react";
import type { IconType } from "react-icons";
import {
  LuBox,
  LuCopy,
  LuDatabase,
  LuFileText,
  LuGlobe,
  LuHardDrive,
  LuHardDriveDownload,
  LuKeyRound,
  LuLayers,
  LuNetwork,
  LuServer,
} from "react-icons/lu";
import { Reveal } from "./motion/reveal";

export type KindStyle = { Icon: IconType; hue?: number; color?: string };

// The app's kind glyphs and hues: a family per sidebar category, siblings
// spread inside it, dark theme at 38% saturation and 70% lightness.
export const CORE_KINDS: Record<string, KindStyle> = {
  Pod: { Icon: LuBox, hue: 246 },
  Deployment: { Icon: LuLayers, hue: 252 },
  ReplicaSet: { Icon: LuCopy, hue: 258 },
  ConfigMap: { Icon: LuFileText, hue: 18 },
  Secret: { Icon: LuKeyRound, hue: 54 },
  PersistentVolumeClaim: { Icon: LuHardDriveDownload, hue: 308 },
  PersistentVolume: { Icon: LuHardDrive, hue: 326 },
  StorageClass: { Icon: LuDatabase, hue: 344 },
  Node: { Icon: LuServer, hue: 210 },
  Ingress: { Icon: LuGlobe, hue: 174 },
  Service: { Icon: LuNetwork, hue: 170 },
};

export type Tone = "bad" | "ok" | "warn";

export type Ref = {
  kind: string;
  name: string;
  ns?: string;
  note: string;
  tone?: Tone;
};

export type Group = {
  title: string;
  note?: string;
  rows: Ref[];
  empty?: { label: string; note: string };
};

export type Subject = {
  kind: string;
  name: string;
  ns?: string;
  facts: string;
  missing?: true;
  status?: { label: string; tone: Tone };
  details?: [string, string][];
  chain?: Ref[];
  chainNote?: string;
  groups: Group[];
};

export const keyOf = (r: { kind: string; name: string; ns?: string }) =>
  `${r.kind}/${r.ns ?? ""}/${r.name}`;

const NAME: Record<Tone | "none", string> = {
  bad: "text-red-300",
  ok: "text-green-300",
  warn: "text-amber-200",
  none: "text-neutral-200",
};

const STATUS: Record<Tone, [string, string]> = {
  bad: ["border-red-400/70 text-red-300", "bg-red-400"],
  ok: ["border-green-400/60 text-green-300", "bg-green-400"],
  warn: ["border-amber-400/70 text-amber-200", "bg-amber-400"],
};

function tint(style: KindStyle): CSSProperties {
  return { color: style.color ?? `hsl(${style.hue ?? 210} 38% 70%)` };
}

export function KindMark({
  kind,
  kinds,
}: {
  kind: string;
  kinds: Record<string, KindStyle>;
}) {
  const style = kinds[kind] ?? { Icon: LuBox, hue: 210 };
  return (
    <span className="inline-flex items-center gap-1.5" style={tint(style)}>
      <style.Icon aria-hidden className="size-3.5 shrink-0" />
      {kind}
    </span>
  );
}

function RefRow({
  r,
  kinds,
  onOpen,
  current,
  known,
}: {
  r: Ref;
  kinds: Record<string, KindStyle>;
  onOpen: (key: string) => void;
  current: string;
  known: Set<string>;
}) {
  const key = keyOf(r);
  const target = known.has(key) && key !== current;
  const body = (
    <>
      <KindMark kind={r.kind} kinds={kinds} />
      <span className={NAME[r.tone ?? "none"]}>{r.name}</span>
      {r.ns ? <span className="text-neutral-500">{r.ns}</span> : null}
      {r.note ? <span className="text-neutral-400">{r.note}</span> : null}
    </>
  );
  return target ? (
    <button
      type="button"
      onClick={() => onOpen(key)}
      className="group -mx-2 flex min-h-9 flex-wrap items-center gap-x-2 rounded-md px-2 text-left font-mono text-[13px] transition-colors hover:bg-neutral-800/70 focus-visible:bg-neutral-800/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {body}
      <span
        aria-hidden
        className="text-neutral-600 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
      >
        ›
      </span>
    </button>
  ) : (
    <span className="flex min-h-9 flex-wrap items-center gap-x-2 font-mono text-[13px]">
      {body}
    </span>
  );
}

export function Peek({
  subjects,
  kinds,
  root,
  className = "",
}: {
  subjects: Subject[];
  kinds: Record<string, KindStyle>;
  root: string;
  className?: string;
}) {
  const byKey = new Map(subjects.map((s) => [keyOf(s), s]));
  const known = new Set(byKey.keys());
  const [trail, setTrail] = useState<string[]>([root]);
  const current = trail[trail.length - 1] ?? root;
  const subject = byKey.get(current) ?? byKey.get(root)!;
  const open = (key: string) => setTrail((t) => [...t, key]);
  const back = () => setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));
  const status = subject.status ? STATUS[subject.status.tone] : null;

  return (
    <Reveal
      settle
      className={`overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 px-5 py-4 font-mono text-sm">
        {trail.length > 1 ? (
          <button
            type="button"
            onClick={back}
            aria-label="Back"
            className="-ml-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-accent"
          >
            ‹
          </button>
        ) : null}
        <KindMark kind={subject.kind} kinds={kinds} />
        <span
          className={
            subject.missing
              ? "rounded-md border border-dashed border-neutral-600 px-1.5 text-neutral-300"
              : "text-neutral-100"
          }
        >
          {subject.name}
        </span>
        {subject.ns ? (
          <span className="text-neutral-500">{subject.ns}</span>
        ) : null}
        {subject.status && status ? (
          <span
            className={`ml-auto inline-flex items-center gap-2 rounded-md border px-2 py-0.5 text-[13px] ${status[0]}`}
          >
            <span className={`size-1.5 rounded-full ${status[1]}`} />
            {subject.status.label}
          </span>
        ) : null}
      </div>
      <div key={current} className="flex flex-col gap-6 px-5 py-5">
        <p className="font-mono text-[13px] text-neutral-400">
          {subject.facts}
        </p>
        {subject.details ? (
          <Reveal delay={40}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 font-mono text-[13px]">
              {subject.details.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-neutral-500">{k}</dt>
                  <dd className="min-w-0 break-words text-neutral-200">{v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        ) : null}
        {subject.chain ? (
          <Reveal delay={60} className="relative pl-4">
            <span
              aria-hidden
              className="rule-y absolute inset-y-0 left-0 w-px bg-neutral-700"
            />
            <h3 className="font-mono text-sm font-normal text-neutral-100">
              Traffic chain
              <span className="text-neutral-400">
                {" "}
                · on the Overview, drawn from the entry point down
              </span>
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
              {subject.chain.map((r) => (
                <span
                  key={keyOf(r)}
                  className="inline-flex items-center gap-x-1"
                >
                  <RefRow
                    r={r}
                    kinds={kinds}
                    onOpen={open}
                    current={current}
                    known={known}
                  />
                </span>
              ))}
            </div>
            {subject.chainNote ? (
              <p className="mt-2 font-mono text-[12px] text-neutral-500">
                {subject.chainNote}
              </p>
            ) : null}
          </Reveal>
        ) : null}
        {subject.groups.map((g, i) => (
          <Reveal key={g.title} delay={120 + i * 110} className="relative pl-4">
            <span
              aria-hidden
              className="rule-y absolute inset-y-0 left-0 w-px bg-neutral-700"
            />
            <h3 className="font-mono text-sm font-normal text-neutral-100">
              {g.title}
              {g.note ? (
                <span className="text-neutral-400"> · {g.note}</span>
              ) : null}
            </h3>
            {g.rows.length > 0 ? (
              <ul className="mt-1 flex flex-col">
                {g.rows.map((r) => (
                  <li key={keyOf(r)}>
                    <RefRow
                      r={r}
                      kinds={kinds}
                      onOpen={open}
                      current={current}
                      known={known}
                    />
                  </li>
                ))}
              </ul>
            ) : g.empty ? (
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
                <span className="rounded-md border border-dashed border-neutral-600 px-2 py-0.5 text-neutral-300">
                  {g.empty.label}
                </span>
                <span className="text-neutral-400">{g.empty.note}</span>
              </p>
            ) : null}
          </Reveal>
        ))}
      </div>
    </Reveal>
  );
}
