/**
 * An investigation, as one file somebody else can open.
 *
 * The report is a template, not prose: a verdict, the traffic chain as it
 * stood at the capture, the facts, what changed, the log lines, and what the
 * app could not read. It carries a `rubick://` link back to the same place,
 * and it is a single self-contained HTML file, because the person receiving
 * it has a phone and no cluster access.
 *
 * **No value of a Secret can reach it.** Nothing here accepts one: a mounted
 * Secret is a name and a key count, and a test hands the builder an object
 * carrying values anyway and reads the output for them.
 */

export interface ReportSubject {
  kind: string;
  name: string;
  namespace: string | null;
  context: string;
}

export interface ReportFact {
  label: string;
  value: string;
  /** Drawn as the thing that is wrong, rather than as one more row. */
  tone?: "err" | "warn";
}

/** One hop of the traffic chain, in the words the graph already used. */
export interface ReportHop {
  from: string;
  to: string;
  relation: string;
  /** `false` where the app did not get to look. */
  known: boolean;
  note?: string | null;
}

export interface ReportChange {
  at: string | null;
  text: string;
}

export interface ReportLog {
  /** `pod/container`, so a reader knows which stream a line came from. */
  source: string;
  lines: string[];
  /** The run before the current one. */
  previous: boolean;
}

export interface Report {
  subject: ReportSubject;
  capturedAt: string;
  appVersion: string;
  /** The app's own sentence, already worded and already hedged. */
  verdict: string | null;
  facts: ReportFact[];
  chain: ReportHop[];
  changes: ReportChange[];
  logs: ReportLog[];
  /** Everything asked for and refused, or never asked. */
  notRead: string[];
  /** `rubick://open/...`, so the reader with the app lands where this was made. */
  link: string;
  /** The words the file itself is written in. */
  words: ReportWords;
}

/** Every string the file shows, resolved before it is written. */
export interface ReportWords {
  title: string;
  captured: string;
  openInRubick: string;
  linkFallback: string;
  verdict: string;
  facts: string;
  chain: string;
  changes: string;
  logs: string;
  notRead: string;
  nothingHere: string;
  previousRun: string;
  notLookedAt: string;
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
 * The stylesheet, inline: the file is opened from a chat, from a phone,
 * from a laptop that has never heard of this app, and it has to be
 * readable in a dark and a light window without asking anything of any of
 * them.
 */
const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --mut:#4a5058; --fnt:#7a828c;
  --hair:#e3e6ea; --raise:#f6f7f9; --err:#b4232c; --warn:#8a5a00; --acc:#2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8ec; --mut:#aab1bb;
  --fnt:#79818c; --hair:#242832; --raise:#161a21; --err:#ff6b6b; --warn:#e0a33a; --acc:#7aa2f7; } }
* { box-sizing: border-box; }
/* A cluster writes names no line break was designed for: a 63-character
   pod name, an image with a digest, an address. On a phone every one of
   them is wider than the screen, and without this the report is read by
   scrolling sideways. */
body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--fg);
  font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  overflow-wrap:break-word; }
h1, .verdict, .hop, .sub, dd, li, pre, .mono { overflow-wrap:anywhere; }
main { max-width: 820px; margin: 0 auto; }
h1 { font-size:19px; margin:0 0 4px; letter-spacing:-0.01em; }
h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--fnt);
  margin:28px 0 8px; font-weight:600; }
.sub { color:var(--fnt); font-size:12px; margin:0 0 20px; }
.mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
.verdict { border:1px solid var(--hair); border-left:3px solid var(--warn);
  background:var(--raise); border-radius:6px; padding:12px 14px; margin:0 0 4px; }
