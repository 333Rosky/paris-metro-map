#!/usr/bin/env bash
# Deploys the relay to AWS: key into SSM, stack, then the function code.
#
#   AWS_PROFILE=… relay/aws/deploy.sh
#
# Reads PRIM_API_KEY from the environment or from .env; the key goes to an SSM
# SecureString and nowhere else. AWS_REGION defaults to eu-west-3 (Paris).
set -euo pipefail
cd "$(dirname "$0")/../.."

STACK=${STACK:-paris-metro-relay}
PARAMETER=${KEY_PARAMETER:-/paris-metro-relay/prim-api-key}
export AWS_REGION=${AWS_REGION:-eu-west-3}

if [ -z "${PRIM_API_KEY:-}" ] && [ -f .env ]; then
  PRIM_API_KEY=$(grep -m1 '^PRIM_API_KEY=' .env | cut -d= -f2-)
fi
: "${PRIM_API_KEY:?PRIM_API_KEY is not set (environment or .env)}"

echo "1/3 key -> SSM $PARAMETER"
# Through stdin: the key never appears in a command line.
printf %s "$PRIM_API_KEY" | aws ssm put-parameter --name "$PARAMETER" --type SecureString --overwrite \
  --value file:///dev/stdin --query Version --output text >/dev/null

echo "2/3 stack $STACK ($AWS_REGION)"
aws cloudformation deploy --stack-name "$STACK" --template-file relay/aws/template.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides "KeyParameter=$PARAMETER" \
  --tags project=paris-metro-map --no-fail-on-empty-changeset

echo "3/3 code"
ZIP=$(mktemp --suffix=.zip)
trap 'rm -f "$ZIP"' EXIT
python3 - "$ZIP" <<'EOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for name in ("core.mjs", "lambda.mjs"):
        z.write(f"relay/{name}", name)
EOF
aws lambda update-function-code --function-name "$STACK" --zip-file "fileb://$ZIP" --query LastUpdateStatus --output text >/dev/null
aws lambda wait function-updated-v2 --function-name "$STACK"

URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue" --output text)
echo "relay: $URL"
echo "next:  gh variable set REALTIME_URL --body \"$URL\"   (the site build reads it as VITE_REALTIME_URL)"
