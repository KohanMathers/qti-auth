#!/bin/sh
set -eu

DIR=/var/lib/qtiauth/geoip
DEST="$DIR/dbip-country-lite.csv.gz"
TMP="$DIR/dbip-country-lite.csv.gz.tmp"

month() {
  date -u -d "@$1" +%Y-%m
}

download() {
  month="$1"
  url="https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz"
  wget -qO "$TMP" "$url" || return 1
  gzip -t "$TMP"
  mv "$TMP" "$DEST"
  chmod 644 "$DEST"
}

mkdir -p "$DIR"
chmod 755 "$DIR"

while :; do
  now=$(date -u +%s)
  this=$(month "$now")
  prev=$(month $((now - 32 * 24 * 60 * 60)))
  if download "$this" || download "$prev"; then
    rm -f "$TMP"
    sleep 2592000
  else
    rm -f "$TMP"
    sleep 3600
  fi
done
