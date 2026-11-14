import type { AuditFinding, RuleId, What } from "@/generated/types";

/**
 * A YAML fragment that fixes a finding, laid out at the path the object's
 * kind keeps its pod spec at and naming the container it is about, so it
 * can be merged as it is. Field names are the API's and are never
 * translated; nothing here is a sentence.
 */

/** Where each kind keeps its pod spec. */
const POD_SPEC: Record<string, string[]> = {
  Pod: ["spec"],
  Deployment: ["spec", "template", "spec"],
  StatefulSet: ["spec", "template", "spec"],
  DaemonSet: ["spec", "template", "spec"],
  ReplicaSet: ["spec", "template", "spec"],
  Job: ["spec", "template", "spec"],
  CronJob: ["spec", "jobTemplate", "spec", "template", "spec"],
};

const indent = (text: string, depth: number) =>
  text
    .split("\n")
    .map((line) => (line ? "  ".repeat(depth) + line : line))
    .join("\n");

/** `body` placed under the pod spec of `kind`. */
function underPodSpec(kind: string, body: string): string {
  const path = POD_SPEC[kind] ?? POD_SPEC.Deployment;
  const head = path.map((key, depth) => `${"  ".repeat(depth)}${key}:`);
  return [...head, indent(body, path.length)].join("\n");
}

/** The first container a finding names, or a placeholder name. */
function containerOf(finding: AuditFinding | undefined): {
  list: string;
  name: string;
} {
  for (const what of finding?.what ?? []) {
    const at = "at" in what ? what.at : null;
    if (at) return { list: at.list, name: at.container };
  }
  return { list: "containers", name: "app" };
}

const inContainer = (
  finding: AuditFinding | undefined,
  body: string
): string => {
  const { list, name } = containerOf(finding);
  return `${list}:\n  - name: ${name}\n${indent(body, 2)}`;
};

const securityContext = (finding: AuditFinding | undefined, body: string) =>
  inContainer(finding, `securityContext:\n${indent(body, 1)}`);

const first = <S extends What["says"]>(
  finding: AuditFinding | undefined,
  says: S
): Extract<What, { says: S }> | undefined =>
  finding?.what.find(
    (what): what is Extract<What, { says: S }> => what.says === says
  );

