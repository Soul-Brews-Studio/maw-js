#!/bin/bash
# Build the WASM VM engine and copy to office source
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "→ Building wasm-vm..."
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT/wasm-vm"
wasm-pack build --target web --release

echo "→ Copying pkg to office/src/wasm-vm..."
rm -rf "$ROOT/office/src/wasm-vm"
cp -r "$ROOT/wasm-vm/pkg" "$ROOT/office/src/wasm-vm"

echo "→ Done. WASM VM ready."
ls -lh "$ROOT/office/src/wasm-vm/office_vm_bg.wasm"
