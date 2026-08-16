/**
 * What an Argo object is connected to, in Argo's own words.
 *
 * The reason this capability exists at all. An `Application` naming forty
 * objects it manages is the most connected thing in a GitOps cluster, and
 * until now it was the one object in the app whose Connections tab did not
 * exist — the backend's graph is built from selectors, volumes and Ingress
 * rules, none of which an Application has. What it has is `status.resources`,
 * which Argo wrote, and that is what is read here.
 *
 * The kinds are declined by name rather than by group alone: `argoproj.io`
 * also holds `ApplicationSet` and `AppProject`, and an ApplicationSet's
 * relationship to the Applications it generates is the *reverse* direction —
 * it would need every Application read to answer, and the Application already
 * states it on its own row.
 */

import type { RelatedObject } from "../registry";
import { fetchApplications, GROUP } from "./data";
import type { ArgoApp, ArgoResource } from "./model";

/**
 * How this app relates a managed object, and what Argo said about it.
 *
 * The tone is Argo's verdict, never a reading of silence: an object with no
 * `sync` at all is one Argo has not compared, which is not a fault.
 */
function managed(resource: ArgoResource): RelatedObject {
  const failed =
    resource.outcome === "SyncFailed" || resource.sync === "Missing";
  const drifted = resource.sync !== null && resource.sync !== "Synced";
  const unhealthy = resource.health === "Degraded";

  return {
    relation: "manages",
    kind: resource.kind,
    name: resource.name,
    namespace: resource.namespace,
    group: resource.group,
    // Argo's own sentence, verbatim — usually the API server's refusal, and
    // the string the reader will paste into a search.
    //
    // Where it wrote none, its own state word stands in, because a tone is
    // drawn *on* the note: an object Argo reports as `Missing` says nothing
    // about why, and without this the row that earned the loudest colour in
    // the panel was the one row with nothing coloured on it.
    note: resource.message ?? said(resource, failed, drifted, unhealthy),
    tone: failed || unhealthy ? "err" : drifted ? "warn" : undefined,
  };
}

/**
 * Argo's word for the state, not this app's.
 *
 * `Missing`, `OutOfSync`, `Degraded` are the values in the object; printing
 * them as they are keeps the panel's rule that nothing here paraphrases the
 * controller. A resource in no trouble gets nothing, so a healthy row stays a
 * name and a namespace.
 */
function said(
  resource: ArgoResource,
  failed: boolean,
  drifted: boolean,
  unhealthy: boolean
): string | null {
  if (!failed && !drifted && !unhealthy) return null;
  return resource.outcome ?? resource.sync ?? resource.health;
}

/**
 * The project an Application is governed by.
 *
 * Worth an edge rather than a fact on the row: a project is what decides
 * which repositories and which destinations the Application is *allowed*,
 * so "why did this refuse to sync to that namespace" is answered there and
 * nowhere else.
 */
function project(app: ArgoApp): RelatedObject {
  return {
    relation: "governed by",
    kind: "AppProject",
    name: app.project,
    // An AppProject lives beside the Application, in Argo's own namespace.
    namespace: app.namespace,
    group: GROUP,
  };
}

export async function relatedTo(subject: {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}): Promise<RelatedObject[] | null> {
  // Not ours: `null` rather than an empty list, so the surface can tell "no
  // integration understands this object" from "this object points at nothing".
  if (subject.group !== GROUP || subject.kind !== "Application") return null;

  const apps = await fetchApplications();
  const app = apps.find(
    (candidate) =>
      candidate.name === subject.name &&
      candidate.namespace === subject.namespace
  );
  // The kind is ours and the object is gone, which is still an answer about
  // this kind — an empty one.
  if (!app) return [];

  return [project(app), ...app.resources.map(managed)];
}
