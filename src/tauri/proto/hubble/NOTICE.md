# Hubble's observer API

`flow/flow.proto`, `observer/observer.proto` and `relay/relay.proto` are copied
unchanged from Cilium's `api/v1` at tag `v1.20.4`
(https://github.com/cilium/cilium/tree/v1.20.4/api/v1), where they are
published under the Apache License 2.0 by the Authors of Hubble and the
Authors of Cilium. Each file keeps its own licence header.

The Rust in `src/integrations/hubble/proto/` is generated from them; the test
there regenerates it and fails when the two differ. To take a new tag, replace
these three files and run that test with `RUBICK_REGENERATE=1`.
