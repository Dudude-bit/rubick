//! A kind's list as the API server prints it for kubectl (`as=Table`), one
//! page at a time across the namespaces of the scope.

use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::served::Served;
use crate::commands::helpers::UnreadNamespace;
use crate::error::{Error, Result};

/// Rows per page: a wide CRD's printed row runs to a kilobyte, and a page
/// has to stay one IPC message.
const PAGE: u32 = 200;

/// A Table where the server prints one, the list itself where it does not.
const ACCEPT: &str = "application/json;as=Table;g=meta.k8s.io;v=v1,application/json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    /// The `OpenAPI` type of the cells: `string`, `integer`, `number`,
    /// `boolean` or `date`.
    pub column_type: String,
    pub format: String,
    pub description: String,
    /// 0 is what kubectl prints by default; higher is `-o wide`.
    pub priority: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    pub name: String,
    pub namespace: Option<String>,
    pub uid: Option<String>,
    pub created_at: Option<String>,
    pub cells: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTable {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableRow>,
    /// Where the next page starts; none when this one reached the end.
    pub cursor: Option<String>,
    /// Namespaces of a several-namespace scope this page could not read.
    pub unread: Vec<UnreadNamespace>,
}

/// How far through the scope the previous page got.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Cursor {
    namespace: usize,
    token: Option<String>,
    /// Rows of this namespace already handed out by a server that pages
    /// nothing itself.
    #[serde(default)]
    skip: usize,
}

pub(super) async fn page(
    client: &Client,
    served: &Served,
    scope: Option<Vec<String>>,
    cursor: Option<&str>,
) -> Result<ResourceTable> {
    let reaches: Vec<Option<String>> = match scope {
        None => vec![None],
        Some(names) => names.into_iter().map(Some).collect(),
    };
    let several = reaches.len() > 1;
    let mut at: Cursor = match cursor {
        Some(text) => serde_json::from_str(text)
            .map_err(|_| Error::InvalidInput("not a cursor this list gave out".to_string()))?,
        None => Cursor::default(),
    };

    let mut table = ResourceTable::default();
    let mut first_failure = None;
    let mut answered = false;
    while at.namespace < reaches.len() && table.rows.len() < PAGE as usize {
        let reach = reaches[at.namespace].as_deref();
        let limit = PAGE - u32::try_from(table.rows.len()).unwrap_or(PAGE);
        match read(client, served, reach, limit, at.token.take()).await {
            Ok(mut printed) => {
                answered = true;
                if table.columns.is_empty() {
                    table.columns = printed.columns;
                }
                // metrics-server ignores `limit` and answers with every row
                // it has: the page is cut here, and the next one reads the
                // collection again to carry on from the cut.
                let room = limit as usize;
                let rest = printed.rows.split_off(at.skip.min(printed.rows.len()));
                if rest.len() > room {
                    table.rows.extend(rest.into_iter().take(room));
                    at.skip += room;
                    break;
                }
                at.skip = 0;
                table.rows.extend(rest);
                match printed.token {
                    Some(token) => at.token = Some(token),
                    None => at.namespace += 1,
                }
                if at.token.is_some() {
                    break;
                }
            }
            Err(failed) if several => {
                table.unread.push(UnreadNamespace::of(
                    reach.unwrap_or_default().to_string(),
                    &failed,
                ));
                first_failure.get_or_insert(failed);
                at.namespace += 1;
            }
            Err(failed) => return Err(failed),
        }
    }
    // Only the first page fails whole: a later one has rows before it, and
    // its refusals are theirs to stand beside.
    if !answered && cursor.is_none() {
        if let Some(failed) = first_failure {
            return Err(failed);
        }
    }
    if at.namespace < reaches.len() {
        table.cursor =
            Some(serde_json::to_string(&at).map_err(|e| Error::Serialization(e.to_string()))?);
    }
    Ok(table)
}

struct Printed {
    columns: Vec<TableColumn>,
    rows: Vec<TableRow>,
    token: Option<String>,
}

async fn read(
    client: &Client,
    served: &Served,
    namespace: Option<&str>,
    limit: u32,
    token: Option<String>,
) -> Result<Printed> {
    let mut request = kube::core::Request::new(list_path(served, namespace))
        .list(&super::page_params(limit, token))
        .map_err(|e| Error::Internal(e.to_string()))?;
    request
        .headers_mut()
        .insert(http::header::ACCEPT, http::HeaderValue::from_static(ACCEPT));
    parse(&client.request_text(request).await?)
}

