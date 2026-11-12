import { CopyableAddress } from "@/components/ui/copyable-value";
import { None } from "@/components/ui/none";
import { useT } from "@/i18n/useT";
import { clusterIpOf } from "@/lib/cluster-ip";

/** A Service's cluster IP on its page, its peek and the Services list. */
export function ClusterIpValue({ clusterIp }: { clusterIp: string | null }) {
  const t = useT();
  const ip = clusterIpOf(clusterIp);
  if (ip.state === "none") return <None />;
  if (ip.state === "headless") {
    return (
      <span
        className="whitespace-nowrap font-mono text-fg-mut"
        title={t("empty", "clusterIpHeadlessWhy")}
      >
        {t("empty", "clusterIpHeadless")}
      </span>
    );
  }
  return (
    <CopyableAddress value={ip.address} label={t("columns", "clusterIp")} />
  );
}
