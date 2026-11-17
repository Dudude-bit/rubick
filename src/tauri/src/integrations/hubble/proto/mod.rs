//! Hubble's observer API, generated from `proto/hubble` (see its `NOTICE.md`).

#[allow(clippy::all, clippy::pedantic)]
pub mod flow;
#[allow(clippy::all, clippy::pedantic)]
pub mod observer;
#[allow(clippy::all, clippy::pedantic)]
pub mod relay;

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    const GENERATED: [&str; 3] = ["flow.rs", "observer.rs", "relay.rs"];

    /// The committed Rust is what the vendored protos make: a proto taken
    /// from a new tag with the Rust left behind would be read with the old
    /// field numbers, and every flow would decode wrong without an error.
    #[test]
    fn the_generated_code_is_what_the_vendored_protos_make() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let here = manifest.join("src/integrations/hubble/proto");
        let out = std::env::temp_dir().join(format!("rubick-hubble-{}", std::process::id()));
        std::fs::create_dir_all(&out).expect("a scratch directory");
        let protos = protox::compile(["observer/observer.proto"], [manifest.join("proto/hubble")])
            .expect("the vendored protos compile");
        tonic_prost_build::configure()
            .build_server(false)
            .out_dir(&out)
            .compile_fds(protos)
            .expect("the protos generate");
        let made: Vec<_> = GENERATED.iter().map(|name| out.join(name)).collect();
        let formatted = Command::new("rustfmt")
            .arg("--config-path")
            .arg(manifest.join("../../.rustfmt.toml"))
            .args(&made)
            .status()
            .expect("rustfmt runs");
        assert!(formatted.success(), "rustfmt failed on the generated code");
        for (name, path) in GENERATED.iter().zip(&made) {
            let fresh = std::fs::read_to_string(path).expect("generated");
            if std::env::var_os("RUBICK_REGENERATE").is_some() {
                std::fs::write(here.join(name), &fresh).expect("written");
                continue;
            }
            let held = std::fs::read_to_string(here.join(name)).unwrap_or_default();
            assert!(
                held == fresh,
                "{name} is not what proto/hubble generates; run this test with RUBICK_REGENERATE=1"
            );
        }
        let _ = std::fs::remove_dir_all(&out);
    }
}
