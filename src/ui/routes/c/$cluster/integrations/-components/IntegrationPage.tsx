/**
 * One route for every vendor screen there will ever be.
 *
 * The shell knows the shape of the answer — a slug, a name, a glyph and a
 * component — and never which vendors exist. That is the whole reason a
 * second vendor page costs one folder inside `src/ui/integrations/` and no edit
 * out here.
 *
 * The three not-a-page cases are drawn rather than redirected away. A reader
 * reaches this route from a restored tab, a bookmark or a cluster switch as
 * often as from the sidebar, and "Traefik is not installed in this cluster"
 * is an answer; being silently bounced to the overview is not.
 */

import { Link, useParams } from "@tanstack/react-router";
import { PackageOpen } from "lucide-react";

import { Unknown } from "@/components/ui/unknown";
import { Section } from "@/components/ui/section";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useIntegrationPage } from "@/integrations";
import { pageLink } from "@/lib/links";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";

export function IntegrationPage() {
  const t = useT();
  const { vendor } = useParams({ strict: false });
  const page = useIntegrationPage(vendor);

  if (page.state === "detecting") return <PageSkeleton className="p-0" />;

  if (page.state === "unknown") {
    return (
      <Missing
        title={t("empty", "noIntegrationByName")}
        body={t("empty", "noIntegrationByNameBody", { slug: vendor ?? "" })}
      />
    );
  }

  if (page.state === "absent") {
    return (
      <Missing
        title={t("empty", "integrationNotInstalled", { name: page.name })}
        body={t("empty", "integrationNotInstalledBody")}
      />
    );
  }

  // Refused rather than answered. Saying "not installed" here would put a
  // fact about the cluster behind a fact about this account's rights.
  if (page.state === "cannotTell") {
    return (
      <Section className="max-w-[64ch] py-8">
        <Unknown
          question={
            <>
              <span className="block font-medium">
                {t("empty", "integrationCannotTell", { name: page.name })}
              </span>
              <span className="block text-fg-mut">
                {t("empty", "couldNotLookWhy")}
              </span>
            </>
          }
          error={page.error}
          onRetry={page.retry}
        />
      </Section>
    );
  }

  // A configured-only vendor installs nothing, so "not installed" and its
  // talk of CRDs would both be false — the address is the whole setup.
  if (page.state === "notConfigured") {
    return (
      <Missing
        title={t("empty", "integrationNotConnected", { name: page.name })}
        body={t("empty", "integrationNotConnectedBody")}
        connect={{ vendor: vendor ?? "", name: page.name }}
      />
    );
  }

  const { Page } = page;
  return <Page />;
}

function Missing({
  title,
  body,
  connect,
}: {
  title: string;
  body: string;
  connect?: { vendor: string; name: string };
}) {
  const t = useT();
  return (
    <Section className="max-w-[64ch] py-8">
      <div className="flex items-center gap-2">
        <PackageOpen className="size-4 text-fg-fnt" aria-hidden />
        <h2 className="text-title font-semibold tracking-tight text-fg">
          {title}
        </h2>
      </div>
      <p className="text-xs text-fg-mut">{body}</p>
      {connect && (
        <Link
          {...pageLink("integrations", { vendor: connect.vendor })}
          className="w-fit text-xs text-info hover:underline"
        >
          {t("empty", "connectVendorLink", { name: connect.name })}
        </Link>
      )}
      <p className="text-caption text-fg-fnt">
        {parts(t("empty", "integrationsPageLists"), {
          link: (
            <Link
              {...pageLink("integrations")}
              className="text-info hover:underline"
            >
              {t("nav", "integrations")}
            </Link>
          ),
        })}
      </p>
    </Section>
  );
}

export default IntegrationPage;
