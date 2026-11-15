import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScaleDialog } from "./ScaleDialog";
import { writeToastsHeld } from "@/lib/write-hold";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

const PROD = "prod-eu-1";

const scaleButton = () => screen.getByRole("button", { name: /scale/i });

const scale = (over: Partial<Parameters<typeof ScaleDialog>[0]> = {}) => (
  <ScaleDialog
    open
    kind="Deployment"
    name="web"
    namespace="shop"
    current={3}
    busy={false}
    onOpenChange={() => {}}
    onSubmit={() => {}}
    {...over}
  />
);

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: PROD, isConnected: true });
});

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("scaling on critical infrastructure", () => {
  /**
   * Scaling a workload to zero is the change the dialog's red band warns
   * about; without the gate it was still one click, which is exactly what the
   * mark on the cluster exists to stop.
   */
  it("holds the scale button until the cluster's name is typed", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));

    expect(screen.getByRole("alert")).toHaveTextContent(PROD);
    expect(scaleButton()).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(scaleButton()).toBeEnabled();

    await userEvent.click(scaleButton());
    expect(onSubmit).toHaveBeenCalledWith(3);
  });

  /**
   * The Scale button is a plain button, not a Radix close, so the success path
   * closes the dialog by the parent flipping `open` — which never fires
   * onOpenChange. If the gate is reset only there, the typed name survives and
   * the next scale on the same still-mounted surface fires on a stale match.
   */
  it("forgets the typed name once closed, so the next scale re-asks", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const { rerender } = render(scale());

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(scaleButton()).toBeEnabled();

    // The success path: the parent closes the dialog without onOpenChange.
    rerender(scale({ open: false }));
    rerender(scale({ open: true }));

    expect(screen.getByPlaceholderText(PROD)).toHaveValue("");
    expect(scaleButton()).toBeDisabled();
  });

  /**
   * A production-looking name is a guess, never the answer: a guard armed by
   * the name alone would sit on `prod-catalog-dev` until someone found the
   * setting that turns it off.
   */
  it("asks nothing of a cluster nobody marked", () => {
    render(scale());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scaleButton()).toBeEnabled();
  });
});

describe("what the dialog is about", () => {
  /** Restart named its object and Scale said only "Scale Deployment", so the number had no owner on screen. */
  it("names the object whose replicas it sets", () => {
    render(scale());
    expect(screen.getByRole("heading")).toHaveTextContent(
      "Scale Deployment shop/web"
    );
  });
});

describe("submitting from the keyboard", () => {
  /** Lena typed the count and pressed Enter; nothing happened. */
  it("scales on Enter in the replica field", async () => {
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    const field = screen.getByLabelText(/replicas/i);
    await userEvent.clear(field);
    await userEvent.type(field, "5{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(5);
  });

  /** Enter goes through the same gate the button does. */
  it("scales nothing on Enter while the cluster's name is untyped", async () => {
    useClusterIdentityStore.getState().setCritical(PROD, true);
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    await userEvent.type(screen.getByLabelText(/replicas/i), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("a count read after the dialog opened", () => {
  /**
   * The field is remounted with the count once it lands; it lost the focus
   * then, and the digits typed next went nowhere.
   */
  it("keeps the cursor in the count when the count arrives", () => {
    const { rerender } = render(scale({ current: undefined }));
    expect(screen.getByLabelText(/replicas/i)).toHaveValue(null);
    expect(scaleButton()).toBeDisabled();
    rerender(scale({ current: 4 }));
    const field = screen.getByLabelText(/replicas/i);
    expect(field).toHaveValue(4);
    expect(field).toHaveFocus();
  });

  /** An emptied field scaled to 0 on Enter, read as a count nobody typed. */
  it("scales nothing on Enter in an emptied field, and says why", async () => {
    const onSubmit = vi.fn();
    render(scale({ onSubmit }));
    const field = screen.getByLabelText(/replicas/i);
    await userEvent.clear(field);
    await userEvent.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Type how many replicas to run, 0 or more.")
    ).toBeInTheDocument();
  });
});

describe("scaling while the write is in flight", () => {
  /**
   * The submit was disabled with no sign of why and Cancel stayed live,
   * closing the dialog over a write that was still running. Fails if the
   * button stops showing it is working, or Cancel stays pressable.
   */
  it("shows the scale button working and holds Cancel", () => {
    render(scale({ busy: true }));
    expect(scaleButton()).toBeDisabled();
    expect(scaleButton()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("scaling when the write failed", () => {
  /**
   * A failure was a toast over a dialog that looked unchanged. Fails if the
   * dialog stops saying inline which count could not be set, and why.
   */
  it("says under the count what could not be set and why", async () => {
    const { rerender } = render(scale({ onSubmit: () => {} }));
    await userEvent.click(scaleButton());
    rerender(scale({ error: new Error("deployments/scale is forbidden") }));
    expect(screen.getByRole("alert")).toHaveTextContent(/forbidden/);
  });

  /** Fails if an unanswered write is drawn red, as if the cluster had refused it. */
  it("says an unanswered write may have gone through", async () => {
    const { rerender } = render(scale());
    await userEvent.click(scaleButton());
    rerender(
      scale({
        error: Object.assign(new Error("timed out"), { code: "NO_ANSWER" }),
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/may have done it/);
  });

  /** Fails if the dialog lets the toast say the same refusal a second time. */
  it("holds the failure toasts exactly while the write is out", async () => {
    const { rerender } = render(scale());
    expect(writeToastsHeld()).toBe(false);
    rerender(scale({ busy: true }));
    expect(writeToastsHeld()).toBe(true);
    rerender(scale({ busy: false }));
    expect(writeToastsHeld()).toBe(false);
  });

  /** Fails if Enter in the count field sends a second write while the first is out. */
  it("does not submit again while a write is out", async () => {
    const onSubmit = vi.fn();
    render(scale({ busy: true, onSubmit }));
    await userEvent.type(screen.getByLabelText(/replicas/i), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /** Fails if an error left from an earlier opening shows before anything was asked. */
  it("shows no error before a count was submitted", () => {
    render(scale({ error: new Error("old failure") }));
    expect(screen.queryByText(/old failure/)).toBeNull();
  });
});

describe("what the dialog says before it scales", () => {
  /**
   * Opened from a list row, the dialog showed a bare field: no current count
   * and no word on what the number does. Fails if the running count is not
   * stated, or the change typed is not worded as pods started, stopped, none
   * or all.
   */
  it("states the running count and what the typed number changes", async () => {
    render(scale({ current: 3 }));
    expect(screen.getByTestId("scale-current")).toHaveTextContent(
      "Runs 3 replicas now."
    );
    expect(screen.getByTestId("scale-change")).toHaveTextContent(
      "The same as now"
    );
    const field = screen.getByLabelText("Number of replicas");
    await userEvent.clear(field);
    await userEvent.type(field, "5");
    expect(screen.getByTestId("scale-change")).toHaveTextContent(
      "Starts 2 more pods."
    );
    await userEvent.clear(field);
    await userEvent.type(field, "2");
    expect(screen.getByTestId("scale-change")).toHaveTextContent(
      "Stops 1 pod."
    );
    await userEvent.clear(field);
    await userEvent.type(field, "0");
    expect(screen.getByTestId("scale-change")).toHaveTextContent(
      "Stops every pod"
    );
  });

  /** Fails if a count that was not read is drawn as a number, or a change is claimed against it. */
  it("says nothing about a count it has not read", () => {
    render(scale({ current: undefined }));
    expect(screen.queryByTestId("scale-current")).toBeNull();
    expect(screen.queryByTestId("scale-change")).toBeNull();
  });
});
