import { describe, expect, it } from "vitest";

import {
  renderReport,
  reportFileName,
  VALUE_CLOSE,
  VALUE_OPEN,
  type Report,
  type ReportIcons,
  type ReportRef,
  type ReportSection,
  type ReportWords,
} from "./report";

const WORDS: ReportWords = {
  lang: "en",
  captured: "Captured",
  openInRubick: "Open in Rubick",
  linkFallback: "or paste this link into Rubick's search:",
  verdict: "Most likely",
  notRead: "Not read",
  notReadCount: "1 thing could not be read. The list is at the end.",
  allRead: "Everything this report names was read.",
  nothingHere: "Nothing here.",
  previousRun: "previous run",
  init: "init",
  madeBy: "Made by Rubick",
  noSecrets: "No Secret value is ever written into this file.",
};

const svg = (name: string) => `<svg data-icon="${name}"></svg>`;

const ICONS: ReportIcons = {
  roles: {
    ok: svg("ok"),
    pending: svg("pending"),
    warn: svg("warn"),
    err: svg("err"),
    neutral: svg("neutral"),
  },
  verdict: svg("verdict"),
  notRead: svg("not-read"),
  open: svg("open"),
  shield: svg("shield"),
};

const ref = (
  kind: string,
  stem: string,
  tail = "",
  namespace: string | null = "shop"
): ReportRef => ({
  kind,
  namespace,
  stem,
  tail,
  icon: svg(kind),
  kindHue: 264,
  identHue: 132,
});

const section = (
  id: string,
  body: ReportSection["body"],
  over: Partial<ReportSection> = {}
): ReportSection => ({ id, title: id, icon: svg(id), body, ...over });

const logs = (...lines: string[]): ReportSection =>
  section("logs", {
    type: "logs",
    logs: [
      {
        source: "payments/app",
        previous: false,
        caption: null,
        lines: lines.map((text) => ({ text, level: null })),
      },
    ],
    absent: null,
  });

function report(over: Partial<Report> = {}): Report {
  return {
    subject: {
      kind: "Pod",
      name: "payments-7b6d9c5f4-x8k2p",
      namespace: "shop",
      context: "prod-eu-1",
    },
    hero: {
      ref: ref("Pod", "payments", "-7b6d9c5f4-x8k2p"),
      title: "payments-7b6d9c5f4-x8k2p",
      icon: svg("Pod"),
      hue: 264,
    },
    kicker: "Investigation",
    capturedAt: "2026-09-09T18:12:03.001Z",
    appVersion: "4.10.0",
    colouring: "full",
    status: { text: "CrashLoopBackOff", role: "err" },
    chips: [{ icon: svg("cluster"), text: "prod-eu-1" }],
    stats: [{ label: "Restarts", value: "7", role: "warn" }],
    verdict:
      "Most likely: 10.43.39.231:5432 refused the connection. That address is Service shop-db-rw, which has nothing ready behind it right now; the pod itself is probably fine.",
    sections: [
      section("traffic", {
        type: "traffic",
        note: null,
        paths: [
          {
            broken: true,
            hops: [
              {
                ref: ref("Service", "shop-db-rw"),
                text: null,
                detail: null,
                tone: null,
                self: false,
              },
              {
                ref: null,
                text: "No pod carries app=db",
                detail: null,
                tone: "err",
                self: false,
              },
            ],
          },
        ],
      }),
      section("connections", {
        type: "connections",
        groups: [
          {
            title: "Needs to run",
            caption: null,
            rows: [
              {
                label: "Configuration",
                ref: ref("ConfigMap", "payments-env"),
                name: null,
                detail: "",
                existence: "not checked",
                missing: false,
              },
            ],
          },
        ],
      }),
      section("changes", {
        type: "changes",
        changes: [
          {
            at: "2026-09-09T17:40:00.000Z",
            ref: ref("Deployment", "payments"),
            parts: [
              {
                text: `app image ${VALUE_OPEN}1${VALUE_CLOSE} → ${VALUE_OPEN}2${VALUE_CLOSE}`,
                quiet: false,
              },
            ],
          },
        ],
      }),
      section("logs", {
        type: "logs",
        logs: [
          {
            source: "payments-7b6d9c5f4-x8k2p/app",
            lines: [{ text: "ERROR db: connection refused", level: "error" }],
            previous: true,
            caption: null,
          },
        ],
        absent: null,
      }),
    ],
    notRead: ["NetworkPolicy in shop (403)"],
    link: "rubick://open/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p?t=2026-09-09T18%3A12%3A03.001Z",
    words: WORDS,
    icons: ICONS,
    ...over,
  };
}

