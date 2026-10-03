import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContextRow } from "./ContextRow";
import type { ContextInfo } from "@/generated/types";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";

const PROD = "prod-eu-1";

const ctx = (name: string): ContextInfo => ({
  name,
  cluster: name,
  user: "u",
  namespace: null,
  is_current: false,
  server: null,
  exec_command: null,
  auth: { kind: "token", source: null },
});

const row = (name: string) =>
  render(
    <ContextRow
      context={ctx(name)}
      binding={undefined}
      binaries={new Map()}
      connected={false}
      onBind={() => {}}
    />
  );

const criticalBox = () => screen.getByRole("checkbox");

beforeEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
});

afterEach(() => {
  useClusterIdentityStore.setState({ marks: {} });
});

describe("the critical checkbox on a context row", () => {
  /**
   * Unticking has to return the cluster to undecided, not write an explicit
   * `false`: that residue reads as "the person said no", which then suppresses
   * the guessed hint on a `prod`-looking name they only ever glanced at. The
   * mark that no longer says anything is the mark that is gone.
   */
  it("clears the mark on untick rather than leaving a false behind", async () => {
    row(PROD);

    await userEvent.click(criticalBox());
    expect(useClusterIdentityStore.getState().marks[PROD]?.critical).toBe(true);

    await userEvent.click(criticalBox());
    expect(useClusterIdentityStore.getState().marks[PROD]).toBeUndefined();
  });
});
