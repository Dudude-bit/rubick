//! Changing a `HorizontalPodAutoscaler`'s bounds, which is the way to set a
//! replica count the autoscaler owns.

use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use kube::api::{Patch, PatchParams};
use kube::ResourceExt;
use serde::Serialize;
use tauri::State;

use crate::commands::helpers::{list_in_scope, ResourceContext};
use crate::error::{Error, Result};
use crate::resources::{Existence, ObjectRef};
use crate::state::AppState;

/// An autoscaler with the facts its findings are read from, and what it scales.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoscalerInfo {
    pub autoscaler: ObjectRef,
    pub target: ObjectRef,
}

impl From<&HorizontalPodAutoscaler> for AutoscalerInfo {
    fn from(hpa: &HorizontalPodAutoscaler) -> Self {
        let namespace = hpa.namespace().unwrap_or_default();
        let target = hpa.spec.as_ref().map(|s| &s.scale_target_ref);
        Self {
            autoscaler: crate::commands::connections::autoscaler_ref(hpa, &namespace),
            target: ObjectRef::new(
                target.map_or("", |t| t.kind.as_str()),
                target.map_or("", |t| t.name.as_str()),
                Some(namespace.clone()),
                Existence::NotChecked,
            ),
        }
    }
}

list_in_scope!(list_autoscalers_in, HorizontalPodAutoscaler, AutoscalerInfo);

/// The merge patch for new bounds, refused where the API server would refuse
/// it: `minReplicas` below one, or above `maxReplicas`.
fn bounds_patch(min_replicas: i32, max_replicas: i32) -> Result<serde_json::Value> {
    if min_replicas < 1 {
        return Err(Error::InvalidInput(
            "minReplicas must be at least 1".to_string(),
        ));
    }
    if min_replicas > max_replicas {
        return Err(Error::InvalidInput(
            "minReplicas cannot be above maxReplicas".to_string(),
        ));
    }
    Ok(serde_json::json!({
        "spec": { "minReplicas": min_replicas, "maxReplicas": max_replicas }
    }))
}

#[tauri::command]
pub async fn set_autoscaler_bounds(
    name: String,
    namespace: Option<String>,
    min_replicas: i32,
    max_replicas: i32,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let patch = bounds_patch(min_replicas, max_replicas)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    ctx.namespaced_api::<HorizontalPodAutoscaler>()
        .patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the two bounds: a patch that carried the metrics or the target
    /// would overwrite whatever someone else set there.
    #[test]
    fn the_patch_sets_both_bounds_and_nothing_else() {
        assert_eq!(
            bounds_patch(3, 6).expect("valid bounds"),
            serde_json::json!({ "spec": { "minReplicas": 3, "maxReplicas": 6 } })
        );
        assert!(bounds_patch(2, 2).is_ok());
    }

    /// The overview reads an autoscaler's findings from these facts; a row
    /// without its conditions or its target could say nothing about either.
    #[test]
    fn a_listed_autoscaler_carries_its_conditions_and_what_it_scales() {
        let hpa: HorizontalPodAutoscaler = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "cart", "namespace": "shop" },
            "spec": {
                "maxReplicas": 5,
                "scaleTargetRef": { "apiVersion": "apps/v1", "kind": "Deployment", "name": "cart" },
            },
            "status": {
                "desiredReplicas": 0,
                "conditions": [{
                    "type": "ScalingActive",
                    "status": "False",
                    "reason": "FailedGetResourceMetric",
                    "message": "unable to get metrics for resource cpu",
                }],
            },
        }))
        .expect("an autoscaler");

        let info = AutoscalerInfo::from(&hpa);

        assert_eq!(info.autoscaler.name, "cart");
        assert_eq!(info.autoscaler.namespace.as_deref(), Some("shop"));
        let Some(crate::resources::ObjectFacts::Autoscaler { conditions, .. }) =
            &info.autoscaler.facts
        else {
            panic!("an autoscaler's facts: {:?}", info.autoscaler.facts);
        };
        assert_eq!(conditions[0].type_, "ScalingActive");
        assert_eq!(
            conditions[0].reason.as_deref(),
            Some("FailedGetResourceMetric")
        );
        assert_eq!(
            (info.target.kind.as_str(), info.target.name.as_str()),
            ("Deployment", "cart")
        );
        assert_eq!(info.target.namespace.as_deref(), Some("shop"));
    }

    #[test]
    fn bounds_the_api_would_refuse_are_refused_before_asking() {
        assert!(bounds_patch(0, 5).is_err());
        assert!(bounds_patch(6, 5).is_err());
    }
}
