import type { AuditFinding, RuleId, Subject, What } from "@/generated/types";

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

const atContainer = (finding: AuditFinding | undefined) =>
  finding?.what.some((what) => "at" in what && what.at !== null) ?? false;

/**
 * A pod-level setting, or the container's own where the finding was made
 * at a container: a container's securityContext overrides the pod's, so a
 * pod-level fix leaves that container as it was.
 */
const podOrContainer = (finding: AuditFinding | undefined, body: string) =>
  atContainer(finding)
    ? securityContext(finding, body)
    : `securityContext:\n${indent(body, 1)}`;

const first = <S extends What["says"]>(
  finding: AuditFinding | undefined,
  says: S
): Extract<What, { says: S }> | undefined =>
  finding?.what.find(
    (what): what is Extract<What, { says: S }> => what.says === says
  );

/** Pod Security Admission, which took PodSecurityPolicy's place, on a namespace. */
const ADMISSION =
  "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: app\n  labels:\n    pod-security.kubernetes.io/enforce: baseline";

/** Each kind a finding names at a version going away, at the version that replaces it. */
function replaced(finding: AuditFinding | undefined, kind: string): string[] {
  const seen = new Set<string>();
  for (const what of finding?.what ?? []) {
    const removal =
      what.says === "stored" || what.says === "written" ? what.removal : null;
    if (!removal) continue;
    const named = what.says === "stored" ? what.kind : kind;
    seen.add(
      removal.replacement === null
        ? ADMISSION
        : `apiVersion: ${removal.replacement}\nkind: ${named}`
    );
  }
  return [...seen];
}

/** A shell word as written, quoted where the shell would read it otherwise. */
const word = (text: string) =>
  /^[\w.:/@=+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The fix for `rule` on an object of `kind`, filled from `finding` where it
 * has one. A command names `context`, the cluster on screen: without it
 * kubectl and helm act on whatever their kubeconfig's current context is,
 * which may be another cluster with an object of the same name.
 */
export function fixYaml(
  rule: RuleId,
  kind: string,
  finding?: AuditFinding,
  subject?: Subject,
  context?: string | null
): string {
  const pod = (body: string) => underPodSpec(kind, body);
  const on = word(context ?? "CONTEXT");
  const kubectl = `kubectl --context ${on}`;
  const volume =
    first(finding, "volume")?.volume ??
    first(finding, "socket")?.volume ??
    "data";
  // An ephemeral container cannot be changed or removed once added
  // (concepts/workloads/pods/ephemeral-containers): it goes with its pod.
  if (
    atContainer(finding) &&
    containerOf(finding).list === "ephemeralContainers"
  )
    return `${kubectl} delete pod ${subject?.name ?? "POD"} --namespace ${subject?.namespace ?? "NAMESPACE"}`;
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
        podOrContainer(finding, "appArmorProfile:\n  type: RuntimeDefault")
      );
    case "pss-selinux":
      return pod(
        podOrContainer(finding, "seLinuxOptions:\n  type: container_t")
      );
    case "pss-proc-mount":
      return pod(securityContext(finding, "procMount: Default"));
    case "pss-seccomp-unconfined":
    case "pss-seccomp-required":
      return pod(
        podOrContainer(finding, "seccompProfile:\n  type: RuntimeDefault")
      );
    case "pss-sysctls":
      return pod(
        'securityContext:\n  sysctls:\n    - name: net.ipv4.ip_local_port_range\n      value: "32768 60999"'
      );
    case "pss-privilege-escalation":
      return pod(securityContext(finding, "allowPrivilegeEscalation: false"));
    case "pss-run-as-non-root":
      return pod(
        podOrContainer(finding, "runAsNonRoot: true\nrunAsUser: 10001")
      );
    case "pss-run-as-user-root":
      return pod(
        podOrContainer(finding, "runAsUser: 10001\nrunAsGroup: 10001")
      );
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
    case "single-replica": {
      // An autoscaler's floor is the replica count; the workload's is overridden.
      const autoscaler = first(finding, "replicas")?.autoscaler;
      return autoscaler
        ? `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: ${autoscaler}\nspec:\n  minReplicas: 2`
        : "spec:\n  replicas: 2";
    }
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
    case "removed-api-in-helm-release": {
      const gone =
        !finding || finding.what.some((w) => w.says === "stored" && !w.served);
      const map = gone
        ? [
            `helm plugin install https://github.com/helm/helm-mapkubeapis\nhelm mapkubeapis ${subject?.name ?? "RELEASE"} --namespace ${subject?.namespace ?? "NAMESPACE"} --kube-context ${on}`,
          ]
        : [];
      return [...map, ...replaced(finding, kind)].join("\n---\n");
    }
    case "deprecated-api-writer":
      return (
        replaced(finding, kind).join("\n---\n") ||
        `apiVersion: apps/v1\nkind: ${kind}`
      );
    case "crd-version-deprecated": {
      const at = first(finding, "storedAs");
      const storage = at?.storage ?? at?.current[0] ?? "v1";
      const held = finding?.what.some(
        (w) => w.says === "deprecated" && w.stored && !w.storage
      );
      if (held) {
        const crd = subject?.name ?? "CRD";
        return `${kubectl} get ${crd} --all-namespaces -o json | ${kubectl} replace -f -\n${kubectl} patch customresourcedefinitions ${crd} --subresource='status' --type='merge' -p '{"status":{"storedVersions":["${storage}"]}}'`;
      }
      const current =
        at?.current.find((v) => v === at.storage) ?? at?.current[0] ?? storage;
      return `apiVersion: ${at?.group ?? "example.com"}/${current}\nkind: ${at?.kind ?? "Kind"}`;
    }
    case "requests-above-usage": {
      const over = finding?.what.filter(
        (w): w is Extract<What, { says: "overRequested" }> =>
          w.says === "overRequested"
      );
      const cpu = !over?.length || over.some((w) => w.resource === "cpu");
      const memory = !over?.length || over.some((w) => w.resource === "memory");
      const lines = [
        ...(cpu ? ["    cpu: 100m"] : []),
        ...(memory ? ["    memory: 128Mi"] : []),
      ];
      return pod(
        inContainer(finding, ["resources:", "  requests:", ...lines].join("\n"))
      );
    }
    case "deprecated-api-requested": {
      const asked = first(finding, "requested");
      if (asked?.kind && asked.replacement)
        return `apiVersion: ${asked.replacement}\nkind: ${asked.kind}`;
      const group = (subject?.name ?? "")
        .split(" ")[0]
        .split("/")
        .slice(0, -1)
        .join("/");
      return `${kubectl} api-resources --api-group=${group}`;
    }
  }
}
