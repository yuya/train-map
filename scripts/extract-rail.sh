#!/usr/bin/env bash
# 日本全体の OSM ファイルから鉄道の系統（route / route_master）と、その線路・駅だけを抜き出して OPL にする
#   使い方: scripts/extract-rail.sh japan-latest.osm.pbf rail.opl
set -euo pipefail
PBF=${1:-japan-latest.osm.pbf}
OUT=${2:-rail.opl}
TYPES=train,subway,light_rail,monorail,tram
TMP=$(mktemp -d)
osmium tags-filter "$PBF" "r/route=$TYPES" "r/route_master=$TYPES" -o "$TMP/rail.osm.pbf" --overwrite
osmium add-locations-to-ways "$TMP/rail.osm.pbf" -o "$TMP/rail-loc.osm.pbf" --overwrite
osmium cat "$TMP/rail-loc.osm.pbf" -f opl,add_metadata=false,locations_on_ways=true -o "$OUT" --overwrite
rm -rf "$TMP"
ls -lh "$OUT"
