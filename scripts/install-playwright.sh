#!/bin/sh
# CI: install Playwright browsers and their OS packages, retrying stalled mirrors.
# OS packages install as root so `timeout` can stop apt-get; otherwise an
# orphaned apt-get keeps the dpkg lock and every retry fails. Browsers download
# as the runner user so nothing in $HOME becomes root-owned.
set -u
cd "$(dirname "$0")/.."
[ "$#" -gt 0 ] || { echo "usage: $0 <browser>..." >&2; exit 2; }

retry() {
  for attempt in 1 2 3; do
    "$@" && return 0
    echo "Attempt $attempt failed: $*" >&2
    # Branded Chrome installs through sudo apt-get, which timeout cannot stop.
    sudo pkill -x apt-get
    sudo dpkg --configure -a
  done
  return 1
}

echo 'Acquire::Retries "3"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/99-playwright-retries >/dev/null

LIMIT="timeout -k 10 240"
retry sudo env "PATH=$PATH" $LIMIT npx --no-install playwright install-deps "$@" || exit 1
retry $LIMIT npx --no-install playwright install "$@" || exit 1
