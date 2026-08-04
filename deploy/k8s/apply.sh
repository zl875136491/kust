#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 <production|test> <backend-image-digest-ref> <frontend-image-digest-ref>" >&2
}

if [ "$#" -ne 3 ]; then
  usage
  exit 2
fi

environment="$1"
backend_image="$2"
frontend_image="$3"

: "${KUBE_API:?KUBE_API is required}"
: "${KUBE_TOKEN:?KUBE_TOKEN is required}"
: "${USER_INFO_URL:?USER_INFO_URL is required}"

namespace="${KUBE_NAMESPACE:-custom-apps}"
public_host="${PUBLIC_HOST:-k8s.1oa.com.cn}"
public_gateway_ip="${PUBLIC_GATEWAY_IP:-10.17.158.71}"
dry_run="${KUBE_DRY_RUN:-false}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template_dir="${script_dir}/templates"
kube_connect_timeout="${KUBE_CONNECT_TIMEOUT_SECONDS:-5}"
kube_request_timeout="${KUBE_REQUEST_TIMEOUT_SECONDS:-10}"
kube_request_attempts="${KUBE_REQUEST_ATTEMPTS:-3}"
deployment_wait_seconds="${KUBE_DEPLOYMENT_WAIT_SECONDS:-300}"

if ! printf '%s' "$USER_INFO_URL" | grep -Eq '^https?://[^[:space:]]+$'; then
  echo "USER_INFO_URL must be an HTTP(S) URL" >&2
  exit 2
fi

if [ "$dry_run" != "true" ] && [ "$dry_run" != "false" ]; then
  echo "KUBE_DRY_RUN must be true or false" >&2
  exit 2
fi

for value in "$kube_connect_timeout" "$kube_request_timeout" "$kube_request_attempts" "$deployment_wait_seconds"; do
  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    echo "Kubernetes timeout and retry settings must be positive integers" >&2
    exit 2
  fi
done

case "$environment" in
  production)
    app_name="kust"
    base_path="/kust"
    mongodb_database="kust"
    runtime_secret="kust-runtime"
    ;;
  test)
    app_name="kust-test"
    base_path="/kust_test"
    mongodb_database="kust_test"
    runtime_secret="kust-test-runtime"
    ;;
  *)
    usage
    exit 2
    ;;
esac

for image in "$backend_image" "$frontend_image"; do
  if ! printf '%s' "$image" | grep -Eq '^10\.17\.158\.118/kust/[a-z_]+@sha256:[0-9a-f]{64}$'; then
    echo "Deployment images must be immutable Harbor digest references" >&2
    exit 2
  fi
done

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kust-k8s.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

render() {
  local source="$1"
  local destination="$2"
  sed \
    -e "s|__APP_NAME__|${app_name}|g" \
    -e "s|__BASE_PATH__|${base_path}|g" \
    -e "s|__MONGODB_DATABASE__|${mongodb_database}|g" \
    -e "s|__RUNTIME_SECRET__|${runtime_secret}|g" \
    -e "s|__USER_INFO_URL__|${USER_INFO_URL}|g" \
    -e "s|__BACKEND_IMAGE__|${backend_image}|g" \
    -e "s|__FRONTEND_IMAGE__|${frontend_image}|g" \
    "$source" > "$destination"
}

kube_request() {
  local attempt

  for attempt in $(seq 1 "$kube_request_attempts"); do
    if curl --insecure --fail --silent --show-error \
      --connect-timeout "$kube_connect_timeout" \
      --max-time "$kube_request_timeout" \
      "$@"; then
      return 0
    fi

    if [ "$attempt" -lt "$kube_request_attempts" ]; then
      echo "Kubernetes API request failed (${attempt}/${kube_request_attempts}); retrying..." >&2
      sleep 2
    fi
  done

  return 1
}

kube_apply() {
  local api_prefix="$1"
  local plural="$2"
  local name="$3"
  local manifest="$4"
  local url="${KUBE_API}${api_prefix}/namespaces/${namespace}/${plural}/${name}?fieldManager=kust-jenkins&force=true"
  if [ "$dry_run" = "true" ]; then
    url="${url}&dryRun=All"
  fi

  kube_request \
    --request PATCH \
    --header "Authorization: Bearer ${KUBE_TOKEN}" \
    --header 'Accept: application/json' \
    --header 'Content-Type: application/apply-patch+yaml' \
    --data-binary "@${manifest}" \
    "$url" >/dev/null
  echo "Applied ${plural}/${name}."
}

