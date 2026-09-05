//! Derives the pinned midnight-zk revision from the workspace Cargo.lock at
//! build time, so the evidence records cannot silently drift from the code
//! actually built. This matters because midnight-proofs is patched via
//! `branch = "main"` (cargo forbids a fixed-rev self-patch), so its pin
//! lives only in the lockfile: a `cargo update` would move it while the
//! rev-pinned crates stay put, and this script fails the build on any such
//! disagreement instead of trusting a hard-coded constant.

use std::{env, fs, path::PathBuf, process::Command};

/// The midnight-zk crates whose lockfile sources must agree on one revision.
const MIDNIGHT_CRATES: [&str; 4] = [
    "midnight-circuits",
    "midnight-curves",
    "midnight-proofs",
    "midnight-zk-stdlib",
];

/// Git source prefix identifying the midnight-zk repository (the registry
/// copy of midnight-curves pulled in by third parties is ignored).
const MIDNIGHT_ZK_GIT: &str = "git+https://github.com/midnightntwrk/midnight-zk";

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let lock_path = manifest_dir.join("../../Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock_path.display());

    let lock = fs::read_to_string(&lock_path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", lock_path.display()));

    // Cargo.lock is simple enough to scan line by line: every [[package]]
    // block lists `name = "..."` before its `source = "..."`.
    let mut revisions: Vec<(String, String)> = Vec::new();
    let mut current_name: Option<String> = None;
    for line in lock.lines() {
        if let Some(name) = line.strip_prefix("name = ") {
            current_name = Some(name.trim_matches('"').to_string());
        } else if let Some(source) = line.strip_prefix("source = ") {
            let source = source.trim_matches('"');
            let Some(name) = current_name.as_deref() else {
                continue;
            };
            if MIDNIGHT_CRATES.contains(&name) && source.starts_with(MIDNIGHT_ZK_GIT) {
                let rev = source.split('#').nth(1).unwrap_or_else(|| {
                    panic!("{name}: git source {source:?} has no revision fragment")
                });
                revisions.push((name.to_string(), rev.to_string()));
            }
        }
    }

    let Some((first_name, rev)) = revisions.first().cloned() else {
        panic!(
            "no midnight-zk git packages found in {}",
            lock_path.display()
        );
    };
    for (name, r) in &revisions {
        assert_eq!(
            r, &rev,
            "midnight-zk revision mismatch in Cargo.lock: {first_name} is at {rev} but {name} \
             is at {r}; re-pin all midnight crates to one revision"
        );
    }
    println!("cargo:rustc-env=MIDNIGHT_ZK_REV={rev}");

    // Record the rustc that actually compiles this crate, for the evidence
    // records' environment block.
    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let output = Command::new(&rustc)
        .arg("-V")
        .output()
        .unwrap_or_else(|e| panic!("running {rustc} -V: {e}"));
    assert!(output.status.success(), "{rustc} -V failed");
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("cargo:rustc-env=BIP340_GATE_RUSTC_VERSION={version}");
}
