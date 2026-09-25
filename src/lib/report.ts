/**
 * What the app shows, as one file somebody else can open: one object and the
 * evidence about it, or one screen as the sender saw it.
 *
 * Written for the colleague the link is sent to: on a phone, in a chat, with
 * no cluster access and often no Rubick. The first screen answers "is it
 * broken and since when"; the sections below are the evidence, drawn with the
 * app's own icons, kind hues and identity colours so an object reads the same
 * here as on the sender's screen. One self-contained HTML file with a
 * `rubick://` link back to the same place.
 *
 * **No value of a Secret can reach it.** Nothing here accepts one: a Secret is
 * a name and its key names, and the log lines are redacted on the way in.
 */

import type { LogLevel } from "@/generated/types";
import type { StatusRole } from "./status-role";
import { redact } from "./hints";

export type ReportTone = "ok" | "warn" | "err";

/** The sender's Settings › Display › resource colouring, carried with the file. */
export type ReportColouring = "full" | "minimal" | "off";

/** An object as the app draws it: kind icon in the kind's hue, the name's tail in its identity hue. */
export interface ReportRef {
  kind: string;
  namespace: string | null;
  stem: string;
  tail: string;
  /** Inline SVG markup of the kind's icon. */
  icon: string;
  kindHue: number;
  identHue: number;
}

/** One cell's worth: words, a status, or an object. */
export interface ReportValue {
  text: string;
  /** ISO time, drawn for a person; `text` is ignored. */
  at?: string;
  role?: StatusRole;
  ref?: ReportRef;
  mono?: boolean;
  quiet?: boolean;
}

export interface ReportStat {
  label: string;
  value: string;
  role?: StatusRole;
  ref?: ReportRef;
  note?: string | null;
}

export interface ReportContainer {
  name: string;
  repository: string;
  tag: string | null;
  state: string;
  role: StatusRole;
  /** Already worded: restarts, the last exit. */
  notes: string[];
  init: boolean;
}

export interface ReportHop {
  ref: ReportRef | null;
  /** Words where the hop is not an object: an endpoint count, a stop. */
  text: string | null;
  detail: string | null;
  tone: ReportTone | null;
  self: boolean;
}

/** One way traffic reaches the subject, in the order it travels. */
export interface ReportPath {
  hops: ReportHop[];
  broken: boolean;
}

export interface ReportLink {
  label: string;
  ref: ReportRef | null;
  /** The far end when it is not an object in the cluster. */
  name: string | null;
  detail: string;
  /** `not checked` or `does not exist`, where existence bears on the group's claim. */
  existence: string | null;
  missing: boolean;
}

/** A group of the Connections tab, in its own words. */
export interface ReportGroup {
  title: string;
  caption: string | null;
  rows: ReportLink[];
}

/**
 * `text` carries its values between {@link VALUE_OPEN} and
 * {@link VALUE_CLOSE}, so a translated sentence keeps its own word order and
 * the file can still draw the values as values.
 */
export interface ReportChange {
  /** ISO time, or `null` for a sentence about the journal itself. */
  at: string | null;
  ref: ReportRef | null;
  parts: { text: string; quiet: boolean }[];
}

export const VALUE_OPEN = "\u0001";
export const VALUE_CLOSE = "\u0002";

export interface ReportLogLine {
  text: string;
  level: LogLevel | null;
}

export interface ReportLog {
  /** `pod/container`, so a reader knows which stream a line came from. */
  source: string;
  lines: ReportLogLine[];
  /** The run before the current one. */
  previous: boolean;
  /** Where the lines came from and how many, already worded. */
  caption: string | null;
}

export interface ReportConditionRow {
  type: string;
  status: string;
  role: StatusRole;
  reason: string | null;
  message: string | null;
  /** ISO time of the last transition. */
  since: string | null;
}

export interface ReportEventRow {
  at: string | null;
  role: StatusRole;
  reason: string;
  message: string;
  count: number;
  ref?: ReportRef;
}

export interface ReportFinding {
  title: string;
  detail: string | null;
  role: StatusRole;
  ref?: ReportRef;
}

