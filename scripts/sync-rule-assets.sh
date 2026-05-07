#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-/opt/1panel/www/sites/hy2/index/rules}"
TMP_ROOT="${TMPDIR:-/tmp}"
WORK_DIR="$(mktemp -d "$TMP_ROOT/rule-sync.XXXXXX")"
STAGE_DIR="$WORK_DIR/stage"
mkdir -p "$STAGE_DIR"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

export STAGE_DIR
python3 - <<"PY"
import hashlib
import json
import os
import ssl
import sys
import urllib.request
from datetime import datetime, timezone

stage_dir = os.environ["STAGE_DIR"]
user_agent = "subscription-service-rule-sync/1.0"
files = [
    ("geoip-lite.dat", "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat", 1024),
    ("geosite-lite.dat", "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite-lite.dat", 1024),
    ("country-lite.mmdb", "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country-lite.mmdb", 1024),
    ("private.txt", "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt", 1),
    ("reject.txt", "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt", 1),
    ("direct.txt", "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt", 1),
    ("apple.txt", "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt", 1),
    ("proxy.txt", "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt", 1),
]
ssl_ctx = ssl.create_default_context()
manifest = {
    "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source": "jsdelivr",
    "files": [],
}
for name, url, min_size in files:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    target_path = os.path.join(stage_dir, name)
    with urllib.request.urlopen(req, timeout=90, context=ssl_ctx) as response:
        data = response.read()
    with open(target_path, "wb") as handle:
        handle.write(data)
    size = os.path.getsize(target_path)
    if size < min_size:
        raise SystemExit(f"downloaded file too small: {name} size={size} min={min_size}")
    digest = hashlib.sha256(data).hexdigest()
    manifest["files"].append({
        "name": name,
        "url": url,
        "size": size,
        "sha256": digest,
    })
manifest_path = os.path.join(stage_dir, "manifest.json")
with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

install -d -m 755 "$TARGET_DIR"
for filename in geoip-lite.dat geosite-lite.dat country-lite.mmdb private.txt reject.txt direct.txt apple.txt proxy.txt manifest.json; do
  install -m 644 "$STAGE_DIR/$filename" "$TARGET_DIR/$filename"
done

echo "Synced rule assets to $TARGET_DIR"
ls -lh "$TARGET_DIR"
