/**
 * What Argo CD is doing for this cluster right now.
 *
 * Applications only, and one list — the CRD detection keyed on, so the call
 * cannot be made against a cluster that would refuse it. A count is inventory
 * and is quiet; the two ways an Application fails to converge are why anybody
 * opens the row, and they are coloured.
 */

import { commands } from "@/lib/commands";

import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { APPLICATIONS_CRD } from "./data";
import { readApplication } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const objects = await commands.listCustomResources(
    APPLICATIONS_CRD,
    null,
    null,
    null
  );
  const apps = objects.map(readApplication);

  const lines: VendorFact[] = [
    {
      say: {
        key: "kindCount",
        values: { n: apps.length, kind: "Application" },
      },
    },
  ];

  const failing = apps.filter((app) =>
    app.findings.some(
      (finding) =>
        finding.kind === "syncFailing" || finding.kind === "syncFailedOnce"
    )
  ).length;
  if (failing > 0) {
    lines.push({
      say: { key: "factFailingToSync", values: { n: failing } },
      tone: "err",
    });
  }

  const drifted = apps.filter((app) =>
    app.findings.some((finding) => finding.kind === "drifted")
  ).length;
  if (drifted > 0) {
    lines.push({
      say: { key: "factDriftedUnfixed", values: { n: drifted } },
      tone: "warn",
    });
  }

  if (apps.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("argocd"),
    });
  }

  return lines;
}
