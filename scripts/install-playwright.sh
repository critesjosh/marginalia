#!/bin/sh
# CI: install Playwright browsers and their OS packages, retrying stalled mirrors.
# Runs as root so `timeout` can stop apt-get; otherwise an orphaned apt-get
# keeps the dpkg lock and every retry fails.
set -u
cd "$(dirname "$0")/.."
[ "$#" -gt 0 ] || { echo "usage: $0 <browser>..." >&2; exit 2; }

echo 'Acquire::Retries "3"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/99-playwright-retries >/dev/null

for attempt in 1 2 3; do
  # HOME keeps downloads in the runner's cache, where tests look for them.
  if sudo env "PATH=$PATH" "HOME=$HOME" timeout -k 10 240 \
    npx --no-install playwright install --with-deps "$@"; then
    sudo chown -R "$(id -u):$(id -g)" "$HOME/.cache/ms-playwright" 2>/dev/null
    exit 0
  fi
  echo "Playwright install attempt $attempt failed" >&2
  sudo dpkg --configure -a
done
exit 1