export type ReportSectionBody =
  | { type: "facts"; rows: { label: string; values: ReportValue[] }[] }
  | {
      type: "table";
      columns: string[];
      rows: { cells: ReportValue[] }[];
      /** Worded: what was left out, when not every row fits. */
      more: string | null;
    }
  | { type: "conditions"; rows: ReportConditionRow[] }
  | { type: "events"; rows: ReportEventRow[] }
  | { type: "findings"; items: ReportFinding[] }
  | { type: "containers"; containers: ReportContainer[] }
  | { type: "changes"; changes: ReportChange[] }
  | { type: "traffic"; paths: ReportPath[]; note: string | null }
  | { type: "connections"; groups: ReportGroup[] }
  | { type: "logs"; logs: ReportLog[]; absent: string | null }
  | { type: "text"; text: string; role?: StatusRole };

export interface ReportSection {
  id: string;
  title: string;
  /** Inline SVG markup. */
  icon: string;
  count?: number | null;
  /**
   * Why the section could not be filled, when nobody could look. An empty
   * list and a refused read are opposite answers.
   */
  unread?: string | null;
  body: ReportSectionBody;
}

export interface Report {
  /** What the file is about: one object, or one screen of the app. */
  subject: {
    kind: string;
    name: string;
    namespace: string | null;
    context: string;
  };
  hero: {
    /** The object, drawn as the app draws it; `null` for a screen. */
    ref: ReportRef | null;
    /** The screen's own title, when there is no object. */
    title: string;
    icon: string;
    hue: number | null;
  };
  kicker: string;
  capturedAt: string;
  appVersion: string;
  colouring: ReportColouring;
  status: { text: string; role: StatusRole } | null;
  chips: { icon: string; text: string }[];
  stats: ReportStat[];
  /** The app's own sentence, already worded and already hedged. */
  verdict: string | null;
  sections: ReportSection[];
  /** Everything asked for and refused, or never asked. */
  notRead: string[];
  /** `rubick://open/...`, so the reader with the app lands where this was made. */
  link: string;
  words: ReportWords;
  icons: ReportIcons;
}

/** Inline SVG markup for the glyphs the frame draws around the sections. */
export interface ReportIcons {
  roles: Record<StatusRole, string>;
  verdict: string;
  notRead: string;
  open: string;
  shield: string;
}

