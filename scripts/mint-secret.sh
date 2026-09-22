#!/bin/bash
# Mint an OAuth secret for the service principal brickskate authenticates as, and
# store it in SSM Parameter Store as a SecureString. The value is piped straight
# into SSM and never printed; the secret ID (not sensitive) is printed so you can
# rotate or delete it later.
#
# Usage:
#   scripts/mint-secret.sh <service-principal-id> [ssm-parameter-name]
#
# Environment:
#   SP_ID            service principal numeric ID, alternative to the first argument
#   PARAM            SSM parameter name       (default /brickskate/client-secret)
#   DATABRICKS_PROFILE  Databricks CLI profile  (default DEFAULT)
#   AWS_PROFILE      AWS CLI profile, honoured by the aws CLI as usual
#
# The service principal ID is the numeric ID from "databricks service-principals
# list", not the client ID UUID. Requires the databricks and aws CLIs, and
# python3 for the JSON extraction.
set -euo pipefail

SP_ID="${1:-${SP_ID:-}}"
PARAM="${2:-${PARAM:-/brickskate/client-secret}}"
PROFILE="${DATABRICKS_PROFILE:-DEFAULT}"

if [ -z "$SP_ID" ]; then
  echo "usage: $0 <service-principal-id> [ssm-parameter-name]" >&2
  exit 2
fi

OUT=$(databricks service-principal-secrets-proxy create "$SP_ID" -p "$PROFILE" -o json)
SECRET_ID=$(printf '%s' "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# file:///dev/stdin keeps the value out of argv (visible in ps) and off the terminal
printf '%s' "$OUT" | python3 -c "import json,sys; sys.stdout.write(json.load(sys.stdin)['secret'])" \
  | aws ssm put-parameter --name "$PARAM" --type SecureString --value file:///dev/stdin --overwrite --output text >/dev/null

echo "OK: SSM $PARAM set. Secret id: $SECRET_ID"
echo "Rotation: re-run this script, then delete the old secret with"
echo "  databricks service-principal-secrets-proxy delete $SP_ID <old-secret-id> -p $PROFILE"