describe("renderReport", () => {
  /**
   * The file lands in a chat, is opened on a phone by someone with no
   * cluster and no app. It cannot fetch a stylesheet, phone home, or run
   * anything, and it has to be legible in a dark window and a light one.
   */
  it("is one self-contained file: no script, no request, both themes, a viewport", () => {
    const html = renderReport(report());
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc=|<link\b|@import|url\(/i);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media (max-width: 560px)");
  });

  it("opens with the link back, and says what to do without the app", () => {
    const html = renderReport(report());
    expect(html).toContain(
      'href="rubick://open/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p?t=2026-09-09T18%3A12%3A03.001Z"'
    );
    expect(html).toContain("Open in Rubick");
    expect(html).toContain("paste this link into Rubick's search");
  });

  /**
   * postplan serves a page sandboxed without top navigation, so a plain
   * link on the published copy does nothing when tapped.
   */
  it("opens the link back in a new context, which a sandboxed page allows", () => {
    const html = renderReport(report());
    expect(html).toMatch(/<a class="btn" href="rubick:[^"]*" target="_blank"/);
  });

  /** A row the app never looked up must not read like one it did. */
  it("marks a connection the app did not check, rather than drawing it like the rest", () => {
    const html = renderReport(report());
    const row = html.slice(html.indexOf("payments-env"));
    expect(row.slice(0, 200)).toContain(
      '<span class="tag ">not checked</span>'
    );
  });

  it("says a section is empty rather than leaving a heading over nothing", () => {
    const html = renderReport(
      report({
        sections: [
          section("changes", { type: "changes", changes: [] }),
          section("table", {
            type: "table",
            columns: ["Name"],
            rows: [],
            more: null,
          }),
        ],
        notRead: [],
        verdict: null,
      })
    );
    expect(html.match(/Nothing here\./g)?.length).toBe(2);
    expect(html).toContain("Everything this report names was read.");
    expect(html).not.toContain("Most likely");
  });

  /**
   * A section nobody could read is the opposite answer to an empty one, and
   * drawing its empty body would say "none" about a refusal.
   */
  it("says a section could not be read instead of drawing it empty", () => {
    const html = renderReport(
      report({
        sections: [
          section(
            "connections",
            { type: "connections", groups: [] },
            { unread: "Could not read what connects to this." }
          ),
        ],
      })
    );
    expect(html).toContain(
      '<p class="warn">Could not read what connects to this.</p>'
    );
    expect(html).not.toContain("Nothing here.");
  });

  /** "Nothing here." under Log lines reads as "the pod printed nothing". */
  it("says why there are no log lines when it knows", () => {
    const html = renderReport(
      report({
        sections: [
          section("logs", {
            type: "logs",
            logs: [],
            absent: "None: the Logs tab was not open.",
          }),
        ],
      })
    );
    expect(html).toContain("None: the Logs tab was not open.");
  });

  /**
   * The unread list sat at the very end, under the log lines, where a reader
   * who stops at the facts never learns the facts are partial.
   */
  it("says up front that something could not be read, and links to the list", () => {
    const html = renderReport(report());
    const notice = html.indexOf('href="#not-read"');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf("<section"));
    expect(html).toContain('id="not-read"');
    expect(renderReport(report({ notRead: [] }))).not.toContain("#not-read");
  });

  /** A raw ISO stamp is a string to decode; the file says the time in words, in UTC. */
  it("writes times for a person, in UTC, with the machine form kept", () => {
    const html = renderReport(report());
    expect(html).toContain("Sep 9, 2026");
    expect(html).toContain("UTC");
    expect(html).toContain('datetime="2026-09-09T17:40:00.000Z"');
    expect(html).toContain(">17:40<");
  });

  /**
   * The reader matches objects by the colours the sender's app gives them;
   * a file that drew every name grey made the pod on the page and the pod in
   * the chat look like two different things.
   */
  it("colours a name's generated tail by its identity, as the app does", () => {
    const html = renderReport(report());
    expect(html).toContain(
      '<span style="color:hsl(132 var(--ident-s) var(--ident-l))">-7b6d9c5f4-x8k2p</span>'
    );
    expect(html).toContain(
      'style="color:hsl(264 var(--kind-s) var(--kind-l))"'
    );
  });

  /** A sender who turned colouring off in Settings did not ask for it back in the file. */
  it("tints nothing when the sender turned resource colouring off", () => {
    const html = renderReport(report({ colouring: "off" }));
    expect(html).not.toContain("var(--ident-s)");
    expect(html).not.toContain("var(--kind-s) var(--kind-l))");
  });

  it("draws the kind's own icon beside every object it names", () => {
    const html = renderReport(report());
    expect(html).toContain('data-icon="Service"');
    expect(html).toContain('data-icon="ConfigMap"');
    expect(html).toContain('data-icon="Deployment"');
  });

  /** The tag that changed is the answer; drawn as plain prose it was lost in the sentence. */
  it("draws the values a change moved between as values", () => {
    const html = renderReport(report());
    expect(html).toContain(
      'app image <code class="v">1</code> → <code class="v">2</code>'
    );
    expect(html).not.toContain(VALUE_OPEN);
  });

  /** An error line is what the colleague scrolls the log for. */
  it("marks a log line by its level", () => {
    const html = renderReport(report());
    expect(html).toContain(
      '<div class="error">ERROR db: connection refused</div>'
    );
  });

  /** A screen report is a table of what was on screen, objects drawn as objects. */
  it("draws a table's objects and statuses as the app does", () => {
    const html = renderReport(
      report({
        hero: { ref: null, title: "Pods", icon: svg("Pod"), hue: null },
        sections: [
          section("table", {
            type: "table",
            columns: ["Name", "Status"],
            rows: [
              {
                cells: [
                  { text: "api-1", ref: ref("Pod", "api", "-1") },
                  { text: "Running", role: "ok" },
                ],
              },
            ],
            more: "12 more rows are in the app.",
          }),
        ],
      })
    );
    expect(html).toContain("<th>Name</th><th>Status</th>");
    expect(html).toContain('data-icon="Pod"');
    expect(html).toContain('<span class="role ok">');
    expect(html).toContain("12 more rows are in the app.");
    expect(html).toContain("<title>Pods</title>");
  });

  /** A condition is read by its role, not by whether its status says True. */
  it("draws each condition with the role the app gives it", () => {
    const html = renderReport(
      report({
        sections: [
          section("conditions", {
            type: "conditions",
            rows: [
              {
                type: "MemoryPressure",
                status: "False",
                role: "ok",
                reason: "KubeletHasSufficientMemory",
                message: null,
                since: null,
              },
            ],
          }),
        ],
      })
    );
    expect(html).toContain('<span class="role ok">');
    expect(html).toContain("MemoryPressure");
  });

  /**
   * A pod name, a log line or a verdict is whatever the cluster wrote,
   * including angle brackets and quotes. Unescaped, one of them ends the
   * file's own markup and takes the rest of the report with it.
   */
  it("escapes everything the cluster wrote", () => {
    const html = renderReport(
      report({
        subject: {
          kind: "Pod",
          name: '<img src=x onerror="alert(1)">',
          namespace: "shop",
          context: "prod",
        },
        sections: [logs('</pre><script>alert("x")</script>')],
      })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  /** The claim in the file's own footer, asserted where it can actually fail. */
  it("keeps the promise where the promise can be broken", () => {
    const html = renderReport(
      report({ sections: [logs("connecting with password=hunter2")] })
    );
    expect(html).not.toContain("hunter2");
    expect(html).toContain("No Secret value is ever written into this file.");
  });
});

describe("reportFileName", () => {
  it("names the file after the object and the moment, with nothing a filesystem refuses", () => {
    expect(reportFileName(report())).toBe(
      "shop-payments-7b6d9c5f4-x8k2p-2026-09-09T18-12-03-001.html"
    );
    expect(reportFileName(report())).not.toMatch(/[:*?"<>|]/);
  });

  /** A screen's title is words with spaces and signs; the file name must still be one a filesystem takes. */
  it("names a screen's file from its title", () => {
    const name = reportFileName(
      report({
        subject: {
          kind: "Screen",
          name: "Prometheus › Monitors",
          namespace: null,
          context: "prod",
        },
      })
    );
    expect(name).toBe("prometheus-monitors-2026-09-09T18-12-03-001.html");
  });

  /**
   * The file says in its own footer that no Secret value is written into it,
   * and the feature exists to publish that file to a URL a colleague opens.
   */
  it("takes the secrets out of the log lines it publishes", () => {
    const html = renderReport(
      report({
        sections: [
          logs(
            'level=error msg="dial failed" dsn=postgres://app:hunter2@db.shop:5432/app',
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "password=s3cr3t"
          ),
        ],
      })
    );

    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("s3cr3t");
    expect(html).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(html).toContain("dial failed");
  });
});
