import { useCallback } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useQuery } from "@tanstack/react-query";
import { Table2, Tag } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import { secretKeysSection, secretTypeOf } from "@/lib/share/secret-share";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "../../../-object/yaml-tab";
import { connectionsTab } from "../../../-object/connections-tab";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { CertificateSection } from "../../../-object/CertificateFacts";
import { DataSection } from "../../../-object/data-rows";
import { IssuanceSection } from "@/components/object/IssuanceChain";
import { KeyValueSection } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useResourceDetail } from "@/hooks";
import { useObjectConnections } from "@/hooks/useConnections";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { SecretInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";

export function SecretDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: secret,
    isLoading,
    error,
    yaml: secretYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<SecretInfo>({
    resourceKind: ResourceType.Secret,
    fetchResource: (name, ns) => commands.getSecret(name, ns),
    deleteResource: (name, ns) => commands.deleteSecret(name, ns),
    defaultTab: "data",
  });

  const events = useObjectEvents(ResourceType.Secret, name, namespace, {
    refresh: "slow",
  });

  const connections = useObjectConnections(
    ResourceType.Secret,
    name,
    namespace
  );

  const { data: secretData, isLoading: isDataLoading } = useQuery({
    queryKey: queryKeys.secretData(namespace, name),
    queryFn: () => commands.getSecretData(name!, namespace ?? null),
    enabled: !!name && !!namespace,
  });

  const isTls = secret?.type === "kubernetes.io/tls";
  const tlsSecretName = isTls && name ? [name] : [];
  const certificates = useTlsCertificates(namespace, tlsSecretName);
  const issuance = useCertificateIssuance(namespace, tlsSecretName);

  const deliveryQuery = deliveryOfKind(ResourceType.Secret, secret);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const share = useCallback((): ShareContribution => {
    if (!secret) return {};
    return {
      status: secretTypeOf(secret),
      sections: [secretKeysSection(secret.dataKeys, t)],
    };
  }, [secret, t]);

  if (!secret && !isLoading && !error) {
    return null;
  }

  const dataKeys = secret?.dataKeys ?? [];
  const labels = secret?.labels ?? {};
  const annotations = secret?.annotations ?? {};
  // The prefix is the same on every built-in type and only pushes the part
  // that differs off the end of the badge.
  const secretType = (secret?.type ?? "Opaque").replace("kubernetes.io/", "");

  const tabs = [
    {
      id: "data",
      label: t("columns", "data"),
      glyph: viewGlyph(Table2),
      mark: countMark(dataKeys.length),
      content: (
        <>
          {/* First, and in this tab rather than one of its own: on a TLS
              Secret the certificate is what the page is about and the keys
              under it are how it is stored. A Secret that is not one has no
              certificate to show, and an Overview tab that was empty on every
              Opaque Secret in the cluster would be worse than no tab. */}
          {isTls && name && (
            <>
              <CertificateSection read={certificates?.get(name)} />
              {/* Core first and whole; the extension adds why, or nothing. */}
              <IssuanceSection issuance={issuance} secretName={name} />
            </>
          )}

          <DataSection
            data={secretData?.values ?? {}}
            withheld={secretData?.withheld}
            binary={secretData?.binary}
            keys={dataKeys}
            sensitive
            isLoading={isDataLoading}
            emptyMessage={t("empty", "kindHoldsNoKeys", { kind: "Secret" })}
          />
        </>
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(labels).length}
            items={recordToKeyValues(labels)}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(annotations).length}
            items={recordToKeyValues(annotations)}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    eventsTab(events, t, { kind: ResourceType.Secret, name: name ?? "" }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "Secret" }),
      yaml: secretYaml,
      resourceKind: ResourceType.Secret,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={secret}
      share={share}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Secret}
      title={secret?.name || name || ""}
      namespace={secret?.namespace || namespace}
      createdAt={secret?.createdAt}
      statusBadge={
        secret && (
          // The type is a classification, not a health state: it gets the
          // neutral role rather than borrowing a status colour.
          <StatusBadge status={secretType} roleOverride="neutral" />
        )
      }
      badges={
        <span className="text-[11px] text-fg-fnt">
          {t("count", "keys", { n: dataKeys.length })}
        </span>
      }
      onBack={goBack}
      actions={
        <DeleteAction
          kind={ResourceType.Secret}
          name={secret?.name || name || ""}
          namespace={secret?.namespace || namespace}
          detail={secret}
          intercept={intercept("Delete")}
          mutation={deleteMutation}
        />
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
