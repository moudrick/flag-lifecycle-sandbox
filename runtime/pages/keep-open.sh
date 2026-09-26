#!/bin/sh
# Holds one published page open so its flag keeps accruing evaluations.
#
# The page reads its flag from the query string. Without an explicit ?flag= the page falls back to
# the pair compiled into its source, and on that path a failed connection makes it evaluate the
# failover flag. A keeper that did that would spend a flag whose whole value is never having been
# evaluated, so the guards below refuse the URL rather than trust the caller.
set -eu

: "${PAGE_URL:?missing PAGE_URL}"

case "$PAGE_URL" in
  http://*|https://*) ;;
  *) echo "refusing PAGE_URL: not an http(s) URL" >&2; exit 64 ;;
esac

case "$PAGE_URL" in
  *'?flag='*|*'&flag='*) ;;
  *) echo "refusing PAGE_URL: a keeper needs an explicit flag= parameter" >&2; exit 64 ;;
esac

case "$PAGE_URL" in
  *failover*) echo "refusing PAGE_URL: a keeper never configures or names a failover flag" >&2; exit 64 ;;
esac

echo "page keeper starting for ${PAGE_URL}"

# The root filesystem is read-only, so the profile and any crash artefacts go to the tmpfs. The
# crash handler needs a database directory it will never get here, so it is switched off instead.
exec chromium-browser \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir=/tmp/chrome-profile \
  --crash-dumps-dir=/tmp/chrome-crashes \
  --disable-crashpad \
  --disable-breakpad \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  "$PAGE_URL"
