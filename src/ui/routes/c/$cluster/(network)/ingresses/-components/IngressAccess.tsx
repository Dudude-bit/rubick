import { Copy, ExternalLink } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceRef } from "@/components/object/ResourceRef";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useT } from "@/i18n/useT";
import { covers } from "@/lib/certificates";
import { ingressHealthWords, type IngressHealth } from "@/lib/ingress-health";
import { openExternal } from "@/lib/open-external";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import type { IngressInfo } from "@/generated/types";
import type { AccessUrl } from "./access-urls";
import { VerdictBadge } from "../../../-object/health-views";
import { TLS_NOT_CHECKED_TONE } from "../../-components";

const ACCESS_ROW =
  "grid grid-cols-[44px_minmax(0,1fr)_minmax(0,190px)_50px] items-baseline gap-2.5 px-1.5 py-[3px] text-xs";

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof Copy;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** The Secret `spec.tls` names for a host: its own entry first, then a catch-all. */
function secretFor(ingress: IngressInfo, host: string): string | null {
  const own = ingress.tlsConfigs.find(
    (config) => !config.isCatchAll && covers(config.hosts, host)
  );
  const config =
    own ?? ingress.tlsConfigs.find((config) => config.isCatchAll) ?? null;
  return config?.secretName ?? null;
}

/**
 * Where the Ingress can be reached, read through its verdict: no controller
 * means nothing answers at any of these, and a TLS Secret that does not
 * exist means HTTPS is not served with the certificate the Ingress names.
 */
export function IngressAccess({
  ingress,
  urls,
  health,
}: {
  ingress: IngressInfo | undefined;
  urls: AccessUrl[];
  health: IngressHealth | undefined;
}) {
  const t = useT();
  const copyToClipboard = useCopyToClipboard();
  const verdict = health ? ingressHealthWords(health, t) : null;
  const unserved =
    health?.problems.some((problem) => problem.kind === "noController") ??
    false;
  const missingSecrets = new Set(
    (health?.problems ?? []).flatMap((problem) =>
      problem.kind === "tlsSecretMissing" ? [problem.secret] : []
    )
  );
  const plainHttp = urls.filter((url) => url.isHttps === false).length;
  const paths = t("count", "paths", { n: urls.length });

  return (
    <Section>
      <SectionHeader
        title={t("columns", unserved ? "wouldBeReachableAt" : "reachableAt")}
        count={
          plainHttp > 0
            ? `${paths} · ${t("empty", "overPlainHttp", { n: plainHttp })}`
            : paths
        }
      />
      {verdict && (verdict.role === "err" || verdict.role === "warn") && (
        <div className="px-1.5 pb-2">
          <VerdictBadge verdict={verdict} />
        </div>
      )}
      {urls.length === 0 ? (
        <p className="text-xs text-fg-fnt">
          {t("empty", "noRulesRoutesNothing")}
        </p>
      ) : (
        <div>
          {urls.map((url) => {
            const secret =
              url.isHttps && ingress ? secretFor(ingress, url.host) : null;
            const noSecret = secret !== null && missingSecrets.has(secret);
            const named = url.host && url.host !== "*";
            return (
              <div key={`${url.host}${url.path}`} className={ACCESS_ROW}>
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    url.isHttps === null
                      ? TLS_NOT_CHECKED_TONE
                      : noSecret
                        ? "text-err"
                        : url.isHttps
                          ? "text-fg-fnt"
                          : "text-warn"
                  )}
                  title={
                    url.isHttps === null
                      ? t("empty", "tlsNotChecked")
                      : undefined
                  }
                >
                  {url.isHttps === null ? "?" : url.isHttps ? "HTTPS" : "HTTP"}
                </span>
                <span className="min-w-0 break-all font-mono text-fg">
                  <span className="text-fg-mut">{url.displayHost}</span>
                  {url.path}
                </span>
                <span className="min-w-0 truncate text-fg-fnt">
                  {url.resourceBackend ? (
                    <span className="font-mono">{url.resourceBackend}</span>
                  ) : url.backendService ? (
                    <>
                      <ResourceRef
                        kind={ResourceType.Service}
                        name={url.backendService}
                        namespace={ingress?.namespace}
                        showKind={false}
                      />
                      <span className="font-mono">:{url.backendPort}</span>
                    </>
                  ) : (
                    t("empty", "noBackend")
                  )}
                </span>
                <span className="flex justify-end gap-0.5">
                  <IconAction
                    label={t("action", "copyUrl")}
                    icon={Copy}
                    onClick={() =>
                      copyToClipboard(named ? url.fullUrl : url.path)
                    }
                  />
                  {named && url.isHttps !== null && !unserved && !noSecret && (
                    <IconAction
                      label={t("action", "openInBrowser")}
                      icon={ExternalLink}
                      onClick={() =>
                        void openExternal(url.fullUrl, url.host, t)
                      }
                    />
                  )}
                </span>
                {noSecret && (
                  <span className="col-span-3 col-start-2 text-[11px] text-err">
                    {t("readings", "healthNoTlsSecret", { name: secret })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