/** Every string the frame shows, resolved before it is written. */
export interface ReportWords {
  /** The language the strings are in, as the file's `lang`. */
  lang: string;
  captured: string;
  openInRubick: string;
  linkFallback: string;
  verdict: string;
  notRead: string;
  notReadCount: string;
  allRead: string;
  nothingHere: string;
  previousRun: string;
  init: string;
  madeBy: string;
  noSecrets: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The app's own role tokens (`src/index.css`), both themes, so a green here
 * is the green the sender saw. The reader's system picks the theme.
 */
const STYLE = `
:root { color-scheme: light dark;
  --canvas:hsl(40 30% 98%); --raise:hsl(0 0% 100%); --hair:hsl(34 20% 30% / .14);
  --sel:hsl(34 25% 20% / .07); --fg:hsl(32 16% 11%); --mid:hsl(32 10% 26%);
  --mut:hsl(32 8% 37%); --fnt:hsl(32 8% 49%); --ok:hsl(148 55% 29%); --warn:hsl(30 80% 37%);
  --err:hsl(4 66% 45%); --info:hsl(210 67% 40%); --kind-s:42%; --kind-l:38%;
  --ident-s:58%; --ident-l:30%; --code:hsl(40 20% 95%); }
@media (prefers-color-scheme: dark) { :root {
  --canvas:hsl(220 8% 13%); --raise:hsl(220 7% 16.5%); --hair:hsl(0 0% 100% / .09);
  --sel:hsl(0 0% 100% / .06); --fg:hsl(220 6% 93%); --mid:hsl(212 7% 79%);
  --mut:hsl(213 6% 65%); --fnt:hsl(213 6% 51%); --ok:hsl(152 44% 49%); --warn:hsl(44 82% 48%);
  --err:hsl(358 81% 68%); --info:hsl(212 66% 58%); --kind-s:38%; --kind-l:70%;
  --ident-s:52%; --ident-l:66%; --code:hsl(220 9% 10%); } }
* { box-sizing:border-box; }
body { margin:0; background:var(--canvas); color:var(--fg);
  font:14px/1.55 Inter,"Inter Variable",ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased; overflow-wrap:anywhere; }
main { max-width:860px; margin:0 auto; padding:28px 20px 56px; }
.mono, code, pre, time, .name { font-family:"JetBrains Mono","JetBrains Mono Variable",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
svg { width:14px; height:14px; flex:none; vertical-align:-2px; }
.top { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:4px 12px;
  color:var(--fnt); font-size:12px; margin:0 0 18px; }
.top b { color:var(--mid); font-weight:600; letter-spacing:.02em; }
.hero { display:flex; gap:14px; align-items:flex-start; }
.glyph { display:grid; place-items:center; width:44px; height:44px; border-radius:12px;
  background:var(--raise); border:1px solid var(--hair); flex:none; }
.glyph svg { width:22px; height:22px; }
h1 { font-size:20px; line-height:1.3; margin:2px 0 8px; font-weight:600; }
.chips { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.chip { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:999px;
  border:1px solid var(--hair); color:var(--mut); font-size:12px; background:var(--raise); }
.chip svg { width:12px; height:12px; }
.role { display:inline-flex; align-items:center; gap:4px; font-family:"JetBrains Mono",ui-monospace,monospace;
  font-size:12px; font-weight:500; }
.role.ok { color:var(--ok); } .role.pending, .role.neutral { color:var(--mut); }
.role.warn { color:var(--warn); } .role.err { color:var(--err); }
.role svg { width:12px; height:12px; }
.stats { display:flex; flex-wrap:wrap; gap:1px; margin:20px 0 0;
  background:var(--hair); border:1px solid var(--hair); border-radius:12px; overflow:hidden; }
.stat { flex:1 1 120px; background:var(--raise); padding:10px 14px; min-width:0; }
.stat.wide { flex:3 1 280px; }
.stat dt { color:var(--fnt); font-size:11.5px; margin:0 0 2px; }
.stat dd { margin:0; font-size:13.5px; font-variant-numeric:tabular-nums; }
.stat .sub { display:block; color:var(--fnt); font-size:11.5px; }
.open { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; margin:16px 0 0; }
.btn { display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:8px;
  background:var(--fg); color:var(--canvas); text-decoration:none; font-size:13px; font-weight:600; }
.fallback { color:var(--fnt); font-size:12px; }
.fallback code { color:var(--mut); font-size:11.5px; }
.notice { display:flex; align-items:center; gap:8px; margin:16px 0 0; padding:10px 14px; border-radius:10px;
  font-size:13px; color:var(--warn); border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);
  background:color-mix(in srgb,var(--warn) 9%,transparent); text-decoration:none; }
section { background:var(--raise); border:1px solid var(--hair); border-radius:12px; padding:14px 16px 16px;
  margin:14px 0 0; }
h2 { display:flex; align-items:center; gap:7px; font-size:13px; margin:0 0 12px; font-weight:600; color:var(--fg); }
h2 svg { color:var(--fnt); }
h2 .n { color:var(--fnt); font-weight:400; font-variant-numeric:tabular-nums; }
.verdict { border-color:color-mix(in srgb,var(--info) 40%,transparent);
  background:color-mix(in srgb,var(--info) 7%,var(--raise)); }
.verdict h2, .verdict h2 svg { color:var(--info); letter-spacing:.06em; text-transform:uppercase; font-size:11.5px; }
.verdict p { margin:0; font-size:15px; }
.q { color:var(--fnt); } .mut { color:var(--mut); } .err { color:var(--err); } .warn { color:var(--warn); }
.ref { display:inline-flex; align-items:baseline; gap:5px; min-width:0; }
.ref svg { width:12px; height:12px; align-self:center; }
.name { font-size:12.5px; }
h1 .name { font-size:20px; }
.v { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12px; padding:0 5px; border-radius:4px;
  background:var(--sel); color:var(--fg); }
.ctr { display:grid; grid-template-columns:1fr auto; gap:2px 12px; padding:9px 0; border-top:1px solid var(--hair); }
.ctr:first-of-type { border-top:0; padding-top:0; }
.ctr .img { grid-column:1 / -1; font-size:12px; color:var(--fnt); }
.ctr .img b { color:var(--mid); font-weight:500; }
.ctr .notes { grid-column:1 / -1; font-size:12px; }
.day { color:var(--fnt); font-size:11.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase;
  margin:14px 0 2px; }
.day:first-of-type { margin-top:0; }
.change { display:grid; grid-template-columns:48px 1fr; gap:12px; padding:7px 0; border-top:1px solid var(--hair);
  font-size:13px; }
.change time { color:var(--fnt); font-size:12px; padding-top:1px; }
.change .line { display:block; margin-top:2px; }
.path { list-style:none; margin:0 0 12px; padding:0; }
.path:last-child { margin-bottom:0; }
.hop { position:relative; padding:0 0 14px 28px; font-size:13px; }
.hop:last-child { padding-bottom:0; }
.hop .dot { position:absolute; left:0; top:0; display:grid; place-items:center; width:20px; height:20px;
  border-radius:6px; border:1px solid var(--hair); background:var(--canvas); color:var(--fnt); }
.hop .dot svg { width:11px; height:11px; }
.hop:not(:last-child)::after { content:""; position:absolute; left:10px; top:21px; bottom:2px;
  border-left:1px solid var(--hair); }
.hop.ok .dot { border-color:color-mix(in srgb,var(--ok) 55%,transparent); color:var(--ok); }
.hop.warn .dot { border-color:color-mix(in srgb,var(--warn) 55%,transparent); color:var(--warn); }
.hop.err .dot { border-color:color-mix(in srgb,var(--err) 55%,transparent); color:var(--err); }
.hop.self .name { font-weight:600; }
.hop .d { display:block; color:var(--fnt); font-size:12px; }
.hop.err .d, .hop.err > span { color:var(--err); }
h3 { font-size:12.5px; margin:14px 0 6px; font-weight:600; }
h3:first-of-type { margin-top:0; }
h3 span { color:var(--fnt); font-weight:400; }
.kv { display:grid; grid-template-columns:minmax(96px,max-content) 1fr; gap:5px 16px; margin:0; font-size:13px; }
.kv dt { color:var(--fnt); font-size:12px; padding-top:1px; }
.kv dd { margin:0; min-width:0; }
.tag { white-space:nowrap; font-size:11.5px; color:var(--fnt); border:1px dashed var(--hair); border-radius:4px; padding:0 4px; }
.tag.err { color:var(--err); border-color:color-mix(in srgb,var(--err) 45%,transparent); border-style:solid; }
.cap { display:flex; flex-wrap:wrap; gap:4px 8px; color:var(--fnt); font-size:12px; margin:0 0 8px; }
.log { margin:0; padding:10px 0; border-radius:8px; background:var(--code); border:1px solid var(--hair);
  font-size:12px; line-height:1.6; }
.log div { padding:0 12px 0 10px; border-left:2px solid transparent; white-space:pre-wrap; }
.log .error, .log .fatal { border-left-color:var(--err); color:var(--err); }
.log .warn { border-left-color:var(--warn); }
.log .debug { color:var(--fnt); }
.none { color:var(--fnt); font-size:13px; margin:0; }
.tbl { width:100%; border-collapse:collapse; font-size:12.5px; }
.tbl th { text-align:left; color:var(--fnt); font-weight:500; font-size:11.5px; padding:0 10px 6px 0;
  border-bottom:1px solid var(--hair); white-space:nowrap; }
.tbl td { padding:6px 10px 6px 0; border-bottom:1px solid var(--hair); vertical-align:top; }
.tbl tr:last-child td { border-bottom:0; }
.scroll { overflow-x:auto; }
.more { color:var(--fnt); font-size:12px; margin:8px 0 0; }
.cond, .evt, .find { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; padding:7px 0;
  border-top:1px solid var(--hair); font-size:13px; }
.cond:first-child, .evt:first-child, .find:first-child { border-top:0; padding-top:0; }
.cond .msg, .evt .msg, .find .msg { grid-column:2; color:var(--mut); font-size:12.5px; }
.evt time { color:var(--fnt); font-size:12px; }
.x { color:var(--fnt); font-size:12px; font-variant-numeric:tabular-nums; }
.para { margin:0; font-size:13px; }
.unread { margin:0; padding:0; list-style:none; font-size:13px; }
.unread li { display:flex; gap:8px; align-items:flex-start; margin:4px 0; }
.unread svg { margin-top:3px; color:var(--warn); }
footer { display:flex; justify-content:center; align-items:center; gap:6px; margin-top:26px; color:var(--fnt);
  font-size:12px; text-align:center; }
footer svg { width:12px; height:12px; }
@media (max-width: 560px) { main { padding:18px 12px 44px; } section { padding:12px 13px 14px; }
  .kv { grid-template-columns:1fr; gap:0; } .kv dt { margin-top:8px; } .kv dt:first-child { margin-top:0; }
  h1 .name { font-size:17px; } h1 { font-size:18px; } }
`;

const e = escapeHtml;

interface Ctx {
  colouring: ReportColouring;
  words: ReportWords;
  icons: ReportIcons;
  /** Names in the subject's own namespace drop the prefix. */
  namespace: string | null;
}

function none(text: string): string {
  return `<p class="none">${e(text)}</p>`;
}

function stamp(iso: string, lang: string, parts: Intl.DateTimeFormatOptions) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, { ...parts, timeZone: "UTC" }).format(
    date
  );
}

