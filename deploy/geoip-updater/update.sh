#!/bin/sh
set -eu

DIR=/var/lib/qtiauth/geoip
DEST="$DIR/dbip-country-lite.csv.gz"
TMP="$DIR/dbip-country-lite.csv.gz.tmp"

# DB-IP publishes one file a month, so check again a month after a good download
# and hourly while the month's file is still missing.
SLEEP_AFTER_UPDATE=$((30 * 24 * 60 * 60))
SLEEP_AFTER_FAILURE=3600

month() {
  date -u -d "@$1" +%Y-%m
}

download() {
  month="$1"
  url="https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz"
  wget -qO "$TMP" "$url" || return 1
  # `set -e` does not apply inside a function used as an `if` condition, so fail
  # explicitly rather than moving a truncated archive over a good database.
  gzip -t "$TMP" || return 1
  mv "$TMP" "$DEST" || return 1
  chmod 644 "$DEST" || return 1
}

mkdir -p "$DIR"
chmod 755 "$DIR"

while :; do
  now=$(date -u +%s)
  this=$(month "$now")
  prev=$(month $((now - 32 * 24 * 60 * 60)))
  if download "$this" || download "$prev"; then
    rm -f "$TMP"
    sleep "$SLEEP_AFTER_UPDATE"
  else
    rm -f "$TMP"
    sleep "$SLEEP_AFTER_FAILURE"
  fi
done