fn list_path(served: &Served, namespace: Option<&str>) -> String {
    let resource = &served.resource;
    let base = if resource.group.is_empty() {
        format!("/api/{}", resource.version)
    } else {
        format!("/apis/{}/{}", resource.group, resource.version)
    };
    match namespace.filter(|_| served.namespaced) {
        Some(ns) => format!("{base}/namespaces/{ns}/{}", resource.plural),
        None => format!("{base}/{}", resource.plural),
    }
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn row(metadata: &Value, cells: Vec<Value>) -> TableRow {
    TableRow {
        name: text(&metadata["name"]),
        namespace: metadata["namespace"].as_str().map(str::to_string),
        uid: metadata["uid"].as_str().map(str::to_string),
        created_at: metadata["creationTimestamp"].as_str().map(str::to_string),
        cells,
    }
}

fn parse(body: &str) -> Result<Printed> {
    let value: Value =
        serde_json::from_str(body).map_err(|e| Error::Serialization(e.to_string()))?;
    let token = value["metadata"]["continue"]
        .as_str()
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let list = |key: &str| value[key].as_array().cloned().unwrap_or_default();

    if value["kind"] == "Table" {
        let columns = list("columnDefinitions")
            .iter()
            .map(|column| TableColumn {
                name: text(&column["name"]),
                column_type: text(&column["type"]),
                format: text(&column["format"]),
                description: text(&column["description"]),
                priority: column["priority"].as_i64().unwrap_or(0),
            })
            .collect();
        let rows = list("rows")
            .iter()
            .map(|printed| {
                row(
                    &printed["object"]["metadata"],
                    printed["cells"].as_array().cloned().unwrap_or_default(),
                )
            })
            .collect();
        return Ok(Printed {
            columns,
            rows,
            token,
        });
    }

    let column = |name: &str, column_type: &str, format: &str| TableColumn {
        name: name.to_string(),
        column_type: column_type.to_string(),
        format: format.to_string(),
        description: String::new(),
        priority: 0,
    };
    let rows = list("items")
        .iter()
        .map(|item| {
            let metadata = &item["metadata"];
            row(
                metadata,
                vec![
                    metadata["name"].clone(),
                    metadata["creationTimestamp"].clone(),
                ],
            )
        })
        .collect();
    Ok(Printed {
        columns: vec![column("Name", "string", "name"), column("Age", "date", "")],
        rows,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{answering, failure};
    use kube::discovery::ApiResource;
    use serde_json::json;

    fn configmaps() -> Served {
        Served {
            resource: ApiResource {
                group: String::new(),
                version: "v1".to_string(),
                api_version: "v1".to_string(),
                kind: "ConfigMap".to_string(),
                plural: "configmaps".to_string(),
            },
            namespaced: true,
        }
    }

    fn printed(names: &[&str], token: Option<&str>) -> String {
        json!({
            "kind": "Table",
            "apiVersion": "meta.k8s.io/v1",
            "metadata": { "continue": token.unwrap_or("") },
            "columnDefinitions": [
                { "name": "Name", "type": "string", "format": "name", "priority": 0 },
                { "name": "Data", "type": "integer", "format": "", "priority": 0 },
            ],
            "rows": names.iter().map(|name| json!({
                "cells": [name, 1],
                "object": { "metadata": { "name": name, "namespace": "a", "uid": format!("uid-{name}") } },
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// A server that ignores `as=Table` would otherwise list nothing at all.
    #[test]
    fn a_plain_list_is_printed_as_names_and_ages() {
        let body = json!({
            "kind": "ConfigMapList",
            "metadata": {},
            "items": [{ "metadata": { "name": "x", "creationTimestamp": "2026-01-01T00:00:00Z" } }],
        })
        .to_string();
        let page = parse(&body).expect("parsed");
        assert_eq!(
            page.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["Name", "Age"]
        );
        assert_eq!(
            page.rows[0].cells,
            vec![json!("x"), json!("2026-01-01T00:00:00Z")]
        );
    }

    /// The printed cells are the server's, in its column order, with the row's
    /// own identity beside them so the row can link to its object.
    #[test]
    fn a_table_keeps_the_servers_columns_and_each_rows_identity() {
        let page = parse(&printed(&["x"], Some("next"))).expect("parsed");
        assert_eq!(page.columns[1].column_type, "integer");
        assert_eq!(page.rows[0].uid.as_deref(), Some("uid-x"));
        assert_eq!(page.token.as_deref(), Some("next"));
    }

    /// A refused namespace among several is named, never read as "none here":
    /// an empty list and a 403 must not look alike.
    #[tokio::test]
    async fn a_refused_namespace_is_named_beside_the_rows_of_the_others() {
        let (client, _) = answering(|path, _| match path {
            "/api/v1/namespaces/a/configmaps" => (200, printed(&["one", "two"], None)),
            "/api/v1/namespaces/b/configmaps" => failure(403, "Forbidden"),
            "/api/v1/namespaces/c/configmaps" => (200, printed(&["three"], None)),
            _ => (404, "{}".to_string()),
        })
        .await;
        let scope = Some(vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        let table = page(&client, &configmaps(), scope, None)
            .await
            .expect("page");
        assert_eq!(table.rows.len(), 3);
        assert_eq!(table.unread.len(), 1);
        assert_eq!(table.unread[0].namespace, "b");
        assert_eq!(table.unread[0].code, "PERMISSION_DENIED");
        assert_eq!(table.cursor, None);
    }

    /// Where no namespace answered, there is nothing to show beside the
    /// failures, and the read fails whole as every scoped list here does.
    #[tokio::test]
    async fn a_scope_where_nothing_answered_fails_whole() {
        let (client, _) = answering(|_, _| failure(403, "Forbidden")).await;
        let scope = Some(vec!["a".to_string(), "b".to_string()]);
        let failed = page(&client, &configmaps(), scope, None).await.unwrap_err();
        assert!(failed.is_refusal());
    }

    /// "Show more" would otherwise replace the rows already read with a
    /// whole-list refusal: a page filled exactly at a namespace's end hands
    /// out a cursor, and every namespace after it may be refused.
    #[tokio::test]
    async fn a_later_page_where_nothing_answered_names_the_namespaces_and_does_not_fail() {
        let (client, _) = answering(|path, _| match path {
            "/api/v1/namespaces/b/configmaps" => (200, printed(&["one"], None)),
            _ => failure(403, "Forbidden"),
        })
        .await;
        let scope = Some(vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        let cursor = r#"{"namespace":2,"token":null}"#;
        let table = page(&client, &configmaps(), scope, Some(cursor))
            .await
            .expect("a page, not a refusal");
        assert!(table.rows.is_empty());
        assert_eq!(table.unread.len(), 1);
        assert_eq!(table.unread[0].namespace, "c");
        assert_eq!(table.unread[0].code, "PERMISSION_DENIED");
        assert_eq!(table.cursor, None);
    }

    /// metrics-server answers a list of 10 000 `PodMetrics` whole whatever
    /// `limit` says: megabytes in one IPC message, re-sent on every poll.
    #[tokio::test]
    async fn a_server_that_ignores_the_limit_is_still_read_a_page_at_a_time() {
        let names: Vec<String> = (0..450).map(|i| format!("r{i}")).collect();
        let (client, _) = answering(move |_, _| {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            (200, printed(&names, None))
        })
        .await;
        let mut cursor = None;
        let mut read = Vec::new();
        let mut sizes = Vec::new();
        loop {
            let table = page(&client, &configmaps(), None, cursor.as_deref())
                .await
                .expect("page");
            sizes.push(table.rows.len());
            read.extend(table.rows.into_iter().map(|row| row.name));
            cursor = table.cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(sizes, [200, 200, 50]);
        assert_eq!(read.len(), 450);
        assert_eq!(read[200], "r200");
        assert_eq!(read[449], "r449");
    }

    /// A page that stops mid-namespace hands back where it stopped, and the
    /// next one carries on from there into the namespaces after it.
    #[tokio::test]
    async fn the_cursor_carries_a_list_across_pages_and_namespaces() {
        let (client, _) = answering(|path, nth| match (path, nth) {
            ("/api/v1/namespaces/a/configmaps", 1) => (200, printed(&["one"], Some("more"))),
            ("/api/v1/namespaces/a/configmaps", _) => (200, printed(&["two"], None)),
            ("/api/v1/namespaces/b/configmaps", _) => (200, printed(&["three"], None)),
            _ => (404, "{}".to_string()),
        })
        .await;
        let scope = Some(vec!["a".to_string(), "b".to_string()]);
        let first = page(&client, &configmaps(), scope.clone(), None)
            .await
            .expect("first");
        assert_eq!(first.rows.len(), 1);
        let cursor = first.cursor.expect("a cursor");
        let second = page(&client, &configmaps(), scope, Some(&cursor))
            .await
            .expect("second");
        assert_eq!(
            second
                .rows
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["two", "three"]
        );
        assert_eq!(second.cursor, None);
    }
}
