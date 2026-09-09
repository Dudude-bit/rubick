import { describe, expect, it } from "vitest";

import {
  renderReport,
  reportFileName,
  type Report,
  type ReportWords,
} from "./report";

const WORDS: ReportWords = {
  title: "Investigation",
  captured: "captured",
  openInRubick: "Open in Rubick",
  linkFallback: "No Rubick on this machine? Paste this into its search:",
  verdict: "Most likely",
  facts: "Facts",
  chain: "Traffic chain at capture",
  changes: "What changed",
  logs: "Log lines",
  notRead: "Not read",
  nothingHere: "Nothing here.",
  previousRun: "previous run",
  notLookedAt: "not looked at",
  madeBy: "Made by Rubick",
  noSecrets: "No Secret value is ever written into this file.",
};

function report(over: Partial<Report> = {}): Report {
  return {
    subject: {
      kind: "Pod",
      name: "payments-7b6d9c5f4-x8k2p",
      namespace: "shop",
      context: "prod-eu-1",
    },
    capturedAt: "2026-09-09T18:12:03.001Z",
    appVersion: "4.10.0",
    verdict:
      "Most likely: 10.43.39.231:5432 refused the connection. That address is Service shop-db-rw, which has nothing ready behind it right now; the pod itself is probably fine.",
    facts: [
      { label: "Status", value: "CrashLoopBackOff", tone: "warn" },
      {
        label: "app",
        value: "shop/payments:2.14.1 · Error · exit 1",
        tone: "err",
      },
    ],
    chain: [
      {
        from: "Service shop/shop-db-rw",
        to: "Pod shop/shop-db-1",
        relation: "selects",
        known: true,
      },
      {
        from: "Pod shop/payments",
        to: "NetworkPolicy shop/egress",
        relation: "governs",
        known: false,
      },
    ],
    changes: [
      {
        at: "2026-09-09T17:40:00.000Z",
        text: "Deployment payments · image · app:1 → app:2",
      },
    ],
    logs: [
      {
        source: "payments-7b6d9c5f4-x8k2p/app",
        lines: ["ERROR db: connection refused"],
        previous: true,
      },
    ],
    notRead: ["NetworkPolicy in shop (403)"],
    link: "rubick://open/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p?t=2026-09-09T18%3A12%3A03.001Z",
    words: WORDS,
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
    expect(html).toContain("@media (max-width: 520px)");
  });

  it("opens with the link back, and says what to do without the app", () => {
    const html = renderReport(report());
    expect(html).toContain(
      'href="rubick://open/prod-eu-1/pods/shop/payments-7b6d9c5f4-x8k2p?t=2026-09-09T18%3A12%3A03.001Z"'
    );
    expect(html).toContain("Open in Rubick");
    expect(html).toContain("Paste this into its search");
  });

  /** A hop the graph never read must not be drawn as one it did: that is the whole thesis, on paper. */
  it("marks an unread hop as unread rather than drawing it like the rest", () => {
    const html = renderReport(report());
    expect(html).toContain("not looked at");
    const unread = html.slice(html.indexOf("NetworkPolicy shop/egress"));
    expect(unread.slice(0, 200)).toContain("warn");
  });

  it("says a section is empty rather than leaving a heading over nothing", () => {
    const html = renderReport(
      report({ chain: [], changes: [], logs: [], notRead: [], verdict: null })
    );
    expect(html.match(/Nothing here\./g)?.length).toBe(4);
    expect(html).not.toContain("Most likely:");
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
        logs: [
          {
            source: "p/app",
            lines: ['</pre><script>alert("x")</script>'],
            previous: false,
          },
        ],
      })
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  /**
   * The file is passed to whoever is next on the incident, and a Secret's
   * value in it outlives the incident. Nothing in the report's shape can
   * carry one: this hands the builder an object with values anyway.
   */
  it("cannot carry a Secret value, whatever is pushed at it", () => {
    const leaky = report({
      facts: [
        {
          label: "Secret payments-db-credentials",
          value: "2 keys, values not included",
        },
      ],
    }) as Report & { secret?: unknown };
    leaky.secret = { password: "hunter2", token: "s3cr3t" };
    const html = renderReport(leaky);
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("s3cr3t");
    expect(html).toContain("2 keys, values not included");
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
});
