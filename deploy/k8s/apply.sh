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

namespace="${KUBE_NAMESPACE:-custom-apps}"
public_host="${PUBLIC_HOST:-k8s.1oa.com.cn}"
public_gateway_ip="${PUBLIC_GATEWAY_IP:-10.17.158.71}"
dry_run="${KUBE_DRY_RUN:-false}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template_dir="${script_dir}/templates"

if [ "$dry_run" != "true" ] && [ "$dry_run" != "false" ]; then
  echo "KUBE_DRY_RUN must be true or false" >&2
  exit 2
fi

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
    -e "s|__BACKEND_IMAGE__|${backend_image}|g" \
    -e "s|__FRONTEND_IMAGE__|${frontend_image}|g" \
    "$source" > "$destination"
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

  curl --insecure --fail --silent --show-error \
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
  local attempt payload compact generation observed available updated

  for attempt in $(seq 1 60); do
    payload="$(curl --insecure --fail --silent --show-error \
      --header "Authorization: Bearer ${KUBE_TOKEN}" \
      --header 'Accept: application/json' \
      "$url")"
    compact="$(printf '%s' "$payload" | tr -d '\n')"
    generation="$(printf '%s' "$compact" | sed -nE 's/.*"generation":([0-9]+).*/\1/p')"
    observed="$(printf '%s' "$compact" | sed -nE 's/.*"observedGeneration":([0-9]+).*/\1/p')"
    available="$(printf '%s' "$compact" | sed -nE 's/.*"availableReplicas":([0-9]+).*/\1/p')"
    updated="$(printf '%s' "$compact" | sed -nE 's/.*"updatedReplicas":([0-9]+).*/\1/p')"

    if [ -n "$generation" ] \
      && [ "$observed" = "$generation" ] \
      && [ "${available:-0}" -ge 1 ] \
      && [ "${updated:-0}" -ge 1 ]; then
      echo "Deployment ${name} is available."
      return 0
    fi
    sleep 5
  done

  echo "Deployment ${name} did not become available within 5 minutes" >&2
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