function when(iso: string, lang: string): string {
  return stamp(iso, lang, { dateStyle: "medium", timeStyle: "short" });
}

function hue(value: number, family: "kind" | "ident"): string {
  return `color:hsl(${value} var(--${family}-s) var(--${family}-l))`;
}

function kindGlyph(ref: ReportRef, colouring: ReportColouring): string {
  return colouring === "off"
    ? `<span class="mut" title="${e(ref.kind)}">${ref.icon}</span>`
    : `<span style="${hue(ref.kindHue, "kind")}" title="${e(ref.kind)}">${ref.icon}</span>`;
}

/**
 * The same rules as `ResourceName`: full spends the hue on identity and dims
 * the stem when the generated tail carries it; minimal keeps the kind's hue
 * on the icon and quietens the tail; off tints nothing.
 */
function refHtml(
  ref: ReportRef,
  ctx: Ctx,
  { icon = true, kind = true }: { icon?: boolean; kind?: boolean } = {}
): string {
  const { colouring } = ctx;
  const ident = hue(ref.identHue, "ident");
  const wholeTinted = colouring === "full" && ref.tail.length <= 2;
  const stem = wholeTinted
    ? `<span style="${ident}">${e(ref.stem)}</span>`
    : `<span class="${colouring === "full" ? "mut" : ""}">${e(ref.stem)}</span>`;
  const tail = !ref.tail
    ? ""
    : colouring === "full"
      ? `<span style="${ident}">${e(ref.tail)}</span>`
      : `<span class="${colouring === "minimal" ? "q" : ""}">${e(ref.tail)}</span>`;
  const namespace =
    ref.namespace && ref.namespace !== ctx.namespace
      ? `<span class="q">${e(ref.namespace)}/</span>`
      : "";
  const glyph = icon ? kindGlyph(ref, colouring) : "";
  const prefix = kind ? `<span class="q">${e(ref.kind)}/</span>` : "";
  return `<span class="ref">${glyph}<span class="name">${namespace}${prefix}${stem}${tail}</span></span>`;
}

