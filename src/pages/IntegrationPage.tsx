/**
 * One route for every vendor screen there will ever be.
 *
 * The shell knows the shape of the answer — a slug, a name, a glyph and a
 * component — and never which vendors exist. That is the whole reason a
 * second vendor page costs one folder inside `src/integrations/` and no edit
 * out here.
 *
 * The three not-a-page cases are drawn rather than redirected away. A reader
 * reaches this route from a restored tab, a bookmark or a cluster switch as
 * often as from the sidebar, and "Traefik is not installed in this cluster"
 * is an answer; being silently bounced to the overview is not.
 */

import { useParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { PackageOpen } from "lucide-react";

import { Section } from "@/components/ui/section";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useIntegrationPage } from "@/integrations";

export function IntegrationPage() {
  const { slug } = useParams<{ slug: string }>();
  const page = useIntegrationPage(slug);

  if (page.state === "detecting") return <PageSkeleton className="p-0" />;

  if (page.state === "unknown") {
    return (
      <Missing
        title="No integration by that name"
        body={`This app has no page for “${slug ?? ""}”. The name may have changed, or the link may be from a newer version.`}
      />
    );
  }

  if (page.state === "absent") {
    return (
      <Missing
        title={`${page.name} is not installed in this cluster`}
        body={`Its custom resource definitions are not in this API server, so there is nothing for this page to read. Every extension is optional — the cluster works exactly as it does now.`}
      />
    );
  }

  const { Page } = page;
  return <Page />;
}

function Missing({ title, body }: { title: string; body: string }) {
  return (
    <Section className="max-w-[64ch] py-8">
      <div className="flex items-center gap-2">
        <PackageOpen className="size-4 text-fg-fnt" aria-hidden />
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
      </div>
      <p className="text-xs text-fg-mut">{body}</p>
      <p className="text-[11px] text-fg-fnt">
        <Link to="/settings/integrations" className="text-info hover:underline">
          Settings → Integrations
        </Link>{" "}
        lists every extension this app knows about and what each one would give.
      </p>
    </Section>
  );
}

export default IntegrationPage;
