#!/usr/bin/env bash
# 日本全体の OSM ファイルをダウンロードする（Geofabrik → 失敗したら openstreetmap.fr）
#   使い方: scripts/fetch-japan.sh japan.osm.pbf
set -uo pipefail
OUT=${1:-japan.osm.pbf}
URLS=(
  https://download.geofabrik.de/asia/japan-latest.osm.pbf
  https://download.geofabrik.de/asia/japan-latest.osm.pbf
  https://download.openstreetmap.fr/extracts/asia/japan-latest.osm.pbf
)
JAR=$(mktemp)
for url in "${URLS[@]}"; do
  echo "download: $url"
  # Cookie を保持しないと転送が循環することがあるため -c/-b を付ける
  if curl -fL --max-redirs 10 -c "$JAR" -b "$JAR" --retry 3 --retry-delay 20 -o "$OUT" "$url"; then
    size=$(stat -c %s "$OUT")
    if [ "$size" -gt 500000000 ]; then ls -lh "$OUT"; exit 0; fi
    echo "too small: $size bytes"
  fi
  sleep 30
done
echo "::error::日本の OSM ファイルを取得できませんでした"
exit 1
