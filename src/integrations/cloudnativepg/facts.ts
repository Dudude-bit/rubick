import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { fetchClusters } from "./data";
import { readCluster } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const clusters = (await fetchClusters()).map(readCluster);
  const lines: VendorFact[] = [
    {
      say: {
        key: "kindCount",
        values: { n: clusters.length, kind: "Cluster" },
      },
    },
  ];
  const failing = clusters.filter((c) => c.worst === "err").length;
  if (failing > 0) {
    lines.push({
      say: { key: "factClustersInTrouble", values: { n: failing } },
      tone: "err",
    });
  }
  const archiving = clusters.filter(
    (c) => c.archiving.status === "False"
  ).length;
  if (archiving > 0) {
    lines.push({
      say: { key: "factArchivingFailing", values: { n: archiving } },
      tone: "err",
    });
  }
  if (clusters.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("cloudnativepg"),
    });
  }
  return lines;
}
