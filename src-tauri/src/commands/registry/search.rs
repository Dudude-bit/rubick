//! Image search across registries — Docker Hub uses the public
//! search API, Harbor uses its own `/api/v2.0/search`, everything
//! else (GCR, ECR, generic registry-v2) goes through `/v2/_catalog`.

use crate::error::{Error, Result};
use reqwest::Client;

use super::auth::{build_auth_header, load_saved_auth};
use super::types::{RegistryImageResult, RegistrySearchRequest};

const SEARCH_LIMIT: usize = 200;
const RESULT_LIMIT: usize = 12;

pub(super) fn normalize_base_url(input: &str) -> String {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn host_from_url(base_url: &str) -> String {
    base_url
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

async fn search_registry_catalog(
    client: &Client,
    base_url: &str,
    query: &str,
    auth_header: Option<String>,
    project_filter: Option<&str>,
) -> Result<Vec<RegistryImageResult>> {
    let url = format!(
        "{}/v2/_catalog?n={}",
        base_url.trim_end_matches('/'),
        SEARCH_LIMIT
    );
    let mut request = client.get(url);
    if let Some(header) = auth_header {
        request = request.header("Authorization", header);
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(Error::Connection(format!(
            "Registry request failed with {}",
            response.status()
        )));
    }
    let payload: serde_json::Value = response.json().await?;
    let repositories = payload
        .get("repositories")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            Error::Internal("Registry catalog did not return repositories".to_string())
        })?;
    let needle = query.to_lowercase();
    let host = host_from_url(base_url);
    let mut results = Vec::new();
    for repo_value in repositories {
        let Some(repo) = repo_value.as_str() else {
            continue;
        };
        if let Some(project) = project_filter {
            if !repo.starts_with(&format!("{project}/")) {
                continue;
            }
        }
        if !repo.to_lowercase().contains(&needle) {
            continue;
        }
        let name = if host.is_empty() {
            repo.to_string()
        } else {
            format!("{host}/{repo}")
        };
        results.push(RegistryImageResult {
            id: name.clone(),
            name,
            description: String::new(),
            is_official: false,
        });
        if results.len() >= RESULT_LIMIT {
            break;
        }
    }
    Ok(results)
}

async fn search_docker_hub(client: &Client, query: &str) -> Result<Vec<RegistryImageResult>> {
    let url = format!(
        "https://hub.docker.com/v2/search/repositories/?query={}&page_size={}",
        urlencoding::encode(query),
        RESULT_LIMIT
    );
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(Error::Connection(format!(
            "Docker Hub search failed with {}",
            response.status()
        )));
    }
    let payload: serde_json::Value = response.json().await?;
    let Some(results) = payload.get("results").and_then(|value| value.as_array()) else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    for entry in results.iter().take(RESULT_LIMIT) {
        let repo_name = entry
            .get("repo_name")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let namespace = entry
            .get("namespace")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let name = entry
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let full_name = if !repo_name.is_empty() {
            repo_name
        } else if !namespace.is_empty() && !name.is_empty() {
            &format!("{namespace}/{name}")
        } else {
            ""
        };
        if full_name.is_empty() {
            continue;
        }
        let display_name = full_name.strip_prefix("library/").unwrap_or(full_name);
        let description = entry
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let is_official = entry
            .get("is_official")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || entry
                .get("is_trusted")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
        output.push(RegistryImageResult {
            id: display_name.to_string(),
            name: display_name.to_string(),
            description,
            is_official,
        });
    }
    Ok(output)
}

async fn search_harbor(
    client: &Client,
    base_url: &str,
    query: &str,
    auth_header: Option<String>,
    project_filter: Option<&str>,
) -> Result<Vec<RegistryImageResult>> {
    let url = format!(
        "{}/api/v2.0/search?q={}",
        base_url.trim_end_matches('/'),
        urlencoding::encode(query)
    );
    let mut request = client.get(url);
    if let Some(header) = auth_header {
        request = request.header("Authorization", header);
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(Error::Connection(format!(
            "Harbor search failed with {}",
            response.status()
        )));
    }
    let payload: serde_json::Value = response.json().await?;
    let Some(repositories) = payload.get("repository").and_then(|value| value.as_array()) else {
        return Ok(Vec::new());
    };
    let host = host_from_url(base_url);
    let mut output = Vec::new();
    for entry in repositories.iter().take(RESULT_LIMIT) {
        let repo_name = entry
            .get("repository_name")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if repo_name.is_empty() {
            continue;
        }
        if let Some(project) = project_filter {
            if !repo_name.starts_with(&format!("{project}/")) {
                continue;
            }
        }
        let full_name = if host.is_empty() {
            repo_name.to_string()
        } else {
            format!("{host}/{repo_name}")
        };
        let description = entry
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        output.push(RegistryImageResult {
            id: full_name.clone(),
            name: full_name,
            description,
            is_official: false,
        });
    }
    Ok(output)
}

#[tauri::command]
pub async fn search_registry_images(
    request: RegistrySearchRequest,
) -> Result<Vec<RegistryImageResult>> {
    let client = Client::new();
    let mut auth = request.auth.clone();
    if request.use_saved_auth {
        if let Some(saved) = load_saved_auth(&request.registry.id)? {
            auth = Some(saved);
        }
    }
    let auth_header = auth.as_ref().and_then(build_auth_header);

    match request.registry.provider.as_str() {
        "docker-hub" => search_docker_hub(&client, &request.query).await,
        "harbor" => {
            let base_url = request
                .registry
                .base_url
                .as_ref()
                .map(|value| normalize_base_url(value))
                .ok_or_else(|| Error::InvalidInput("Harbor base URL is required".to_string()))?;
            let project_filter = request.registry.project.as_deref();
            search_harbor(
                &client,
                &base_url,
                &request.query,
                auth_header,
                project_filter,
            )
            .await
        }
        "gcr" => {
            let host = request.registry.host.as_deref().unwrap_or("gcr.io");
            let base_url = normalize_base_url(host);
            let project_filter = request.registry.project.as_deref();
            search_registry_catalog(
                &client,
                &base_url,
                &request.query,
                auth_header,
                project_filter,
            )
            .await
        }
        "ecr" => {
            let account_id = request
                .registry
                .account_id
                .as_ref()
                .ok_or_else(|| Error::InvalidInput("ECR account ID is required".to_string()))?;
            let region = request
                .registry
                .region
                .as_ref()
                .ok_or_else(|| Error::InvalidInput("ECR region is required".to_string()))?;
            let base_url =
                normalize_base_url(&format!("{account_id}.dkr.ecr.{region}.amazonaws.com"));
            search_registry_catalog(&client, &base_url, &request.query, auth_header, None).await
        }
        "registry-v2" => {
            let base_url = request
                .registry
                .base_url
                .as_ref()
                .map(|value| normalize_base_url(value))
                .ok_or_else(|| Error::InvalidInput("Registry URL is required".to_string()))?;
            search_registry_catalog(&client, &base_url, &request.query, auth_header, None).await
        }
        other => Err(Error::InvalidInput(format!(
            "Unsupported registry provider: {other}"
        ))),
    }
}