/** The fix for `rule` on an object of `kind`, filled from `finding` where it has one. */
export function fixYaml(
  rule: RuleId,
  kind: string,
  finding?: AuditFinding
): string {
  const pod = (body: string) => underPodSpec(kind, body);
  const volume =
    first(finding, "volume")?.volume ??
    first(finding, "socket")?.volume ??
    "data";
  switch (rule) {
    case "pss-host-process":
      return pod("securityContext:\n  windowsOptions:\n    hostProcess: false");
    case "pss-host-namespaces":
      return pod("hostNetwork: false\nhostPID: false\nhostIPC: false");
    case "pss-privileged":
      return pod(securityContext(finding, "privileged: false"));
    case "pss-capabilities":
    case "pss-drop-capabilities":
      return pod(
        securityContext(
          finding,
          'capabilities:\n  drop: ["ALL"]\n  add: ["NET_BIND_SERVICE"]'
        )
      );
    case "pss-host-path":
    case "pss-volume-types":
    case "runtime-socket":
      return pod(
        `volumes:\n  - name: ${volume}\n    persistentVolumeClaim:\n      claimName: ${volume}`
      );
    case "pss-host-ports":
      return pod(inContainer(finding, "ports:\n  - containerPort: 8080"));
    case "pss-host-probes":
      return pod(
        inContainer(
          finding,
          "readinessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080"
        )
      );
    case "pss-apparmor":
      return pod(
        "securityContext:\n  appArmorProfile:\n    type: RuntimeDefault"
      );
    case "pss-selinux":
      return pod("securityContext:\n  seLinuxOptions:\n    type: container_t");
    case "pss-proc-mount":
      return pod(securityContext(finding, "procMount: Default"));
    case "pss-seccomp-unconfined":
    case "pss-seccomp-required":
      return pod(
        "securityContext:\n  seccompProfile:\n    type: RuntimeDefault"
      );
    case "pss-sysctls":
      return pod(
        'securityContext:\n  sysctls:\n    - name: net.ipv4.ip_local_port_range\n      value: "32768 60999"'
      );
    case "pss-privilege-escalation":
      return pod(securityContext(finding, "allowPrivilegeEscalation: false"));
    case "pss-run-as-non-root":
      return pod("securityContext:\n  runAsNonRoot: true\n  runAsUser: 10001");
    case "pss-run-as-user-root":
      return pod("securityContext:\n  runAsUser: 10001\n  runAsGroup: 10001");
    case "config-map-private-key": {
      const key = first(finding, "key")?.key ?? "tls.key";
      return `apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-tls\ntype: Opaque\nstringData:\n  ${key}: ""`;
    }
    case "env-secret-literal": {
      const variable = first(finding, "envLiteral")?.variable ?? "PASSWORD";
      return pod(
        inContainer(
          finding,
          `env:\n  - name: ${variable}\n    valueFrom:\n      secretKeyRef:\n        name: app\n        key: ${variable.toLowerCase()}`
        )
      );
    }
    case "writable-root-filesystem":
      return pod(
        `${securityContext(finding, "readOnlyRootFilesystem: true")}\n${indent("volumeMounts:\n  - name: tmp\n    mountPath: /tmp", 2)}\nvolumes:\n  - name: tmp\n    emptyDir: {}`
      );
    case "cluster-admin-binding":
      return 'apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: app\nrules:\n  - apiGroups: ["apps"]\n    resources: ["deployments"]\n    verbs: ["get", "list", "watch"]';
    case "wildcard-role":
      return 'rules:\n  - apiGroups: [""]\n    resources: ["configmaps"]\n    verbs: ["get", "list", "watch"]';
    case "default-service-account-token":
      return pod(
        "serviceAccountName: app\nautomountServiceAccountToken: false"
      );
    case "namespace-without-network-policy":
      return "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny-ingress\nspec:\n  podSelector: {}\n  policyTypes:\n    - Ingress";
    case "no-readiness-probe":
      return pod(
        inContainer(
          finding,
          "readinessProbe:\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 5"
        )
      );
    case "no-liveness-probe":
      return pod(
        inContainer(
          finding,
          "livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  periodSeconds: 10\n  failureThreshold: 3"
        )
      );
    case "image-tag-latest": {
      const image = first(finding, "image")?.image ?? "app";
      const name = image.replace(/(:latest)?$/, "");
      return pod(inContainer(finding, `image: ${name}:1.2.3`));
    }
    case "single-replica":
      return "spec:\n  replicas: 2";
    case "no-disruption-budget":
      return "apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: app\nspec:\n  maxUnavailable: 1\n  selector:\n    matchLabels:\n      app: app";
    case "budget-blocks-disruption":
      return "spec:\n  maxUnavailable: 1";
    case "no-spread":
      return pod(
        "topologySpreadConstraints:\n  - maxSkew: 1\n    topologyKey: kubernetes.io/hostname\n    whenUnsatisfiable: ScheduleAnyway\n    labelSelector:\n      matchLabels:\n        app: app"
      );
    case "no-memory-limit":
      return pod(
        inContainer(finding, "resources:\n  limits:\n    memory: 256Mi")
      );
    case "autoscaler-pinned":
      return "spec:\n  minReplicas: 2\n  maxReplicas: 6";
    case "autoscaler-target-missing": {
      const target = first(finding, "target");
      return `spec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: ${target?.kind ?? "Deployment"}\n    name: ""`;
    }
    case "no-cpu-request":
      return pod(
        inContainer(finding, "resources:\n  requests:\n    cpu: 100m")
      );
    case "no-memory-request":
      return pod(
        inContainer(finding, "resources:\n  requests:\n    memory: 128Mi")
      );
  }
}
