import { describe, expect, it } from "vite-plus/test";

import { refusalReason } from "./refusal-reason";

const RESTRICTED =
  'Error creating: pods "root-web-d786dc494-8fv4j" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "sleeper" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "sleeper" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "sleeper" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "sleeper" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")';

describe("refusalReason", () => {
  /** The words a k3s 1.35 API server answered a restricted namespace with; a split at every comma breaks the quoted `["ALL"]` and the two profile types apart. */
  it("reads a PodSecurity refusal as its level and each check with how to pass it", () => {
    expect(refusalReason(RESTRICTED)).toEqual({
      by: "podSecurity",
      level: "restricted",
      version: "latest",
      checks: [
        {
          check: "allowPrivilegeEscalation != false",
          how: 'container "sleeper" must set securityContext.allowPrivilegeEscalation=false',
        },
        {
          check: "unrestricted capabilities",
          how: 'container "sleeper" must set securityContext.capabilities.drop=["ALL"]',
        },
        {
          check: "runAsNonRoot != true",
          how: 'pod or container "sleeper" must set securityContext.runAsNonRoot=true',
        },
        {
          check: "seccompProfile",
          how: 'pod or container "sleeper" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost"',
        },
      ],
    });
  });

  /** A StatefulSet words its event differently and a pinned version is not `latest`; a check naming several containers keeps them in one item. */
  it("reads a pinned baseline level from a StatefulSet's event", () => {
    expect(
      refusalReason(
        'Create Pod db-0 in StatefulSet db failed error: pods "db-0" is forbidden: violates PodSecurity "baseline:v1.33": host namespaces (hostNetwork=true, hostPID=true), hostPath volumes (volume "root"), privileged (containers "peek", "tail" must not set securityContext.privileged=true)'
      )
    ).toEqual({
      by: "podSecurity",
      level: "baseline",
      version: "v1.33",
      checks: [
        { check: "host namespaces", how: "hostNetwork=true, hostPID=true" },
        { check: "hostPath volumes", how: 'volume "root"' },
        {
          check: "privileged",
          how: 'containers "peek", "tail" must not set securityContext.privileged=true',
        },
      ],
    });
  });

  /** The used and limited lists end at a comma and a space; a greedy read keeps the comma in the number. */
  it("reads an exceeded quota as each resource with what is asked, used and allowed", () => {
    expect(
      refusalReason(
        'pods "capped-6d67bcbdbc-bl2gn" is forbidden: exceeded quota: two-pods, requested: pods=1,requests.cpu=500m, used: pods=2,requests.cpu=1, limited: pods=2,requests.cpu=2'
      )
    ).toEqual({
      by: "quotaExceeded",
      quota: "two-pods",
      over: [
        { resource: "pods", requested: "1", used: "2", limited: "2" },
        {
          resource: "requests.cpu",
          requested: "500m",
          used: "1",
          limited: "2",
        },
      ],
    });
  });

  /** Since 1.27 the API server names the containers that left each resource unset; before, only the resources. */
  it.each([
    [
      "must specify limits.cpu for: app; limits.memory for: app,sidecar",
      [
        { resource: "limits.cpu", containers: ["app"] },
        { resource: "limits.memory", containers: ["app", "sidecar"] },
      ],
    ],
    [
      "must specify limits.cpu,limits.memory",
      [
        { resource: "limits.cpu", containers: [] },
        { resource: "limits.memory", containers: [] },
      ],
    ],
  ])("reads a quota that needs a resource set from %j", (tail, unset) => {
    expect(
      refusalReason(
        `pods "unbounded-8f8bd5d6-bcrk9" is forbidden: failed quota: compute: ${tail}`
      )
    ).toEqual({ by: "quotaUnset", quota: "compute", unset });
  });

  /** Several bounds arrive as one bracketed list, and a bound with nothing set has no number after it. */
  it("reads every bound a LimitRange holds the template to", () => {
    expect(
      refusalReason(
        'pods "greedy-ddc468465-hdsd6" is forbidden: [maximum cpu usage per Container is 500m, but limit is 1, maximum memory usage per Container is 256Mi, but limit is 512Mi, minimum memory usage per Pod is 64Mi.  No request is specified]'
      )
    ).toEqual({
      by: "limitRange",
      bounds: [
        {
          bound: "maximum",
          resource: "cpu",
          per: "Container",
          allowed: "500m",
          asked: "1",
        },
        {
          bound: "maximum",
          resource: "memory",
          per: "Container",
          allowed: "256Mi",
          asked: "512Mi",
        },
        {
          bound: "minimum",
          resource: "memory",
          per: "Pod",
          allowed: "64Mi",
          asked: null,
        },
      ],
    });
  });

  /** The pod name is cut at the dash where no pod was ever generated. */
  it("reads a missing ServiceAccount with its namespace", () => {
    expect(
      refusalReason(
        'Error creating: pods "lost-sa-5d659d7bd7-" is forbidden: error looking up service account refused-sa/ghost: serviceaccount "ghost" not found'
      )
    ).toEqual({ by: "serviceAccount", namespace: "refused-sa", name: "ghost" });
  });

  it("reads an admission policy's denial with its binding and message", () => {
    expect(
      refusalReason(
        "Error creating: pods \"unlabeled-cbbf4cf64-fndqd\" is forbidden: ValidatingAdmissionPolicy 'require-team-label' with binding 'require-team-label-binding' denied request: every pod needs a team label"
      )
    ).toEqual({
      by: "policy",
      policy: "require-team-label",
      binding: "require-team-label-binding",
      said: "every pod needs a team label",
    });
  });

  it.each([
    [
      'admission webhook "pods.guard.example.com" denied the request: images must come from registry.example.com',
      "images must come from registry.example.com",
    ],
    [
      'admission webhook "pods.guard.example.com" denied the request without explanation',
      "",
    ],
  ])("reads a webhook's denial from %j", (tail, said) => {
    expect(refusalReason(`pods "web-1" is forbidden: ${tail}`)).toEqual({
      by: "webhookDenied",
      webhook: "pods.guard.example.com",
      said,
    });
  });

  /** An unreachable webhook is an internal error, not a forbidden pod, and its address names the Service behind it. */
  it("reads a webhook the API server could not call, with the Service it calls", () => {
    expect(
      refusalReason(
        'Error creating: Internal error occurred: failed calling webhook "pods.guard.example.com": failed to call webhook: Post "https://guard.refused-hook.svc:443/validate?timeout=10s": service "guard" not found'
      )
    ).toEqual({
      by: "webhookFailed",
      webhook: "pods.guard.example.com",
      service: { name: "guard", namespace: "refused-hook" },
      said: 'Post "https://guard.refused-hook.svc:443/validate?timeout=10s": service "guard" not found',
    });
  });

  it("reads a namespace being deleted", () => {
    expect(
      refusalReason(
        'pods "web-1" is forbidden: unable to create new content in namespace shop because it is being terminated'
      )
    ).toEqual({ by: "terminating", namespace: "shop" });
  });

  /** Anything else is quoted as it is rather than guessed at. */
  it("knows no reason in an answer it does not recognise", () => {
    expect(
      refusalReason('pods "web-1" is forbidden: node "a" not ready')
    ).toEqual({ by: "unknown" });
  });
});
