import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import type { ContainerInfo } from "@/generated/types";
import { IntakeQuietNotice, StreamFailureNotice } from "./LogNotices";
import { parseQueryTerm, termLabel, type QueryTerm } from "./types";

describe("the notice that nothing has matched yet", () => {
  /**
   * The terms were joined with an English "and" inside the sentence, and the
   * sentence itself was two catalogue strings around them — so Russian read
   * "Ничего не совпало с level>=warn and pod=web уже 20 с".
   */
  it("lists the terms in the reader's language, inside one sentence", () => {
    useLocaleStore.setState({ choice: "ru" });
    const terms = [
      parseQueryTerm("level>=warn"),
      parseQueryTerm("pod=web"),
    ].filter((term): term is QueryTerm => term !== null);
    render(<IntakeQuietNotice since={Date.now() - 20_000} terms={terms} />);

    const notice = screen.getByTestId("log-intake-quiet");
    expect(notice).toHaveTextContent(
      `${termLabel(terms[0])} и ${termLabel(terms[1])}`
    );
    expect(notice).not.toHaveTextContent(" and ");
    useLocaleStore.setState({ choice: null });
  });
});

describe("how a stream's notice says the run ended", () => {
  const container = (exitCode: number, reason: string): ContainerInfo => ({
    name: "wait-for-db",
    image: "busybox:1.36",
    ready: false,
    started: false,
    phase: "init",
    state: {
      type: "terminated",
      termination: {
        exitCode,
        signal: null,
        reason,
        message: null,
        startedAt: null,
        finishedAt: null,
      },
    },
    lastTerminated: null,
    restartCount: 10,
    ports: [],
    resources: { requests: {}, limits: {} },
    env: [],
    envFrom: [],
  });
  const notice = (info: ContainerInfo) =>
    render(
      <StreamFailureNotice
        failure={{
          kind: "log-not-kept",
          container: "wait-for-db",
          pod: "init-demo",
          message: "unable to retrieve container logs",
        }}
        reading="notKept"
        podName="init-demo"
        container={info}
        intake={false}
        previousRun={false}
        onRetry={() => {}}
        onShowCurrentRun={() => {}}
      />
    );

  /** wait-for-db's "exited Completed · exit 0" was red. Fails if a clean exit is painted as a failure. */
  it("paints a clean exit as a success and a failed one as an error", () => {
    const { unmount } = notice(container(0, "Completed"));
    expect(screen.getByTestId("log-stream-termination")).toHaveClass("text-ok");
    unmount();
    notice(container(137, "ContainerStatusUnknown"));
    expect(screen.getByTestId("log-stream-termination")).toHaveClass(
      "text-err"
    );
  });
});
