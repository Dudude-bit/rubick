import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Info, Lock, Route, Tag } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { ResourceRef } from "@/components/object/ResourceRef";
import {
  KeyValueList,
  KeyValueSection,
  type KeyValue,
} from "../../../-object/detail-kv";
import { recordToKeyValues, TONE_CLASS } from "@/components/object/key-values";
import { CertificateLine } from "../../../-object/CertificateFacts";
import { IssuanceSection } from "@/components/object/IssuanceChain";
import { TrafficChain } from "../../../-object/TrafficChain";
import { ChainWatches } from "../../../-object/ChainWatches";
import { IngressHealthView } from "../../../-object/health-views";
import { connectionsTab } from "../../../-object/connections-tab";
import { useOneIngressHealth } from "@/hooks/useIngressHealth";
import { useResourceDetail } from "@/hooks";
import { Link } from "@tanstack/react-router";
import { useChainAnswer } from "@/hooks/useChainAnswer";
import { useIngressShare } from "./useIngressShare";
import { IngressAccess } from "./IngressAccess";
import { generateAccessUrls } from "./access-urls";
import { useProxyBehind } from "@/hooks/useServiceRoutes";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { covers, expiryOf, expiryText } from "@/lib/certificates";
import { useIngressTls } from "@/hooks/useIngressTls";
import { TLS_NOT_CHECKED_TONE } from "../../-components";
import { deliveryOfKind } from "@/lib/delivery";
import {
  ingressAddressOf,
  ingressClassWords,
  INGRESS_ADDRESS_WORDS,
} from "@/lib/ingress-health";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import type { IngressInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function IngressDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: ingress,
    isLoading,
    error,
    yaml: ingressYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
    deleteMutation,
  } = useResourceDetail<IngressInfo>({
    resourceKind: ResourceType.Ingress,
    fetchResource: async (name, ns) => {
      try {
        return await commands.getIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    deleteResource: async (name, ns) => {
      try {
        await commands.deleteIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    defaultTab: "overview",
  });

  const rules = ingress?.rules ?? [];
  const fallback = ingress?.defaultBackend ?? null;
  // Whether the default backend is some vendor's own proxy — a door, not a
  // dead end, and the sign on it comes from whichever vendor owns it.
  const behind = useProxyBehind(
    ingress && fallback?.backendService
      ? { namespace: ingress.namespace, name: fallback.backendService }
      : null
  );
  const tlsHosts = ingress?.tlsHosts ?? [];
  const tlsConfigs = ingress?.tlsConfigs ?? [];
  const loadBalancerIps = ingress?.loadBalancerIps ?? [];
  const hasCatchAllTls = ingress?.hasCatchAllTls ?? false;
  const asked = useMemo(
    () =>
      ingress
        ? [
            {
              namespace: ingress.namespace,
              name: ingress.name,
              hosts: ingress.rules.flatMap((rule) =>
                rule.host ? [rule.host] : []
              ),
            },
          ]
        : [],
    [ingress]
  );
  const vendorTls = useIngressTls(asked);
  // `null` where the vendor could not tell, or has not answered yet.
  const terminatedByVendor = (host: string): boolean | null => {
    if (!ingress || !host) return false;
    const said = vendorTls.of(
      { namespace: ingress.namespace, name: ingress.name },
      host
    )?.terminated;
    if (said !== undefined) return said;
    return vendorTls.isPending || vendorTls.error !== null ? null : false;
  };
  const accessUrls = generateAccessUrls(
    rules,
    tlsHosts,
    hasCatchAllTls,
    t("empty", "allHosts"),
    terminatedByVendor
  );
  // "no TLS" is a claim about the whole way in, and `spec.tls` is only part
  // of it on every managed cloud.
  const vendorTerminates = rules.some(
    (rule) => rule.host && terminatedByVendor(rule.host) === true
  );
  const tls: "yes" | "no" | "unknown" =
    tlsHosts.length > 0 || tlsConfigs.length > 0 || vendorTerminates
      ? "yes"
      : rules.some(
            (rule) => rule.host && terminatedByVendor(rule.host) === null
          )
        ? "unknown"
        : "no";

  const chain = useChainAnswer(ResourceType.Ingress, name, namespace);
  const connections = chain.read;
  const tlsSecretNames = tlsConfigs.flatMap((config) =>
    config.secretName ? [config.secretName] : []
  );
  const certificates = useTlsCertificates(
    ingress?.namespace ?? namespace,
    tlsSecretNames
  );
  const issuance = useCertificateIssuance(
    ingress?.namespace ?? namespace,
    tlsSecretNames
  );

  // Which controller claims this Ingress. Core: IngressClass is a built-in
  // kind, and "none does" is the failure that is silent everywhere else.
  const { data: controller } = useQuery({
    queryKey: queryKeys.ingressClass(ingress?.className),
    queryFn: () => commands.resolveIngressClass(ingress?.className ?? null),
    enabled: !!ingress,
  });
  const address = ingressAddressOf({ loadBalancerIps }, controller);
  const health = useOneIngressHealth(ingress);

  // The soonest expiry across every certificate this Ingress serves: one
  // Ingress with four hosts has four certificates, and the badge can only
  // carry the one that runs out first.
  const soonest = tlsConfigs
    .map((config) =>
      config.secretName
        ? certificates?.get(config.secretName)?.certificate
        : undefined
    )
    .filter((cert) => cert != null)
    .map((cert) => expiryOf(cert))
    // Exact remaining time rather than whole days: several certificates
    // expiring today all tie on `days`, and this picks the one to show.
    .sort((a, b) => a.left - b.left)[0];

  // Once the certificate has been read, how long it has left is a more useful
  // answer than how many hosts it covers — the host count is a shape, and the
  // expiry is a date somebody has to act on. Said once, for the page and the
  // shared file both.
  const tlsFact: { text: string; tone: "warn" | "err" | null } =
    tls === "no"
      ? { text: t("empty", "noneTrafficUnencrypted"), tone: "warn" }
      : tls === "unknown"
        ? { text: t("empty", "tlsNotChecked"), tone: null }
        : soonest
          ? { text: expiryText(soonest, t), tone: soonest.tone ?? null }
          : hasCatchAllTls
            ? { text: t("empty", "catchAllCertificate"), tone: "warn" }
            : { text: t("count", "hosts", { n: tlsHosts.length }), tone: null };

  const share = useIngressShare(ingress, controller, {
    tls: { ...tlsFact, known: tls !== "unknown" },
    certificates,
  });

  const events = useObjectEvents(ResourceType.Ingress, name, namespace, {
    refresh: "overview",
  });

  const classWords = ingressClassWords(
    ingress?.className ?? null,
    controller,
    t
  );
  const facts: KeyValue[] = [
    {
      label: t("columns", "status"),
      value: ingress ? <IngressHealthView ingress={ingress} /> : null,
    },
    {
      // The class is a request; the controller is who answers it. Naming
      // only the request is how an Ingress nothing serves reads as fine.
      label: t("columns", "class"),
      value: classWords.text,
      mono: !!ingress?.className,
      tone: classWords.tone ?? undefined,
    },
    {
      label: t("columns", "loadBalancer"),
      // "Pending" only where a controller serves the class and can assign
      // one; beside "nothing serves this class" it promised an address that
      // will not come.
      value:
        address === "assigned" ? (
          <CopyableAddresses
            values={loadBalancerIps}
            label={t("columns", "ingressAddress")}
          />
        ) : (
          t("empty", INGRESS_ADDRESS_WORDS[address].key)
        ),
      tone:
        address === "assigned"
          ? undefined
          : (INGRESS_ADDRESS_WORDS[address].tone ?? undefined),
    },
    { label: t("columns", "rules"), value: rules.length, mono: true },
    { label: t("columns", "paths"), value: accessUrls.length, mono: true },
    {
      label: "TLS",
      value:
        tls === "unknown" ? (
          <span className={TLS_NOT_CHECKED_TONE}>{tlsFact.text}</span>
        ) : (
          tlsFact.text
        ),
      tone: tlsFact.tone ?? undefined,
    },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.Ingress, ingress);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title="Ingress" items={facts} className="max-w-lg" />

          <TrafficChain
            query={connections}
            certificates={certificates}
            issuance={issuance}
            controller={controller}
          />
        </>
      ),
    },
    {
      id: "access",
      label: t("nav", "access"),
      glyph: viewGlyph(ExternalLink),
      content: (
        <IngressAccess ingress={ingress} urls={accessUrls} health={health} />
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    {
      id: "rules",
      label: t("columns", "rules"),
      glyph: viewGlyph(Route),
      mark: countMark(rules.length),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "rules")}
            count={t("count", "hosts", { n: rules.length })}
          />
          {rules.length === 0 ? (
            fallback?.backendService ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-fg-mut">
                  {t("empty", "ingressDefaultBackendOnly")}{" "}
                  <ResourceRef
                    kind={ResourceType.Service}
                    name={fallback.backendService}
                    namespace={ingress?.namespace}
                    showKind={false}
                  />
                  <span className="font-mono text-fg-fnt">
                    :{fallback.backendPort}
                  </span>
                </p>
                {behind && (
                  <p className="max-w-[80ch] text-[11px] text-fg-fnt">
                    {t("count", "ingressProxyHosts", {
                      vendor: behind.vendor,
                      n: behind.hosts,
                    })}{" "}
                    <Link
                      {...behind.to}
                      className="text-info underline-offset-2 hover:underline"
                    >
                      {t("empty", "itsPage")}
                    </Link>
                    .
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-fg-fnt">
                {t("empty", "ingressNoRulesNoDefault")}
              </p>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Backend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule, ruleIdx) => {
                  const isWildcard = rule.host === "*" || !rule.host;
                  const covered =
                    covers(tlsHosts, rule.host) || hasCatchAllTls
                      ? true
                      : terminatedByVendor(rule.host);
                  return [
                    // The host is context for the paths under it, so it is
                    // said once above them instead of on every row.
                    <TableRow
                      key={`host-${ruleIdx}`}
                      data-quiet
                      className="border-0"
                    >
                      <TableCell
                        colSpan={3}
                        className="px-2.5 pb-1 pt-3 text-[11px] text-fg-fnt"
                      >
                        <span className="font-mono text-fg-mut">
                          {isWildcard ? t("empty", "allHosts") : rule.host}
                        </span>
                        {covered === false && (
                          <span className="text-warn">
                            {" "}
                            · {t("empty", "noTls")}
                          </span>
                        )}
                        {covered === null && (
                          <span> · {t("empty", "tlsNotChecked")}</span>
                        )}
                      </TableCell>
                    </TableRow>,
                    ...rule.paths.map((path) => (
                      <TableRow key={`${ruleIdx}-${path.path}`} data-quiet>
                        <TableCell className="font-mono text-fg">
                          {path.path}
                        </TableCell>
                        <TableCell className="text-fg-fnt">
                          {path.pathType}
                        </TableCell>
                        <TableCell>
                          {path.resourceBackend ? (
                            <span className="font-mono text-fg-mut">
                              {path.resourceBackend}
                            </span>
                          ) : path.backendService ? (
                            <>
                              <ResourceRef
                                kind={ResourceType.Service}
                                name={path.backendService}
                                namespace={ingress?.namespace}
                                showKind={false}
                              />
                              <span className="font-mono text-fg-fnt">
                                :{path.backendPort}
                              </span>
                            </>
                          ) : (
                            <span className="text-warn">
                              {t("empty", "noBackend")}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "tls",
      label: "TLS",
      glyph: viewGlyph(Lock),
      content: (
        <Section>
          <SectionHeader title="TLS" count={tlsConfigs.length || undefined} />
          {tlsConfigs.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "noTlsConfigured")}
            </p>
          ) : (
            <KeyValueList
              items={tlsConfigs.map((config) => ({
                // The certificate lives in a Secret in this namespace, and
                // "which Secret holds the cert for this host" is the question
                // this tab exists to answer — so the label is the way to it.
                // `showKind` is off: the block is titled TLS and every row in
                // it is a Secret.
                label: config.secretName ? (
                  <ResourceRef
                    kind={ResourceType.Secret}
                    name={config.secretName}
                    namespace={ingress?.namespace}
                    showKind={false}
                  />
                ) : (
                  t("empty", "autoGenerated")
                ),
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span className={cn(!config.isCatchAll && "font-mono")}>
                      {config.isCatchAll
                        ? t("empty", "catchAllAppliesToRest")
                        : config.hosts.join(", ") || t("empty", "noHosts")}
                    </span>
                    {config.secretName && (
                      <CertificateLine
                        read={certificates?.get(config.secretName)}
                        hosts={config.hosts}
                      />
                    )}
                  </span>
                ),
                tone: config.isCatchAll ? ("warn" as const) : undefined,
              }))}
            />
          )}
          {/* The four objects and the sentence that says what failed. Below
              the certificate facts, because those are core and read the
              same on a cluster with nothing installed on it. */}
          {tlsConfigs.map(
            (config) =>
              config.secretName && (
                <IssuanceSection
                  key={config.secretName}
                  issuance={issuance}
                  secretName={config.secretName}
                />
              )
          )}
        </Section>
      ),
    },
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(ingress?.labels ?? {}).length}
            items={recordToKeyValues(ingress?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(ingress?.annotations ?? {}).length}
            items={recordToKeyValues(ingress?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    eventsTab(events, t, { kind: ResourceType.Ingress, name: name ?? "" }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "Ingress" }),
      yaml: ingressYaml,
      resourceKind: ResourceType.Ingress,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <>
      <ChainWatches services={chain.services} reads={[chain.key]} />
      <ResourceDetailLayout
        freshness={freshness}
        resource={ingress}
        delivery={deliveryQuery}
        share={share}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.Ingress}
        title={ingress?.name || name || ""}
        namespace={ingress?.namespace || namespace}
        createdAt={ingress?.createdAt}
        badges={
          <>
            {ingress?.className && (
              <span className="font-mono text-[11px] text-fg-mut">
                {ingress.className}
              </span>
            )}
            <span
              className={cn(
                "text-[11px]",
                tls === "no"
                  ? "text-warn"
                  : tls === "unknown"
                    ? TLS_NOT_CHECKED_TONE
                    : soonest?.tone
                      ? TONE_CLASS[soonest.tone]
                      : "text-fg-fnt"
              )}
            >
              {tls === "no"
                ? t("empty", "noTls")
                : tls === "unknown"
                  ? t("empty", "tlsNotChecked")
                  : (soonest?.tone && expiryText(soonest, t)) || "TLS"}
            </span>
          </>
        }
        onBack={goBack}
        actions={
          <DeleteAction
            kind={ResourceType.Ingress}
            name={ingress?.name || name || ""}
            namespace={ingress?.namespace || namespace}
            detail={ingress}
            intercept={intercept("Delete")}
            mutation={deleteMutation}
          />
        }
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabs={tabs}
      />
    </>
  );
}