function roleHtml(role: StatusRole, text: string, icons: ReportIcons) {
  return `<span class="role ${role}">${icons.roles[role]}${e(text)}</span>`;
}

function valueHtml(value: ReportValue, ctx: Ctx): string {
  if (value.ref) return refHtml(value.ref, ctx);
  if (value.at)
    return `<time datetime="${e(value.at)}">${e(when(value.at, ctx.words.lang))}</time>`;
  if (value.role) return roleHtml(value.role, value.text, ctx.icons);
  const cls = [value.mono ? "mono" : "", value.quiet ? "q" : ""]
    .filter(Boolean)
    .join(" ");
  return cls ? `<span class="${cls}">${e(value.text)}</span>` : e(value.text);
}

function valuesHtml(text: string): string {
  const [head, ...rest] = e(text).split(VALUE_OPEN);
  return (
    head +
    rest
      .map((chunk) => {
        const [value, after = ""] = chunk.split(VALUE_CLOSE);
        return `<code class="v">${value}</code>${after}`;
      })
      .join("")
  );
}

function factsHtml(
  rows: { label: string; values: ReportValue[] }[],
  ctx: Ctx
): string {
  if (rows.length === 0) return none(ctx.words.nothingHere);
  return `<dl class="kv">${rows
    .map(
      (row) =>
        `<dt>${e(row.label)}</dt><dd>${row.values
          .map((value) => valueHtml(value, ctx))
          .join(" ")}</dd>`
    )
    .join("")}</dl>`;
}

