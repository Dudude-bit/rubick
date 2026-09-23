//! The `#[ignore]`d harnesses that need a cluster, in one binary: as separate
//! crates every `cargo test` linked eighteen of them to run none. Pick one
//! with a filter (`live_drain::`); running several at once, add
//! `--test-threads=1`, since some change the cluster.

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
mod live_overview_scope;
mod live_perf;
mod live_pod_rows;
mod live_prometheus_operator;
mod live_proxy;
mod live_reads;
mod live_refusals;
mod live_route_status;
mod live_terminal;
mod live_tls;
