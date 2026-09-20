import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { fetchClusters } from "./data";
import { readScyllaCluster } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const clusters = (await fetchClusters()).map((c) => readScyllaCluster(c));
  const lines: VendorFact[] = [
    {
      say: {
        key: "kindCount",
        values: { n: clusters.length, kind: "ScyllaCluster" },
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
  const upgrading = clusters.filter((c) => c.upgrade !== null).length;
  if (upgrading > 0) {
    lines.push({
      say: { key: "factUpgrading", values: { n: upgrading } },
      tone: "warn",
    });
  }
  if (clusters.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("scylla"),
    });
  }
  return lines;
}
