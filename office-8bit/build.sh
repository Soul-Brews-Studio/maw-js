#!/bin/bash
# Build office-8bit WASM and prepare dist
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building office-8bit (Bevy WASM) ==="

# Build WASM
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --target wasm32-unknown-unknown

# Run wasm-bindgen
WASM_FILE="target/wasm32-unknown-unknown/release/office-8bit.wasm"
OUT_DIR="../dist-8bit-office"

mkdir -p "$OUT_DIR"

wasm-bindgen "$WASM_FILE" \
  --out-dir "$OUT_DIR" \
  --target web \
  --no-typescript

# Copy web files
cp web/index.html "$OUT_DIR/"
cp web/bridge.js "$OUT_DIR/"

# Copy assets (sprites + tiles)
cp -r assets "$OUT_DIR/"

# Optional: optimize with wasm-opt if available
if command -v wasm-opt &> /dev/null; then
  echo "Optimizing WASM..."
  wasm-opt -Os --enable-bulk-memory --enable-mutable-globals --enable-nontrapping-float-to-int --enable-sign-ext \
    "$OUT_DIR/office-8bit_bg.wasm" -o "$OUT_DIR/office-8bit_bg.wasm" 2>/dev/null || \
    echo "  wasm-opt failed (version too old?), skipping optimization"
fi

SIZE=$(du -sh "$OUT_DIR/office-8bit_bg.wasm" | cut -f1)
echo "=== Build complete: $OUT_DIR ($SIZE) ==="
echo "Files:"
ls -la "$OUT_DIR/"
