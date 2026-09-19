import { CopyButton } from "@/components/ui/copyable-value";
import { useT } from "@/i18n/useT";

/** The hover mark beside a name, wherever the name is a link and not a button. */
export function CopyName({ name }: { name: string }) {
  const t = useT();
  return (
    <CopyButton value={name} label={`${t("action", "copyName")}: ${name}`} />
  );
}
