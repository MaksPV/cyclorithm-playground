#!/usr/bin/env bash
# Запуск плейграунда: сборка WASM-движка -> клей wasm-bindgen -> HTTP-сервер.
# Использование: ./run.sh [PORT]   (по умолчанию 8080)
# Остановка: Ctrl+C.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${1:-8080}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "нужен '$1' (не найден в PATH)" >&2
    exit 1
  }
}
need cargo
need python3
need rustup

# wasm32-таргет для сборки движка.
if ! rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then
  echo "ставлю таргет wasm32-unknown-unknown..."
  rustup target add wasm32-unknown-unknown
fi

# wasm-bindgen-cli строго той версии, что wasm-bindgen в Cargo.toml
# (иначе сгенерированный клей рассыплется).
WANT="$(grep -E '^wasm-bindgen = ' Cargo.toml | sed -E 's/.*\"=([0-9.]+)\".*/\1/')"
HAVE="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$HAVE" != "$WANT" ]; then
  echo "ставлю wasm-bindgen-cli $WANT (есть: ${HAVE:-нет})..."
  cargo install wasm-bindgen-cli --version "$WANT" --locked
  export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "сборка wasm (release)..."
cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -2

echo "клей wasm-bindgen..."
wasm-bindgen target/wasm32-unknown-unknown/release/playground.wasm \
  --out-dir pkg --target web

# Порт занят — не гадаем, просим другой.
if python3 -c "import socket; s = socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', $PORT))" 2>/dev/null; then
  echo "порт $PORT уже занят (кто-то уже служит?). Другой порт: ./run.sh 8090" >&2
  exit 1
fi

echo
echo "плейграунд: http://localhost:$PORT"
echo "(остановка — Ctrl+C)"
exec python3 -m http.server "$PORT"
