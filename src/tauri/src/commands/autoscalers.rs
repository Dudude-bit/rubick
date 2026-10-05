//! Changing a `HorizontalPodAutoscaler`'s bounds, which is the way to set a
//! replica count the autoscaler owns.

use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use kube::api::{Patch, PatchParams};
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;

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

    #[test]
    fn bounds_the_api_would_refuse_are_refused_before_asking() {
        assert!(bounds_patch(0, 5).is_err());
        assert!(bounds_patch(6, 5).is_err());
    }
}