.open { display:inline-block; margin:0 0 20px; padding:7px 12px; border-radius:6px;
  background:var(--acc); color:#fff; text-decoration:none; font-size:13px; font-weight:500; }
.facts { display:grid; grid-template-columns:minmax(120px,auto) 1fr; gap:4px 16px;
  font-size:13px; margin:0; }
.facts dt { color:var(--fnt); }
.facts dd { margin:0; }
.err { color:var(--err); }
.warn { color:var(--warn); }
ul { margin:0; padding-left:18px; }
li { margin:2px 0; }
.hop { border-bottom:1px solid var(--hair); padding:6px 0; font-size:13px; }
.hop:last-child { border-bottom:0; }
.hop .rel { color:var(--fnt); }
.log { background:var(--raise); border:1px solid var(--hair); border-radius:6px;
  padding:10px 12px; overflow-x:auto; }
.log pre { margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px; line-height:1.5; white-space:pre-wrap; }
.log h3 { font-size:12px; margin:0 0 6px; color:var(--fnt); font-weight:600; }
.none { color:var(--fnt); font-size:13px; }
footer { margin-top:36px; border-top:1px solid var(--hair); padding-top:12px;
  color:var(--fnt); font-size:11.5px; }
@media (max-width: 520px) { body { padding:16px 12px 48px; } .facts { grid-template-columns:1fr; gap:0 0; }
  .facts dt { margin-top:8px; } }
`;

function section(title: string, body: string): string {
  return `<h2>${escapeHtml(title)}</h2>${body}`;
}

function factsHtml(facts: ReportFact[], words: ReportWords): string {
  if (facts.length === 0)
    return `<p class="none">${escapeHtml(words.nothingHere)}</p>`;
  const rows = facts
    .map(
      (fact) =>
        `<dt>${escapeHtml(fact.label)}</dt><dd class="${fact.tone ?? ""}">${escapeHtml(fact.value)}</dd>`
    )
    .join("");
  return `<dl class="facts">${rows}</dl>`;
}

function chainHtml(hops: ReportHop[], words: ReportWords): string {
  if (hops.length === 0)
    return `<p class="none">${escapeHtml(words.nothingHere)}</p>`;
  return hops
    .map((hop) => {
      const note = hop.known
        ? (hop.note ?? "")
        : `${hop.note ? `${hop.note} · ` : ""}${words.notLookedAt}`;
      return `<div class="hop"><span class="mono">${escapeHtml(hop.from)}</span> <span class="rel">${escapeHtml(hop.relation)}</span> <span class="mono">${escapeHtml(hop.to)}</span>${
        note
          ? ` <span class="${hop.known ? "rel" : "warn"}">${escapeHtml(note)}</span>`
          : ""
      }</div>`;
    })
    .join("");
}

function listHtml(items: string[], words: ReportWords, tone = ""): string {
  if (items.length === 0)
    return `<p class="none">${escapeHtml(words.nothingHere)}</p>`;
  return `<ul>${items
    .map((item) => `<li class="${tone}">${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function changesHtml(changes: ReportChange[], words: ReportWords): string {
  if (changes.length === 0)
    return `<p class="none">${escapeHtml(words.nothingHere)}</p>`;
  return `<ul>${changes
    .map(
      (change) =>
        `<li><span class="mono rel">${escapeHtml(change.at ?? "?")}</span> ${escapeHtml(change.text)}</li>`
    )
    .join("")}</ul>`;
}

function logsHtml(logs: ReportLog[], words: ReportWords): string {
  const withLines = logs.filter((log) => log.lines.length > 0);
  if (withLines.length === 0)
    return `<p class="none">${escapeHtml(words.nothingHere)}</p>`;
  return withLines
    .map(
      (log) =>
        `<div class="log"><h3>${escapeHtml(log.source)}${
          log.previous ? ` · ${escapeHtml(words.previousRun)}` : ""
        }</h3><pre>${escapeHtml(log.lines.join("\n"))}</pre></div>`
    )
    .join("");
}

/**
 * One file, no requests. Every style is inline and there is no script: the
 * report is read where it lands, including a mail client that blocks
 * everything, and it must not phone home from a colleague's laptop.
 */
export function renderReport(report: Report): string {
  const w = report.words;
  const subject = `${report.subject.kind} ${
    report.subject.namespace ? `${report.subject.namespace}/` : ""
  }${report.subject.name}`;
  const head = [
    `<h1>${escapeHtml(subject)}</h1>`,
    `<p class="sub">${escapeHtml(
      `${w.captured} ${report.capturedAt} · ${report.subject.context}`
    )}</p>`,
    `<a class="open" href="${escapeHtml(report.link)}">${escapeHtml(w.openInRubick)}</a>`,
    `<p class="sub">${escapeHtml(w.linkFallback)} <span class="mono">${escapeHtml(report.link)}</span></p>`,
  ].join("");
  const verdict = report.verdict
    ? `<p class="verdict">${escapeHtml(report.verdict)}</p>`
    : "";
  const body = [
    head,
    verdict,
    section(w.facts, factsHtml(report.facts, w)),
    section(w.chain, chainHtml(report.chain, w)),
    section(w.changes, changesHtml(report.changes, w)),
    section(w.logs, logsHtml(report.logs, w)),
    section(w.notRead, listHtml(report.notRead, w, "warn")),
    `<footer>${escapeHtml(`${w.madeBy} ${report.appVersion}`)} · ${escapeHtml(w.noSecrets)}</footer>`,
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

/** What the file is called on disk: the object, and when it was captured. */
export function reportFileName(report: Report): string {
  const stamp = report.capturedAt.replace(/[:.]/g, "-").replace(/Z$/, "");
  const where = report.subject.namespace ? `${report.subject.namespace}-` : "";
  return `${where}${report.subject.name}-${stamp}.html`;
}
