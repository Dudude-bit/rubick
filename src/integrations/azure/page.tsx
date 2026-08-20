/**
 * AKS add-ons: which pods can become which Azure identity.
 *
 * The page exists because the vendor record was describing a retired product.
 * aad-pod-identity was deprecated in October 2022, archived in September
 * 2023, and its managed AKS add-on left support in September 2025 — so on any
 * cluster built since, its three CRDs are absent, this app found nothing, and
 * said so, while the cluster's identities were sitting in ordinary metadata
 * the app never read.
 *
 * So the page draws the mechanism the cluster is *on*, and names the other
 * one only where it is still installed. The unit is the identity, and under
 * it the pods that can assume it — which is the sentence the reader wants and
 * which neither a ServiceAccount page nor a pod page can say, because half of
 * it is an annotation over here and half is a label over there.
 */

import { useMemo, useState } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import {
  Cell,
  Chain,
  Column,
  FilterBox,
  Finding,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { useAksPicture } from "./data";
import {
  AZURE_IDENTITY_BINDING_CRD,
  AZURE_IDENTITY_CRD,
  bindingIdentity,
  bindingSummary,
  danglingBindings,
} from "./model";
import type { FederatedAccount } from "./workload-identity";
import { useT } from "@/i18n/useT";

export default function AksAddonsPage() {
  const t = useT();
  const picture = useAksPicture();
  const [filter, setFilter] = useState("");

  const accounts = useMemo(
    () => picture.data?.workload.accounts ?? [],
    [picture.data]
  );
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return accounts;
    return accounts.filter(
      (account) =>
        account.name.toLowerCase().includes(needle) ||
        account.namespace.toLowerCase().includes(needle) ||
        account.clientId.toLowerCase().includes(needle) ||
        account.pods.some((pod) => pod.name.toLowerCase().includes(needle))
    );
  }, [accounts, filter]);

  const orphans = picture.data?.workload.findings ?? [];
  const legacy = picture.data?.legacyInstalled ?? false;
  const dangling = picture.data
    ? danglingBindings(picture.data.bindings, picture.data.identities)
    : [];

  if (picture.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadIdentities")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title={t("nav", "integrations") === "" ? "" : "AKS add-ons"}
        count={
          picture.isPending
            ? undefined
            : t("count", "identities", { n: accounts.length })
        }
        description={t("empty", "aksAddonsHint")}
      />

      {orphans.map((finding, index) => (
        <Finding
          key={index}
          tone="err"
          title={
            <>
              <span className="font-mono">{finding.pod.name}</span>{" "}
              {t("empty", "podAsksForIdentity")}
            </>
          }
        >
          {t("empty", "azureIdentityFinding1")}{" "}
          <span className="font-mono">azure.workload.identity/use: true</span>
          {t("empty", "azureIdentityFinding2")}{" "}
          <span className="font-mono">{finding.account}</span>{" "}
          {t("empty", "azureIdentityFinding3")}{" "}
          <span className="font-mono">{finding.pod.namespace}</span>{" "}
          {t("empty", "azureIdentityFinding4")}{" "}
          <span className="font-mono">azure.workload.identity/client-id</span>
          {t("empty", "azureIdentityFinding5")}
        </Finding>
      ))}

      <Section>
        <div className="mb-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder={t("action", "filterIdentitiesPlaceholder")}
            label={t("action", "filterIdentities")}
          />
        </div>

        {picture.isPending ? (
          <p className="text-xs text-fg-fnt">
            {t("empty", "readingIdentities")}
          </p>
        ) : accounts.length === 0 ? (
          <p className="max-w-[72ch] text-[11.5px] text-fg-mut">
            {t("empty", "noPodCarries")}{" "}
            <span className="font-mono">azure.workload.identity/use: true</span>
            {t("empty", "nothingFederatingToAzure")}
            {legacy
              ? t("empty", "legacyAddonInstalled")
              : t("empty", "legacyAddonNotInstalled")}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            {t("empty", "nothingMatches")}{" "}
            <span className="font-mono">{filter}</span>.
          </p>
        ) : (
          <div className="flex flex-col">
            {shown.map((account, index) => (
              <AccountRow
                key={`${account.namespace}/${account.name}`}
                account={account}
                last={index === shown.length - 1}
              />
            ))}
          </div>
        )}
      </Section>

      {legacy && (
        <Section>
          <SectionHeader
            title={t("empty", "podIdentityRetired")}
            count={picture.data?.bindings.length || undefined}
            description={t("empty", "podIdentityRetiredHint")}
          />
          {dangling.length > 0 && (
            <Finding
              tone="err"
              title={
                dangling.length === 1
                  ? t("empty", "noAzureIdentityNamed", {
                      name: bindingIdentity(dangling[0]) ?? "",
                    })
                  : t("count", "bindingsNameMissingIdentity", {
                      n: dangling.length,
                    })
              }
            >
              {t("empty", "bindingAcceptedPrefix")}{" "}
              <span className="font-mono">AzureAssignedIdentity</span>
              {t("empty", "bindingAcceptedSuffix")}
            </Finding>
          )}
          <div className="mt-2 flex flex-col gap-1.5">
            {picture.data?.bindings.map((binding) => (
              <Chain key={`${binding.namespace}/${binding.name}`}>
                <Column label={t("columns", "binding")}>
                  <Cell under={binding.namespace ?? undefined}>
                    <ResourceRef
                      kind="AzureIdentityBinding"
                      name={binding.name}
                      namespace={binding.namespace}
                      crd={AZURE_IDENTITY_BINDING_CRD}
                      showKind={false}
                    />
                  </Cell>
                </Column>
                <Column label={t("columns", "says")}>
                  <Cell
                    bad={dangling.includes(binding)}
                    title={bindingSummary(binding)}
                  >
                    {bindingSummary(binding)}
                  </Cell>
                </Column>
                <Column label={t("columns", "identity")}>
                  <Cell bad={dangling.includes(binding)}>
                    {bindingIdentity(binding) ? (
                      <ResourceRef
                        kind="AzureIdentity"
                        name={bindingIdentity(binding)!}
                        namespace={binding.namespace}
                        crd={AZURE_IDENTITY_CRD}
                        showKind={false}
                      />
                    ) : (
                      t("empty", "namesNone")
                    )}
                  </Cell>
                </Column>
              </Chain>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function accountState(
  account: FederatedAccount,
  t: ReturnType<typeof useT>
): {
  text: string;
  tone: Tone;
} {
  if (account.pods.length === 0) {
    return { text: t("empty", "noPodUsesIt"), tone: "warn" };
  }
  return {
    text: t("cluster", "podCount", { n: account.pods.length }),
    tone: "ok",
  };
}

function AccountRow({
  account,
  last,
}: {
  account: FederatedAccount;
  last: boolean;
}) {
  const t = useT();
  return (
    <TroubleRow
      title={<span className="font-mono">{account.name}</span>}
      meta={
        <>
          {account.namespace}
          {account.tenantId &&
            t("empty", "tenantMeta", { id: account.tenantId })}
        </>
      }
      state={accountState(account, t)}
      last={last}
    >
      <Chain>
        <Column label="ServiceAccount">
          <Cell under={account.namespace}>
            <span className="font-mono">{account.name}</span>
          </Cell>
        </Column>
        <Column label={t("columns", "clientId")}>
          <Cell title={account.clientId}>
            <span className="font-mono">{account.clientId}</span>
          </Cell>
        </Column>
        <Column label={t("columns", "assumedBy")}>
          {account.pods.length === 0 ? (
            <Cell warn>
              <span className="text-fg-fnt">
                {t("empty", "noPodCarriesLabel")}
              </span>
            </Cell>
          ) : (
            account.pods.map((pod) => (
              <Cell key={`${pod.namespace}/${pod.name}`} under={pod.namespace}>
                <ResourceRef
                  kind={ResourceType.Pod}
                  name={pod.name}
                  namespace={pod.namespace}
                  showKind={false}
                />
              </Cell>
            ))
          )}
        </Column>
      </Chain>
    </TroubleRow>
  );
}
