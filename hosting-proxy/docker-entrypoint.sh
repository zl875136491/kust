#!/bin/sh
set -eu

: "${KUST_APP_ROUTE_PATH:?KUST_APP_ROUTE_PATH is required}"
: "${KUST_APP_UPSTREAM_PORT:?KUST_APP_UPSTREAM_PORT is required}"
: "${KUST_APP_UPSTREAM_SCHEME:?KUST_APP_UPSTREAM_SCHEME is required}"

case "$KUST_APP_UPSTREAM_SCHEME" in
  http|https) ;;
  *) echo "KUST_APP_UPSTREAM_SCHEME must be http or https" >&2; exit 64 ;;
esac
case "$KUST_APP_UPSTREAM_PORT" in
  *[!0-9]*|'') echo "KUST_APP_UPSTREAM_PORT must be numeric" >&2; exit 64 ;;
esac
case "${KUST_APP_ROOT_REDIRECT:-}" in
  ''|/*) ;;
  *) echo "KUST_APP_ROOT_REDIRECT must start with /" >&2; exit 64 ;;
esac
case "${KUST_APP_ROOT_REDIRECT:-}" in
  *[!A-Za-z0-9/_-]*) echo "KUST_APP_ROOT_REDIRECT contains invalid characters" >&2; exit 64 ;;
esac

mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp
envsubst '$KUST_APP_ROUTE_PATH $KUST_APP_UPSTREAM_PORT $KUST_APP_UPSTREAM_SCHEME $KUST_APP_ROOT_REDIRECT' \
  < /etc/kust-proxy/nginx.conf.template > /tmp/kust-proxy.conf
exec nginx -c /tmp/kust-proxy.conf -g 'daemon off;'
