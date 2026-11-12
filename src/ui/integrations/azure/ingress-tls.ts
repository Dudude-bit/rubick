/**
 * Whether an AGIC Ingress serves a host over TLS.
 *
 * The Application Gateway Ingress Controller reads `spec.tls`, and also — and
 * in preference to it — a certificate already installed on the Application
 * Gateway and named in an annotation. The docs are explicit that the
 * annotation is *ignored* when `spec.tls` is present, which makes the two
 * mutually exclusive rather than additive: an Ingress with the annotation and
 * no `spec.tls` is the ordinary AGIC shape, and it read as plain HTTP
 * everywhere in this app.
 */

import { commands } from "@/lib/commands";
import type { IngressClassSummary, IngressInfo } from "@/generated/types";
import type { IngressTls } from "../registry";
import {
  claimsIngress as classClaims,
  readClasses,
  tlsUnread,
  type ClassesRead,
} from "../ingress";

const PREFIX = "appgw.ingress.kubernetes.io/";
const SSL_CERTIFICATE = `${PREFIX}appgw-ssl-certificate`;
const SSL_REDIRECT = `${PREFIX}ssl-redirect`;
const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";

/**
 * What AGIC answers to: the value of the legacy annotation, and the
 * `spec.controller` of the IngressClass it installs. Never a class's name,
 * which cannot hold a slash: that one is `azure-application-gateway`.
 */
const AGIC_CLASS = "azure/application-gateway";

/**
 * Whether AGIC serves this Ingress. The annotation first, as AGIC reads it;
 * then the class `spec.ingressClassName` names, by its controller, and no
 * class at all where AGIC's is the default. `null` where only the
 * IngressClass list could say and it was not read.
 */
export function claimsIngress(
  ingress: Pick<IngressInfo, "className" | "annotations">,
  classes: IngressClassSummary[] | null
): boolean | null {
  const annotated = ingress.annotations[INGRESS_CLASS_ANNOTATION];
  if (annotated) return annotated === AGIC_CLASS;
  return classes && classClaims(ingress, classes, AGIC_CLASS);
}

export async function ingressTls(
  wanted: Array<{ namespace: string; name: string; hosts: string[] }>
): Promise<IngressTls[][]> {
  // One `get` per Ingress the caller named, and never one per host. A list
  // page asks for every row at once; a detail page asks for one.
  const read = await readClasses();
  return Promise.all(
    wanted.map((input) =>
      answerFor(input, read).catch((error) => tlsUnread(input.hosts, error))
    )
  );
}

async function answerFor(
  input: { namespace: string; name: string; hosts: string[] },
  read: ClassesRead
): Promise<IngressTls[]> {
  const ingress = await commands.getIngress(input.name, input.namespace);
  const mine = claimsIngress(ingress, read.classes);
  if (mine === null) return tlsUnread(input.hosts, read.error);
  if (!mine) return [];

  const certificate = ingress.annotations[SSL_CERTIFICATE];
  if (certificate !== undefined && certificate !== "") {
    return input.hosts.map((host) => ({
      host,
      terminated: true,
      by: {
        key: "azureCertOnGateway",
        values: { name: certificate },
      },
    }));
  }
  // A redirect to HTTPS is only ever created beside a listener to redirect
  // to, so it is evidence of one — but of a listener, not of which
  // certificate, which is why nothing is named.
  if (ingress.annotations[SSL_REDIRECT] === "true") {
    return input.hosts.map((host) => ({
      host,
      terminated: true,
      by: { key: "azureSomeCertOnGateway" },
    }));
  }
  return [];
}