wait_for_deployment() {
  local name="$1"
  local url="${KUBE_API}/apis/apps/v1/namespaces/${namespace}/deployments/${name}"
  local attempt=0 deadline payload compact generation observed available updated

  deadline=$(( $(date +%s) + deployment_wait_seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    if ! payload="$(kube_request \
      --header "Authorization: Bearer ${KUBE_TOKEN}" \
      --header 'Accept: application/json' \
      "$url")"; then
      echo "Could not read Deployment ${name} (poll ${attempt}); continuing to wait." >&2
      sleep 5
      continue
    fi
    compact="$(printf '%s' "$payload" | tr -d '\n')"
    generation="$(printf '%s' "$compact" | sed -nE 's/.*"generation"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"
    observed="$(printf '%s' "$compact" | sed -nE 's/.*"observedGeneration"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"
    available="$(printf '%s' "$compact" | sed -nE 's/.*"availableReplicas"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"
    updated="$(printf '%s' "$compact" | sed -nE 's/.*"updatedReplicas"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')"

    if [ -n "$generation" ] \
      && [ "$observed" = "$generation" ] \
      && [ "${available:-0}" -ge 1 ] \
      && [ "${updated:-0}" -ge 1 ]; then
      echo "Deployment ${name} is available."
      return 0
    fi

    if [ "$attempt" -eq 1 ] || [ $((attempt % 6)) -eq 0 ]; then
      echo "Waiting for Deployment ${name} (poll ${attempt}): generation=${generation:-unknown}, observed=${observed:-unknown}, updated=${updated:-0}, available=${available:-0}."
    fi
    sleep 5
  done

  echo "Deployment ${name} did not become available within ${deployment_wait_seconds} seconds" >&2
  return 1
}

check_public_route() {
  local attempt health
  for attempt in $(seq 1 30); do
    health="$(curl --silent --show-error --max-time 10 \
      --resolve "${public_host}:80:${public_gateway_ip}" \
      "http://${public_host}${base_path}/api/health" || true)"
    if printf '%s' "$health" | grep -q '"status":"ok"' \
      && printf '%s' "$health" | grep -q '"database":"connected"' \
      && curl --fail --silent --show-error --max-time 10 \
        --resolve "${public_host}:80:${public_gateway_ip}" \
        "http://${public_host}${base_path}/healthz" >/dev/null; then
      echo "Public route http://${public_host}${base_path} is healthy."
      return 0
    fi
    sleep 4
  done

  echo "Public route http://${public_host}${base_path} failed its health check" >&2
  return 1
}

render "${template_dir}/api-service.yaml" "${work_dir}/api-service.yaml"
render "${template_dir}/web-service.yaml" "${work_dir}/web-service.yaml"
render "${template_dir}/api-deployment.yaml" "${work_dir}/api-deployment.yaml"
render "${template_dir}/web-deployment.yaml" "${work_dir}/web-deployment.yaml"
render "${template_dir}/httproute.yaml" "${work_dir}/httproute.yaml"

kube_apply "/api/v1" services "${app_name}-api" "${work_dir}/api-service.yaml"
kube_apply "/api/v1" services "${app_name}" "${work_dir}/web-service.yaml"
kube_apply "/apis/apps/v1" deployments "${app_name}-api" "${work_dir}/api-deployment.yaml"
kube_apply "/apis/apps/v1" deployments "${app_name}" "${work_dir}/web-deployment.yaml"
kube_apply "/apis/gateway.networking.k8s.io/v1" httproutes "${app_name}" "${work_dir}/httproute.yaml"

if [ "$dry_run" = "true" ]; then
  echo "Validated ${environment} manifests with Kubernetes Server-Side Apply dry-run."
  exit 0
fi

wait_for_deployment "${app_name}-api"
wait_for_deployment "${app_name}"
check_public_route
