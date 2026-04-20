---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

# Project Workspace

You will privilege using a workspace for any new project, separating the library
components from the binary/application components.

- Libraries (or crates) live in the `crates` directory.
- Applications (binaries, user-facing scripts) live in the `bin` directory.
- Crate names are prefixed with `project-`. For example, the core folder's crate is named `project-core`
  where `project` is the name of the project you are working on.

## Package Metadata

You will use the workspace package metadata to define the whole workspace's
general settings: edition, licence, version, etc.

```toml
[workspace.package]
edition = "2024"
```

In the individual packages you will use these values using the workspace
settings:

```toml
[package]
edition = { workspace = true }
```

## Package Dependencies

Dependencies will be listed in the workspace TOML file and used
appropriately in the individual packages:

```toml
# Cargo.toml
[workspace.dependencies]
anyhow = { version = "1" }
criterion = { version = "1" }
```

```toml
# crates/crate/Cargo.toml
[dependencies]
anyhow = { workspace = true }
[dev-dependencies]
criterion = { workspace = true }
```

You will always make sure we keep the dependencies to the minimum of what
is actually needed. Before adding any new dependency, you will ask the
user to approve it, explaining the reason why you need it.

# Code Style

Run `cargo fmt` immediately after you have finished making Rust code changes. Do not ask approval to run it.

Run `cargo clippy -p` immediately after you have finished making Rust code changes. Do not ask approval to run it.
All warnings are to be treated as errors.

- Always collapse `if` statements per https://rust-lang.github.io/rust-clippy/master/index.html#collapsible_if
- Always inline `format!` args when possible per https://rust-lang.github.io/rust-clippy/master/index.html#uninlined_format_args
- Use method references over closures when possible per https://rust-lang.github.io/rust-clippy/master/index.html#redundant_closure_for_method_calls
- When possible, make `match` statements exhaustive and avoid wildcard arms.
- When writing tests, prefer comparing the equality of entire objects over fields one by one.

# Testing

You will run `cargo test -p` with the package name(s) you have modified
immediately after you have made code changes. Do not ask approval to run it.

Do not run the whole workspace test suite without asking approval.

# Preferred dependencies

- use `anyhow` for application error handling
- use `thiserror` for crates/library/api error handling
- use `clap` with the `derive` feature to define all command line arguments
- prefer `axum` for REST APIs
- prefer `tracing` for logging
- prefer `tokio`
- prefer `cryptoxide` for cryptographic primitives (ed25519, blake2b, sha, hmac, chacha poly1305)
- prefer `console` for styled CLI output (emoji fallbacks, coloured text)
- prefer `cargo-dist` + `axoupdater` for CLI binary distribution and self-update
