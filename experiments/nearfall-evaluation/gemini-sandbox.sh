#!/usr/bin/env bash

# This script runs the Gemini CLI inside a Bubblewrap sandbox.
# It restricts access to the host filesystem while allowing persistence
# for the Gemini configuration (~/.gemini) and providing user identity.

PROJECT_ROOT=$(pwd)
# Locate the node binary in the current PATH (from nix develop)
NODE_BIN=$(command -v node)

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Did you run 'nix develop'?"
  exit 1
fi

# We use 'node' to execute the script directly to bypass shebang issues
GEMINI_SCRIPT="$PROJECT_ROOT/.npm-global/bin/gemini"

if [ ! -f "$GEMINI_SCRIPT" ]; then
  echo "Error: Gemini CLI not found at $GEMINI_SCRIPT"
  echo "Please ensure 'npm install -g @google/gemini-cli' finished in 'nix develop'."
  exit 1
fi

# Ensure the config directory exists on the host so we can bind it
mkdir -p "$HOME/.gemini"

# Prepare a minimal /etc/passwd and /etc/group for the sandbox to satisfy libuv/Node.js
# This maps your current UID/GID to a name inside the sandbox.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "$(id -un):x:$(id -u):$(id -g):$(id -un):$HOME:/bin/sh" > "$TMP_DIR/passwd"
echo "$(id -gn):x:$(id -g):" > "$TMP_DIR/group"

bwrap \
  --ro-bind /nix /nix \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/ssl/certs /etc/ssl/certs \
  --ro-bind /etc/static/ssl/certs /etc/static/ssl/certs \
  --ro-bind "$TMP_DIR/passwd" /etc/passwd \
  --ro-bind "$TMP_DIR/group" /etc/group \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs "$HOME" \
  --bind "$HOME/.gemini" "$HOME/.gemini" \
  --bind "$PROJECT_ROOT" "$PROJECT_ROOT" \
  --chdir "$PROJECT_ROOT" \
  --setenv PATH "/nix/var/nix/profiles/default/bin:/usr/bin:/bin" \
  --setenv HOME "$HOME" \
  --setenv USER "$(id -un)" \
  --unshare-all \
  --share-net \
  --uid "$(id -u)" \
  --gid "$(id -g)" \
  --die-with-parent \
  -- "$NODE_BIN" "$GEMINI_SCRIPT" "$@"