function tableHtml(
  body: Extract<ReportSectionBody, { type: "table" }>,
  ctx: Ctx
): string {
  if (body.rows.length === 0) return none(ctx.words.nothingHere);
  return `<div class="scroll"><table class="tbl"><thead><tr>${body.columns
    .map((column) => `<th>${e(column)}</th>`)
    .join("")}</tr></thead><tbody>${body.rows
    .map(
      (row) =>
        `<tr>${row.cells.map((cell) => `<td>${valueHtml(cell, ctx)}</td>`).join("")}</tr>`
    )
    .join("")}</tbody></table></div>${
    body.more ? `<p class="more">${e(body.more)}</p>` : ""
  }`;
}

function conditionsHtml(rows: ReportConditionRow[], ctx: Ctx): string {
  if (rows.length === 0) return none(ctx.words.nothingHere);
  return rows
    .map(
      (row) =>
        `<div class="cond">${roleHtml(row.role, row.status, ctx.icons)}<span><b>${e(row.type)}</b>${
          row.reason ? ` <span class="mono q">${e(row.reason)}</span>` : ""
        }${row.since ? ` <span class="x">${e(when(row.since, ctx.words.lang))}</span>` : ""}</span>${
          row.message ? `<span class="msg">${e(row.message)}</span>` : ""
        }</div>`
    )
    .join("");
}

function eventsHtml(rows: ReportEventRow[], ctx: Ctx): string {
  if (rows.length === 0) return none(ctx.words.nothingHere);
  return rows
    .map(
      (row) =>
        `<div class="evt">${roleHtml(row.role, row.reason, ctx.icons)}<span>${
          row.ref ? `${refHtml(row.ref, ctx)} ` : ""
        }${row.at ? `<time datetime="${e(row.at)}">${e(when(row.at, ctx.words.lang))}</time>` : ""}${
          row.count > 1 ? ` <span class="x">×${row.count}</span>` : ""
        }</span><span class="msg">${e(row.message)}</span></div>`
    )
    .join("");
}

function findingsHtml(items: ReportFinding[], ctx: Ctx): string {
  if (items.length === 0) return none(ctx.words.nothingHere);
  return items
    .map(
      (item) =>
        `<div class="find">${roleHtml(item.role, "", ctx.icons)}<span>${
          item.ref ? `${refHtml(item.ref, ctx)} ` : ""
        }${item.ref && item.title === item.ref.stem + item.ref.tail ? "" : e(item.title)}</span>${item.detail ? `<span class="msg">${e(item.detail)}</span>` : ""}</div>`
    )
    .join("");
}

function containersHtml(containers: ReportContainer[], ctx: Ctx): string {
  if (containers.length === 0) return none(ctx.words.nothingHere);
  return containers
    .map(
      (c) =>
        `<div class="ctr"><span class="name">${e(c.name)}${
          c.init ? ` <span class="tag">${e(ctx.words.init)}</span>` : ""
        }</span>${c.state ? roleHtml(c.role, c.state, ctx.icons) : "<span></span>"}<span class="img mono">${e(c.repository)}${
          c.tag ? `:<b>${e(c.tag)}</b>` : ""
        }</span>${
          c.notes.length > 0
            ? `<span class="notes ${c.role === "err" ? "err" : "mut"}">${e(c.notes.join(" · "))}</span>`
            : ""
        }</div>`
    )
    .join("");
}

