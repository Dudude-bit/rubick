import { OutLink } from "@/components/ui/out-link";
import { useT } from "@/i18n/useT";
import { kindDocs, type ExplainedKind } from "@/lib/docs";

/** What this kind is, in a sentence, and where Kubernetes explains it in full. */
export function KindAbout({ kind }: { kind: ExplainedKind }) {
  const t = useT();
  return (
    <>
      {t("kindAbout", kind)}{" "}
      <OutLink href={kindDocs(kind)} site="kubernetes.io">
        {t("action", "learnMore")}
      </OutLink>
    </>
  );
}
