import { beforeEach, describe, expect, it } from "vitest";

import { aliasOf, useClusterIdentityStore } from "./clusterIdentityStore";

const ARN = "arn:aws:eks:us-east-1:1234:cluster/prod";

const state = () => useClusterIdentityStore.getState();

beforeEach(() => {
  localStorage.clear();
  useClusterIdentityStore.setState({ marks: {} });
});

describe("what a cluster is called", () => {
  it("is nothing until somebody says otherwise", () => {
    expect(aliasOf(state().marks, ARN)).toBeUndefined();
  });

  it("survives the spaces a name is typed with", () => {
    // Trimming between keystrokes would make a space impossible to type,
    // so the field's own text is kept and the trimmed one handed out.
    state().setAlias(ARN, "payments ");
    expect(state().marks[ARN].alias).toBe("payments ");
    expect(aliasOf(state().marks, ARN)).toBe("payments");
  });

  it("is cleared by emptying the field, not by a separate control", () => {
    state().setAlias(ARN, "payments");
    state().setAlias(ARN, "   ");
    expect(aliasOf(state().marks, ARN)).toBeUndefined();
  });
});

describe("what colour it wears", () => {
  it("keeps the alias when only the colour is reset", () => {
    state().setAlias(ARN, "payments");
    state().setHue(ARN, 224);
    state().setHue(ARN, null);

    expect(state().marks[ARN]).toEqual({ alias: "payments" });
  });

  it("leaves no residue once both are given up", () => {
    state().setHue(ARN, 224);
    state().setAlias(ARN, "payments");
    state().setHue(ARN, null);
    state().setAlias(ARN, "");

    expect(ARN in state().marks).toBe(false);
  });
});

describe("what is read back off this machine", () => {
  const migrate = (persisted: unknown) =>
    (
      useClusterIdentityStore.persist.getOptions().migrate as (
        p: unknown,
        v: number
      ) => { marks: Record<string, { alias?: string; hue?: number }> }
    )(persisted, 0).marks;

  it("refuses a hue that is not on the palette", () => {
    // A hue off the ring would be worn at a saturation and lightness the
    // themes were never calibrated for, which is the one thing a fixed
    // list of hues exists to prevent.
    expect(migrate({ marks: { [ARN]: { hue: 12 } } })).toEqual({});
    expect(migrate({ marks: { [ARN]: { hue: 224 } } })).toEqual({
      [ARN]: { hue: 224 },
    });
  });

  it("refuses an alias that is not a name", () => {
    expect(migrate({ marks: { [ARN]: { alias: "  " } } })).toEqual({});
    expect(migrate({ marks: { [ARN]: { alias: 7 } } })).toEqual({});
  });

  it("starts empty on a payload it did not write", () => {
    expect(migrate(undefined)).toEqual({});
    expect(migrate({ marks: "nonsense" })).toEqual({});
  });
});
