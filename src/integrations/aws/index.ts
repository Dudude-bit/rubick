import { Waypoints } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { ROUTING_STALE } from "../ingress";
import { crd } from "./crd";
import { ALB_SOURCES_KEY, fetchAlbSources } from "./data";
import { countGroups } from "./groups";
import { facts } from "./facts";
import { serviceEdge } from "./edge";
import { ingressTls } from "./ingress-tls";
import { mark } from "./mark";

/**
 * The AWS Load Balancer Controller — tier two.
 *
 * A separate record from the AWS one below for the reason Settings states:
 * only a vendor declaring an extension gets a row, and a cluster cannot fail
 * to be on AWS. This controller, by contrast, is a Helm chart somebody chose
 * to install — on EKS and, routinely, on clusters that are not EKS at all.
 * Naming the controller rather than the cloud is also simply more accurate
 * about what was looked for: the CRDs are the controller's, not Amazon's.
 *
 * It earns a page for a reason no other controller in this tree has: it is
 * the one that puts **several Ingresses, from several namespaces, on one load
 * balancer**. `group.name` merges their rules into a single listener, and an
 * Ingress page cannot show that — the object it shares the ALB with is in
 * another namespace and is never drawn beside it. So the page's unit is the
 * load balancer.
 *
 * `TargetGroupBinding` stays a property of the Service it names, and the
 * Service's own chain is still where a reader standing on a Service wants it.
 */
export const awsLoadBalancerController = defineVendor({
  id: "aws-load-balancer-controller",
  name: "AWS Load Balancer Controller",
  extension: {
    gives: "awsGives",
    icon: Waypoints,
    facts,
  },
  provides: { "service.edge": serviceEdge, "ingress.tls": ingressTls },
  page: {
    count: pageCount({
      queryKey: ALB_SOURCES_KEY,
      queryFn: fetchAlbSources,
      select: countGroups,
      staleTime: ROUTING_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});

/**
 * AWS — EKS.
 *
 * Tier one only. The cloud API half of EKS is the one that would also need
 * plumbing that does not exist yet: unlike GCP and Azure, the app holds no
 * AWS profile, because an EKS kubeconfig is obtained by the `aws` CLI
 * rather than by this app.
 */
export default defineVendor({
  id: "aws",
  name: "AWS",
  flavours: [
    {
      id: "eks",
      // An EKS context is the cluster's whole ARN, which also carries a
      // region and an account number — so the ARN is tested before the
      // loose word, and the loose word is what a hand-written entry uses.
      claims: (name, hasWord) => name.startsWith("arn:aws") || hasWord("eks"),
      label: "EKS",
      nameSeparator: "/",
      mark,
    },
  ],
  nodeLabels: {
    pool: ["eks.amazonaws.com/nodegroup"],
    spot: [["eks.amazonaws.com/capacityType", "spot"]],
    providerScheme: ["aws", "AWS"],
  },
});
