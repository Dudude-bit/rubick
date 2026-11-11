import { useT } from "@/i18n/useT";

/** A release or revision the cluster holds and this app could not read. */
export function NotRead({ why }: { why: string }) {
  const t = useT();
  return (
    <span className="text-[11px] text-warn" title={why}>
      {t("empty", "releaseNotRead")}
    </span>
  );
}
