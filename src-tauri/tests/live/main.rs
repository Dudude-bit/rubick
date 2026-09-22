//! Harnesses that need a real cluster, every one `#[ignore]`d. One test
//! binary rather than one per file: each was its own crate, and every
//! `cargo test` linked all eighteen — about 50 MB apiece — to run none.
//!
//! ```text
//! cargo test --test live live_drain:: -- --ignored --nocapture
//! ```
//!
//! The filter picks a harness; each file's header says what it needs. Running
//! more than one at once puts them on parallel threads of one process, and
//! some change the cluster (`live_drain` cordons a node), so add
//! `--test-threads=1` then.

mod cross_cluster_search;
mod live_checks;
mod live_compat;
mod live_connections;
mod live_drain;
mod live_dry_run;
mod live_events;
mod live_files;
mod live_gateway;
mod live_init_containers;
mod live_namespace_watch;
mod live_overview_cache;
mod live_perf;
mod live_pod_rows;
mod live_prometheus_operator;
mod live_proxy;
mod live_refusals;
mod live_route_status;