function changesHtml(changes: ReportChange[], ctx: Ctx): string {
  if (changes.length === 0) return none(ctx.words.nothingHere);
  const lang = ctx.words.lang;
  let day = "";
  return changes
    .map((change) => {
      if (change.at === null)
        return none(change.parts.map((part) => part.text).join(" "));
      const today = stamp(change.at, lang, { dateStyle: "medium" });
      const head = today === day ? "" : `<p class="day">${e(today)}</p>`;
      day = today;
      const time = stamp(change.at, lang, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = change.parts
        .map(
          (part) =>
            `<span class="line ${part.quiet ? "q" : ""}">${valuesHtml(part.text)}</span>`
        )
        .join("");
      return `${head}<div class="change"><time datetime="${e(change.at)}">${e(time)}</time><div>${
        change.ref ? refHtml(change.ref, ctx) : ""
      }${parts}</div></div>`;
    })
    .join("");
}

function trafficHtml(
  body: Extract<ReportSectionBody, { type: "traffic" }>,
  ctx: Ctx
): string {
  if (body.paths.length === 0) return none(body.note ?? ctx.words.nothingHere);
  return body.paths
    .map(
      (path) =>
        `<ol class="path">${path.hops
          .map((hop) => {
            const glyph = hop.ref
              ? kindGlyph(hop.ref, ctx.colouring)
              : hop.tone
                ? ctx.icons.roles[hop.tone]
                : "";
            const text = hop.ref
              ? refHtml(hop.ref, ctx, { icon: false })
              : `<span>${e(hop.text ?? "")}</span>`;
            return `<li class="hop ${hop.tone ?? ""}${hop.self ? " self" : ""}"><span class="dot">${glyph}</span>${text}${
              hop.detail ? `<span class="d">${e(hop.detail)}</span>` : ""
            }</li>`;
          })
          .join("")}</ol>`
    )
    .join("");
}

function connectionsHtml(groups: ReportGroup[], ctx: Ctx): string {
  if (groups.length === 0) return none(ctx.words.nothingHere);
  return groups
    .map(
      (group) =>
        `<h3>${e(group.title)}${group.caption ? ` <span>${e(group.caption)}</span>` : ""}</h3><dl class="kv">${group.rows
          .map(
            (row) =>
              `<dt>${e(row.label)}</dt><dd>${[
                row.ref
                  ? refHtml(row.ref, ctx)
                  : row.name
                    ? `<span class="name">${e(row.name)}</span>`
                    : "",
                row.detail ? `<span class="q">${e(row.detail)}</span>` : "",
                row.existence
                  ? `<span class="tag ${row.missing ? "err" : ""}">${e(row.existence)}</span>`
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}</dd>`
          )
          .join("")}</dl>`
    )
    .join("");
}

/**
 * The log lines, with what a container printed that nobody should publish
 * taken out: here rather than at the call site, because the footer promises
 * it and a caller that forgot would publish a password to a URL.
 */
function logsHtml(
  body: Extract<ReportSectionBody, { type: "logs" }>,
  ctx: Ctx
): string {
  const withLines = body.logs.filter((log) => log.lines.length > 0);
  if (withLines.length === 0) return none(body.absent ?? ctx.words.nothingHere);
  return withLines
    .map(
      (log) =>
        `<p class="cap"><span class="mono">${e(log.source)}</span>${
          log.previous ? `<span>${e(ctx.words.previousRun)}</span>` : ""
        }${log.caption ? `<span>${e(log.caption)}</span>` : ""}</p><pre class="log">${log.lines
          .map(
            (line) =>
              `<div class="${line.level ?? ""}">${e(redact(line.text))}</div>`
          )
          .join("")}</pre>`
    )
    .join("");
}

function bodyHtml(body: ReportSectionBody, ctx: Ctx): string {
  switch (body.type) {
    case "facts":
      return factsHtml(body.rows, ctx);
    case "table":
      return tableHtml(body, ctx);
    case "conditions":
      return conditionsHtml(body.rows, ctx);
    case "events":
      return eventsHtml(body.rows, ctx);
    case "findings":
      return findingsHtml(body.items, ctx);
    case "containers":
      return containersHtml(body.containers, ctx);
    case "changes":
      return changesHtml(body.changes, ctx);
    case "traffic":
      return trafficHtml(body, ctx);
    case "connections":
      return connectionsHtml(body.groups, ctx);
    case "logs":
      return logsHtml(body, ctx);
    case "text":
      return body.role
        ? `<p class="para ${body.role === "err" ? "err" : body.role === "warn" ? "warn" : ""}">${e(body.text)}</p>`
        : `<p class="para">${e(body.text)}</p>`;
  }
}

function sectionHtml(section: ReportSection, ctx: Ctx): string {
  const body = section.unread
    ? `<p class="warn">${e(section.unread)}</p>`
    : bodyHtml(section.body, ctx);
  return `<section id="${e(section.id)}"><h2>${section.icon}${e(section.title)}${
    section.count ? ` <span class="n">${section.count}</span>` : ""
  }</h2>${body}</section>`;
}

function statsHtml(report: Report, ctx: Ctx): string {
  return `<dl class="stats">${report.stats
    .map(
      (stat) =>
        `<div class="stat${stat.ref ? " wide" : ""}"><dt>${e(stat.label)}</dt><dd>${
          stat.ref
            ? refHtml(stat.ref, ctx, { kind: false })
            : stat.role
              ? roleHtml(stat.role, stat.value, report.icons)
              : e(stat.value)
        }${stat.note ? `<span class="sub">${e(stat.note)}</span>` : ""}</dd></div>`
    )
    .join("")}</dl>`;
}

function notReadHtml(report: Report): string {
  if (report.notRead.length === 0) return none(report.words.allRead);
  return `<ul class="unread">${report.notRead
    .map((item) => `<li>${report.icons.notRead}<span>${e(item)}</span></li>`)
    .join("")}</ul>`;
}

/**
 * One file, no requests: every style and glyph is inline and there is no
 * script, so it reads in a mail client that blocks everything and never
 * phones home.
 */
export function renderReport(report: Report): string {
  const w = report.words;
  const icons = report.icons;
  const ctx: Ctx = {
    colouring: report.colouring,
    words: w,
    icons,
    namespace: report.subject.namespace,
  };
  const { kind, name, namespace } = report.subject;
  const title = report.hero.ref
    ? `${kind} ${namespace ? `${namespace}/` : ""}${name}`
    : report.hero.title;
  const glyphStyle =
    report.colouring === "off" || report.hero.hue === null
      ? ""
      : hue(report.hero.hue, "kind");
  const heading = report.hero.ref
    ? refHtml(report.hero.ref, ctx, { icon: false, kind: false })
    : e(report.hero.title);
  const header = [
    `<p class="top"><span><b>Rubick</b> · ${e(report.kicker)}</span><span>${e(
      `${w.captured} ${when(report.capturedAt, w.lang)} UTC`
    )}</span></p>`,
    `<div class="hero"><span class="glyph" style="${glyphStyle}">${report.hero.icon}</span><div>`,
    `<h1>${heading}</h1>`,
    `<div class="chips">${
      report.status
        ? roleHtml(report.status.role, report.status.text, icons)
        : ""
    }${report.chips
      .map((chip) => `<span class="chip">${chip.icon}${e(chip.text)}</span>`)
      .join("")}</div></div></div>`,
    report.stats.length > 0 ? statsHtml(report, ctx) : "",
    `<div class="open"><a class="btn" href="${e(report.link)}" target="_blank" rel="noopener">${icons.open}${e(w.openInRubick)}</a><span class="fallback">${e(
      w.linkFallback
    )} <code>${e(report.link)}</code></span></div>`,
    report.notRead.length > 0
      ? `<a class="notice" href="#not-read">${icons.notRead}${e(w.notReadCount)}</a>`
      : "",
  ].join("");
  const body = [
    `<header>${header}</header>`,
    report.verdict
      ? `<section class="verdict"><h2>${icons.verdict}${e(w.verdict)}</h2><p>${e(report.verdict)}</p></section>`
      : "",
    ...report.sections.map((section) => sectionHtml(section, ctx)),
    `<section id="not-read"><h2>${icons.notRead}${e(w.notRead)}${
      report.notRead.length
        ? ` <span class="n">${report.notRead.length}</span>`
        : ""
    }</h2>${notReadHtml(report)}</section>`,
    `<footer>${icons.shield}${e(`${w.madeBy} ${report.appVersion}`)} · ${e(w.noSecrets)}</footer>`,
  ].join("");
  return `<!doctype html>
<html lang="${e(w.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

/** What the file is called on disk: what it is about, and when it was captured. */
export function reportFileName(report: Report): string {
  const stamp = report.capturedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const where = report.subject.namespace ? `${report.subject.namespace}-` : "";
  const what = report.subject.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${where}${what || "rubick"}-${stamp}.html`;
}
