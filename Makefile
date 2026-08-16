.PHONY: gen-entities-tauri gen-icons dev build test clean help apply-test-manifests

MISE := $(shell command -v mise 2>/dev/null)
MISE_EXEC := $(if $(MISE),$(MISE) exec --,)

# Default target
help:
	@echo "Available commands:"
	@echo "  make dev           - Run development server"
	@echo "  make build         - Build all packages"
	@echo "  make test          - Run all tests"
	@echo "  make clean         - Clean build artifacts"
	@echo "  make gen-icons     - Generate base icon and Tauri icon assets"
	@echo "  make apply-test-manifests - Apply test manifests to the current kube-context"

# Generate ts types from tauri commands.
#
# cargo-expand is not optional here. Without it the generator cannot see
# macro-generated commands, drops every `subscribe_*_watch` binding from the
# output, and still exits 0 — the app then compiles and breaks at runtime.
# Guard on the tool, and on the command count as a backstop for any other
# cause of a lossy regeneration.
gen-entities-tauri:
	@$(MISE_EXEC) cargo expand --version >/dev/null 2>&1 || { \
		echo "error: cargo-expand not found — run 'mise install', or 'cargo install cargo-expand' (needs a nightly toolchain)"; \
		exit 1; \
	}
	@before=$$(grep -c '^export async function' src/generated/commands.ts 2>/dev/null || echo 0); \
	$(MISE_EXEC) tauri-ts-generator generate --verbose || exit 1; \
	after=$$(grep -c '^export async function' src/generated/commands.ts); \
	if [ "$$after" -lt "$$before" ]; then \
		echo "error: generated command count dropped $$before -> $$after."; \
		echo "       The output is missing commands — discard it with 'git checkout -- src/generated/'."; \
		exit 1; \
	fi; \
	echo "generated $$after commands"

# Regenerate every platform's icon from src-tauri/icons/base.png.
#
# `base.png` is drawn by hand and committed — edit that, then run this. There
# used to be a `scripts/gen_icon.py` on the line above that generated it, and
# it was deleted rather than fixed: it drew the letters "K8", from before the
# product was called Rubick, so running this target would have quietly
# replaced the real icon with the old one and rebuilt all sixteen sizes from
# it.
gen-icons:
	$(MISE_EXEC) cargo tauri icon src-tauri/icons/base.png

# Run Tauri development server
dev:
	$(MISE_EXEC) cargo tauri dev

# Build all packages
build:
	$(MISE_EXEC) cargo tauri build

# Run tests
test:
	$(MISE_EXEC) cargo test

# Clean build artifacts
clean:
	$(MISE_EXEC) cargo clean

# Apply Kubernetes test manifests (CRDs first).
apply-test-manifests:
	kubectl apply -f test-manifests/k8s-gui-crds.yaml
	kubectl apply -f test-manifests/k8s-gui-all.yaml
