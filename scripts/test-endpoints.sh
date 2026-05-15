#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${API_BASE_URL:-http://127.0.0.1:4000}"
DOMAIN="${TEST_DOMAIN:-smoke-$(date +%s).com}"
PROVIDER="${TEST_PROVIDER:-openai}"
POLL_TIMEOUT_SECONDS="${TEST_POLL_TIMEOUT_SECONDS:-90}"
POLL_INTERVAL_SECONDS="${TEST_POLL_INTERVAL_SECONDS:-2}"
SERVER_LOG="${SERVER_LOG:-/tmp/geo-api-smoke-test.log}"
SHOW_RESPONSES="${SHOW_RESPONSES:-true}"
MAX_RESPONSE_CHARS="${MAX_RESPONSE_CHARS:-4000}"

SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    echo
    echo "Stopping API server (${SERVER_PID})"
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

request() {
  local method="$1"
  local path="$2"
  local expected="$3"
  local body="${4:-}"
  local output_file
  local status

  output_file="$(mktemp)"

  if [[ -n "${body}" ]]; then
    status="$(
      curl -sS -L -X "${method}" "${BASE_URL}${path}" \
        -H "Content-Type: application/json" \
        -d "${body}" \
        -o "${output_file}" \
        -w "%{http_code}"
    )"
  else
    status="$(
      curl -sS -L -X "${method}" "${BASE_URL}${path}" \
        -o "${output_file}" \
        -w "%{http_code}"
    )"
  fi

  if [[ ",${expected}," != *",${status},"* ]]; then
    echo "FAIL ${method} ${path} -> ${status}; expected ${expected}"
    echo "Response:"
    cat "${output_file}"
    echo
    rm -f "${output_file}"
    exit 1
  fi

  echo "OK   ${method} ${path} -> ${status}" >&2
  print_response "${method} ${path}" "${output_file}" >&2
  cat "${output_file}"
  rm -f "${output_file}"
}

print_response() {
  local label="$1"
  local file="$2"

  if [[ "${SHOW_RESPONSES}" != "true" ]]; then
    return
  fi

  echo "----- response: ${label} -----"
  RESPONSE_FILE="${file}" MAX_RESPONSE_CHARS="${MAX_RESPONSE_CHARS}" node <<'NODE'
const fs = require("node:fs");

const file = process.env.RESPONSE_FILE;
const maxChars = Number(process.env.MAX_RESPONSE_CHARS || 4000);
const raw = fs.readFileSync(file, "utf8");

if (!raw) {
  console.log("<empty>");
  process.exit(0);
}

let text = raw;
try {
  text = JSON.stringify(JSON.parse(raw), null, 2);
} catch {
  text = raw.replace(/\s+/g, " ").trim();
}

if (text.length > maxChars) {
  console.log(`${text.slice(0, maxChars)}\n... <truncated ${text.length - maxChars} chars>`);
} else {
  console.log(text);
}
NODE
  echo "----- end response -----"
}

json_field() {
  local expression="$1"
  node -e "
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const data = input ? JSON.parse(input) : {};
const value = ${expression};
if (value !== undefined && value !== null) process.stdout.write(String(value));
"
}

wait_for_health() {
  echo "Waiting for API health at ${BASE_URL}/health"

  for _ in {1..60}; do
    if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
      echo "API is healthy"
      return
    fi

    sleep 1
  done

  echo "API did not become healthy. Last server log lines:"
  tail -n 80 "${SERVER_LOG}" || true
  exit 1
}

wait_for_job() {
  local job_id="$1"
  local elapsed=0

  echo "Polling analysis job ${job_id}" >&2

  while (( elapsed <= POLL_TIMEOUT_SECONDS )); do
    local response
    local status

    response="$(request GET "/v1/analysis/jobs/${job_id}" "200,202")"
    status="$(printf '%s' "${response}" | json_field "data.status")"

    if [[ "${status}" == "completed" || "${status}" == "partial_success" ]]; then
      echo "Job ${job_id} finished with status ${status}" >&2
      printf '%s\n' "${response}"
      return
    fi

    if [[ "${status}" == "failed" ]]; then
      echo "Job ${job_id} failed" >&2
      printf '%s\n' "${response}"
      exit 1
    fi

    sleep "${POLL_INTERVAL_SECONDS}"
    elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
  done

  echo "Timed out waiting for job ${job_id}"
  exit 1
}

if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
  echo "API is already running at ${BASE_URL}; using existing server"
else
  echo "Building project"
  npm run build

  if [[ "${RUN_MIGRATIONS:-true}" == "true" ]]; then
    echo "Running migrations"
    npm run migrate
  fi

  echo "Starting API server with npm start"
  npm start >"${SERVER_LOG}" 2>&1 &
  SERVER_PID="$!"
  wait_for_health
fi

echo
echo "Checking documentation endpoints"
request GET "/health" "200" >/dev/null
request GET "/openapi.json" "200" >/dev/null
request GET "/docs" "200" >/dev/null

echo
echo "Submitting analysis for ${DOMAIN}"
analysis_response="$(request POST "/v1/analysis" "200,202" "{\"domain\":\"${DOMAIN}\"}")"
printf '%s\n' "${analysis_response}"

job_id="$(printf '%s' "${analysis_response}" | json_field "data.job_id")"
domain_id="$(printf '%s' "${analysis_response}" | json_field "data.domain_id ?? (data.data && data.data.domain_id)")"

if [[ -n "${job_id}" ]]; then
  job_response="$(wait_for_job "${job_id}")"
  domain_id="${domain_id:-$(printf '%s' "${job_response}" | json_field "data.domain_id ?? (data.data && data.data.domain_id)")}"
fi

if [[ -z "${domain_id}" ]]; then
  echo "Could not determine domain_id from analysis response"
  exit 1
fi

echo
echo "Checking read endpoints for domain_id=${domain_id}, provider=${PROVIDER}"
request GET "/v1/analysis/jobs/${job_id:-1}" "200,202,404" >/dev/null
request GET "/v1/domains/${domain_id}/providers/${PROVIDER}/scores" "200" >/dev/null
request GET "/v1/domains/${domain_id}/providers/${PROVIDER}/history" "200" >/dev/null
request GET "/v1/domains/${domain_id}/provider-scores" "200" >/dev/null
request GET "/v1/domains/${domain_id}/visibility-score" "200" >/dev/null
request GET "/v1/domains/${domain_id}/visibility-score/history" "200" >/dev/null
request GET "/v1/domains/${domain_id}/visibility-score/trend" "200" >/dev/null

echo
echo "All endpoint checks passed."
