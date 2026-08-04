#!/bin/sh
set -eu

base_path="${APP_BASE_PATH:-/}"
web_root="${KUST_WEB_ROOT:-/usr/share/nginx/html}"
base_path="/${base_path#/}"
base_path="${base_path%/}"
if [ -z "$base_path" ]; then
  base_path="/"
fi

if ! printf '%s' "$base_path" | grep -Eq '^/([A-Za-z0-9_-]+)?$'; then
  echo "APP_BASE_PATH must be / or a single URL path segment" >&2
  exit 1
fi

if [ "$base_path" = "/" ]; then
  asset_prefix="/"
else
  asset_prefix="${base_path}/"
fi

find "$web_root" -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' \) \
  -exec sed -i.kust-bak \
    -e "s|/__KUST_BASE_PATH__/|${asset_prefix}|g" \
    -e "s|__KUST_BASE_PATH__|${base_path}|g" \
    {} +

find "$web_root" -type f -name '*.kust-bak' -delete
