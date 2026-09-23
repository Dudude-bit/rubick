import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { en } from "@/i18n/catalogue";
import { TONE_TEXT } from "@/lib/tone";
import { ControllerLine, OperatorActionButton } from "./operator-kit";
import { OperatorStrip } from "./cloudnativepg/page";

const UNREADABLE = en.operators.deploymentsUnreadable;
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("the controller's line on an operator page", () => {
  /** A refused Deployment list is "could not look", never "not running". */
  it("says the Deployments could not be read rather than that none exists", () => {
    wrap(
      <ControllerLine
        controller={null}
        missing="no controller"
        known={false}
        reason="deployments is forbidden"
      />
    );
    expect(screen.getByText(UNREADABLE)).toHaveAttribute(
      "title",
      "deployments is forbidden"
    );
    expect(screen.queryByText("no controller")).toBeNull();
  });

  /**
   * "Could not look" and "not there" were both painted `text-warn`, so only
   * the words told them apart. Fails if the unread line takes the missing
   * line's colour again.
   */
  it("paints a controller it could not look for apart from one that is missing", () => {
    wrap(
      <>
        <ControllerLine
          controller={null}
          missing="no controller"
          known={false}
        />
        <ControllerLine controller={null} missing="no controller" known />
      </>
    );
    const unread = screen.getByText(UNREADABLE);
    const missing = screen.getByText("no controller");
    expect(missing).toHaveClass("text-warn");
    expect(unread).toHaveClass(TONE_TEXT.unknown);
    expect(unread).not.toHaveClass("text-warn");
  });

  it("names a controller short of its replicas in red", () => {
    wrap(
      <ControllerLine
        controller={{
          name: "cnpg",
          namespace: "cnpg-system",
          ready: 0,
          desired: 1,
        }}
        missing="no controller"
        known
      />
    );
    expect(screen.getByRole("link", { name: "cnpg 0/1" })).toHaveClass(
      "text-err"
    );
  });

  /**
   * The CloudNativePG strip drew "no Deployment carries the label" when the
   * operator read itself failed and nothing had been looked at.
   */
  it("does not claim an absent operator when the operator read failed", () => {
    wrap(<OperatorStrip operator={undefined} pending={false} />);
    expect(screen.getByText(UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByText(en.operators.controllerNotFound)).toBeNull();
  });
});

describe("an operator action that cannot run", () => {
  /** The control stays, disabled, and says why — it does not vanish. */
  it("stays on screen, disabled, with its reason", () => {
    const pick = vi.fn();
    render(
      <OperatorActionButton
        action={{
          explains: "actionFenceExplained",
          reason: "refusedPatch",
          danger: true,
        }}
        label="Fence"
        busy={false}
        onPick={pick}
      />
    );
    const button = screen.getByRole("button", { name: /Fence/ });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(en.operators.refusedPatch);
    fireEvent.click(button);
    expect(pick).not.toHaveBeenCalled();
  });
});
