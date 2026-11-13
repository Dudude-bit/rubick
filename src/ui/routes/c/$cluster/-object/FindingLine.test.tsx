import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { FindingLine } from "./FindingLine";
import { closedSentence } from "./problem";

describe("the cluster's words before ours", () => {
  /** Shot r6-32: "...(Client.Timeout exceeded while awaiting headers) Most likely why...". Fails if words ending without a stop run into the sentence after them. */
  it("closes words that end without a stop, a closing bracket included", () => {
    expect(closedSentence("awaiting headers)")).toBe("awaiting headers).");
    expect(closedSentence("request timed out  ")).toBe("request timed out.");
  });

  /** Fails if words that already end a sentence get a second stop. */
  it("leaves words that already end a sentence as they are", () => {
    expect(closedSentence("Unknown Error.")).toBe("Unknown Error.");
    expect(closedSentence('it said "stop."')).toBe('it said "stop."');
    expect(closedSentence("")).toBe("");
  });

  /** Shot r5-76: an autoscaler's message ran into its readings. Fails if a finding's sentence is not closed before the readings that follow it. */
  it("closes a finding's sentence before its readings", () => {
    render(
      <FindingLine
        finding={{
          tone: "warn",
          title: "web-hpa is at its ceiling of 5",
          detail: "the desired count was more than the maximum replica count",
          evidence: [
            {
              key: "cpu",
              label: "cpu",
              current: "120%",
              target: "80%",
            } as never,
          ],
        }}
      />
    );
    expect(
      screen.getByText(
        /the desired count was more than the maximum replica count\./
      )
    ).toBeInTheDocument();
  });
});
