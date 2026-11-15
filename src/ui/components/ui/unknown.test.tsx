import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  currentConnection,
  noteRefusal,
  readOf,
  refusalOf,
} from "@/lib/refusals";
import { Unknown } from "./unknown";

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const REFUSED =
  'Tauri command \'getConnections\' failed: endpointslices.discovery.k8s.io is forbidden: User "kirya" cannot list resource "endpointslices" in API group "discovery.k8s.io" in the namespace "shop"';

describe("Unknown", () => {
  beforeEach(() => writeText.mockClear());

  /** Fails if a refusal and a fault look alike, which sends the reader to retry what will be refused again. */
  it("marks a refusal apart from a read that failed", () => {
    const { container, rerender } = render(
      <Unknown
        question="Who is behind this Service?"
        error={new Error(REFUSED)}
      />
    );
    expect(container.querySelector("[data-read]")).toHaveAttribute(
      "data-read",
      "refused"
    );
    rerender(
      <Unknown
        question="Who is behind this Service?"
        error={new Error("etcdserver: request timed out")}
      />
    );
    expect(container.querySelector("[data-read]")).toHaveAttribute(
      "data-read",
      "failed"
    );
  });

  /** The question was cut to "A fresh l…" beside a peek; fails if the sentence is truncated again instead of wrapping. */
  it("lets the question wrap rather than cutting it", () => {
    render(
      <Unknown
        compact
        question="A fresh list of deployments is failing."
        error={new Error("etcdserver: request timed out")}
      />
    );
    const question = screen.getByText(
      "A fresh list of deployments is failing."
    );
    expect(question.className).not.toMatch(/truncate/);
    expect(question).not.toHaveAttribute("title");
  });

  /**
   * In a narrow peek the lock sat alone on a line above its sentence. Fails
   * if the glyph is not in the same box as the question, so it can wrap
   * away from it.
   */
  it("keeps the glyph with the first words of the question", () => {
    const { container } = render(
      <Unknown
        compact
        question="Could not read Deployment api just now."
        error={new Error("etcdserver: request timed out")}
        onRetry={() => undefined}
      />
    );
    const glyph = container.querySelector("svg") as SVGElement;
    expect(glyph.parentElement).toHaveTextContent(
      "Could not read Deployment api just now."
    );
    expect(glyph.parentElement).not.toHaveTextContent("etcdserver");
  });

  /** A LIST_UNREAD that holds a 403 was worded "The read failed" under a triangle. Fails if it is not worded as a refusal. */
  it("words a refusal inside an unread-list error as a refusal", () => {
    const { container } = render(
      <Unknown
        question="Could not read what connects to this."
        error={Object.assign(
          new Error(
            `Could not read the Pod list, so whether web is there is unknown: ${REFUSED}`
          ),
          { code: "LIST_UNREAD" }
        )}
      />
    );
    expect(container.querySelector("[data-read]")).toHaveAttribute(
      "data-read",
      "refused"
    );
    expect(screen.getByText(/^The cluster refused:/)).toBeInTheDocument();
  });

  /** Fails if the line over rows still on screen grows into a block, which pushed the table down by 170 px. */
  it("says it in one line over content that stays, with the whole message on hover", () => {
    const { container } = render(
      <Unknown
        compact
        question="The rows below are from 10:26:02."
        error={new Error("etcdserver: request timed out")}
        onRetry={() => undefined}
      />
    );
    const line = container.querySelector("[data-read]");
    expect(line).toHaveAttribute("data-read", "failed");
    expect(line?.querySelectorAll("p")).toHaveLength(0);
    expect(
      screen.getAllByTitle(/etcdserver: request timed out/)[0]
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeInTheDocument();
  });

  /** A refusal with no way out leaves the reader exactly where the sentence left them. */
  it("turns a refusal into the rule to ask for", async () => {
    render(
      <Unknown
        question="Who is behind this Service?"
        error={new Error(REFUSED)}
      />
    );
    expect(screen.getByText("Who is behind this Service?")).toBeInTheDocument();
    expect(screen.getByText(/cluster refused/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /rule/i }));
    const yaml = writeText.mock.calls[0][0] as string;
    expect(yaml).toContain("kind: Role");
    expect(yaml).toContain("namespace: shop");
    expect(yaml).toContain('resources: ["endpointslices"]');
  });

  /** A network fault names no subject; offering a rule for it would be a lie. */
  it("offers a retry for a fault and no rule", async () => {
    const retry = vi.fn();
    render(
      <Unknown
        question="Usage history"
        error={new Error("connection refused")}
        onRetry={retry}
      />
    );
    expect(
      screen.queryByRole("button", { name: /rule/i })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  /**
   * The rule was copied, an administrator granted it, and the reader asks
   * again. Fails if the retry is answered from the connection's memory of
   * the refusal instead of by the cluster.
   */
  it("asks the cluster again on a retry after a refusal", async () => {
    const read = readOf("listServiceEndpoints", ["shop"])!;
    noteRefusal(read, new Error(REFUSED), currentConnection());
    expect(refusalOf(read)).toBeDefined();
    const retry = vi.fn();
    render(<Unknown question="q" error={new Error(REFUSED)} onRetry={retry} />);
    await userEvent.click(screen.getByRole("button", { name: /again/i }));
    expect(refusalOf(read)).toBeUndefined();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  /** Our own command wrapper's prefix is framing, not what the server said. */
  it("shows the server's words without the command framing", () => {
    render(<Unknown question="q" error={new Error(REFUSED)} />);
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/endpointslices\.discovery\.k8s\.io is forbidden/)
    ).toBeInTheDocument();
  });

  /**
   * Beside a peek the compact notice drew only its first sentence inside the
   * dashed frame: a flex item in the page's column shrank to one line and the
   * server's words and the retry hung below it. Fails if the frame can shrink
   * below its wrapped content, or the server's words are cut to one line, or
   * the retry leaves the frame.
   */
  it("keeps a long question, a long server message and the retry inside one frame that cannot shrink", () => {
    const long = "etcdserver: request timed out ".repeat(12);
    render(
      <Unknown
        compact
        question={"Could not read deployments just now. ".repeat(4)}
        error={new Error(long)}
        onRetry={() => {}}
      />
    );
    const frame = screen.getByRole("status");
    expect(frame).toHaveClass("shrink-0", "flex-wrap");
    const said = screen.getByText(/etcdserver: request timed out/);
    expect(said).toHaveClass("line-clamp-2", "min-w-0");
    expect(said).not.toHaveClass("truncate");
    expect(frame).toContainElement(said);
    expect(frame).toContainElement(
      screen.getByRole("button", { name: /again/i })
    );
  });

  /**
   * The cluster's sentence in a peek's notice was cut at two lines with
   * nothing to read the rest by. Fails if a cut sentence loses its toggle,
   * the toggle is not a keyboard stop, or a sentence that fits grows one.
   */
  it("gives a cut sentence a toggle that reads it whole", async () => {
    const heights = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get");
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get");
    try {
      heights.mockReturnValue(60);
      client.mockReturnValue(30);
      const { container } = render(
        <Unknown
          compact
          question="Who is behind this Service?"
          error={new Error(REFUSED)}
        />
      );
      const said = container.querySelector("[title]") as HTMLElement;
      expect(said.className).toContain("line-clamp-2");
      await userEvent.tab();
      const toggle = screen.getByRole("button", { name: "Show more" });
      expect(toggle).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(said.className).not.toContain("line-clamp-2");
      expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );
    } finally {
      heights.mockRestore();
      client.mockRestore();
    }
  });

  /** Fails if a sentence that fits on its lines is given a toggle with nothing to reveal. */
  it("offers no toggle where the sentence fits", () => {
    render(
      <Unknown
        compact
        question="Who?"
        error={new Error("etcdserver: request timed out")}
      />
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
