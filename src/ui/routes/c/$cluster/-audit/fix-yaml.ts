import type { AuditFinding, RuleId, Subject, What } from "@/generated/types";
import { cliLine, cliPipe, type CliTarget } from "@/lib/kubectl";

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

type Seat = { list: string; name: string };

/** Every container a finding names, each once, in the order it names them. */
function containersOf(finding: AuditFinding | undefined): Seat[] {
  const seats: Seat[] = [];
  for (const what of finding?.what ?? []) {
    const at = "at" in what ? what.at : null;
    if (at && !seats.some((s) => s.list === at.list && s.name === at.container))
      seats.push({ list: at.list, name: at.container });
  }
  return seats.length > 0 ? seats : [containerOf(finding)];
}

/**
 * `body` for each container a finding names, under the list each is in: a
 * finding about two containers is fixed in both, not in the first alone.
 */
function eachContainer(
  finding: AuditFinding | undefined,
  body: (seat: Seat) => string
): string {
  const seats = containersOf(finding);
  const lists = [...new Set(seats.map((seat) => seat.list))];
  return lists
    .map((list) =>
      [
        `${list}:`,
        ...seats
          .filter((seat) => seat.list === list)
          .map((seat) => `  - name: ${seat.name}\n${indent(body(seat), 2)}`),
      ].join("\n")
    )
    .join("\n");
}

const inContainer = (finding: AuditFinding | undefined, body: string) =>
  eachContainer(finding, () => body);

/** The witnesses of `says` a finding holds at one container. */
const at = <S extends What["says"]>(
  finding: AuditFinding | undefined,
  says: S,
  seat: Seat
): Extract<What, { says: S }>[] =>
  (finding?.what ?? []).filter(
    (what): what is Extract<What, { says: S }> =>
      what.says === says &&
      "at" in what &&
      what.at?.list === seat.list &&
      what.at.container === seat.name
  );

const securityContext = (finding: AuditFinding | undefined, body: string) =>
  inContainer(finding, `securityContext:\n${indent(body, 1)}`);

const atContainer = (finding: AuditFinding | undefined) =>
  finding?.what.some((what) => "at" in what && what.at !== null) ?? false;

/**
 * A pod-level setting, or the container's own where the finding was made
 * at a container: a container's securityContext overrides the pod's, so a
 * pod-level fix leaves that container as it was.
 */
const podOrContainer = (finding: AuditFinding | undefined, body: string) => {
  const atPod = `securityContext:\n${indent(body, 1)}`;
  if (!atContainer(finding)) return atPod;
  // Made at the pod as well as at a container: both are set.
  const alsoPod = finding?.what.some(
    (what) => "at" in what && what.at === null
  );
  return [alsoPod ? atPod : null, securityContext(finding, body)]
    .filter(Boolean)
    .join("\n");
};

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

/**
 * The fix for `rule` on an object of `kind`, filled from `finding` where it
 * has one. A command is a {@link cliLine} against `cli`, the cluster on
 * screen and the files the app read it from.
 */
export function fixYaml(
  rule: RuleId,
  kind: string,
  finding?: AuditFinding,
  subject?: Subject,
  cli: CliTarget = { context: null, files: null }
): string {
  const pod = (body: string) => underPodSpec(kind, body);
  const kubectl = (args: string) => cliLine("kubectl", cli, args);
  const volume =
    first(finding, "volume")?.volume ??
    first(finding, "socket")?.volume ??
    "data";
  // An ephemeral container cannot be changed or removed once added
  // (concepts/workloads/pods/ephemeral-containers): it goes with its pod,
  // whichever of the containers a finding names it is.
  if (
    atContainer(finding) &&
    containersOf(finding).some((seat) => seat.list === "ephemeralContainers")
  )
    return kubectl(
      `delete pod ${subject?.name ?? "POD"} --namespace ${subject?.namespace ?? "NAMESPACE"}`
    );
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
      const fromSecret = (variable: string) =>
        `  - name: ${variable}\n    valueFrom:\n      secretKeyRef:\n        name: app\n        key: ${variable.toLowerCase()}`;
      return pod(
        eachContainer(finding, (seat) => {
          const named = at(finding, "envLiteral", seat).map((w) => w.variable);
          const variables = named.length > 0 ? named : ["PASSWORD"];
          return `env:\n${variables.map(fromSecret).join("\n")}`;
        })
      );
    }
    case "writable-root-filesystem":
      return pod(
        `${inContainer(finding, "securityContext:\n  readOnlyRootFilesystem: true\nvolumeMounts:\n  - name: tmp\n    mountPath: /tmp")}\nvolumes:\n  - name: tmp\n    emptyDir: {}`
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
    case "image-tag-latest":
      return pod(
        eachContainer(finding, (seat) => {
          const image = at(finding, "image", seat)[0]?.image ?? "app";
          return `image: ${image.replace(/(:latest)?$/, "")}:1.2.3`;
        })
      );
    case "single-replica": {
      // An autoscaler's floor is the replica count; the workload's is
      // overridden. A ceiling under the new floor is raised with it, or the
      // API server refuses the pair.
      const replicas = first(finding, "replicas");
      const autoscaler = replicas?.autoscaler;
      const ceiling = replicas?.ceiling;
      return autoscaler
        ? `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: ${autoscaler}\nspec:\n  minReplicas: 2${ceiling !== null && ceiling !== undefined && ceiling < 2 ? "\n  maxReplicas: 2" : ""}`
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
            `helm plugin install https://github.com/helm/helm-mapkubeapis\n${cliLine("helm", cli, `mapkubeapis ${subject?.name ?? "RELEASE"} --namespace ${subject?.namespace ?? "NAMESPACE"}`)}`,
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
        // A YAML patch has no double quotes, which Windows PowerShell 5.1
        // strips from an argument it hands to a program. The patch is handed
        // out commented, in either shell: a replace that fails on one object
        // leaves it stored at the old version, and kubectl replace exits 0
        // on the nothing a failed get pipes it, so no exit code can hold the
        // patch back until every object was written back.
        return `${cliPipe(cli, [
          ["kubectl", `get ${crd} --all-namespaces -o json`],
          ["kubectl", "replace -f -"],
        ])}\n# ${kubectl(`patch customresourcedefinitions ${crd} --subresource=status --type=merge -p 'status: {storedVersions: [${storage}]}'`)}`;
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
      return kubectl(`api-resources --api-group=${group}`);
    }
  }
}
