#!/usr/bin/env bash
# Image-only rollout of the HLS converter, pinned to an immutable digest.
#
# What it does (CTO review 2026-11-02, finding 4):
#   1. Records the service's current task definition and image digest as the
#      rollback target (written to deploy-records/, never overwritten).
#   2. Builds linux/amd64 from a clean checkout and pushes ONLY the commit tag.
#      It never pushes or moves `latest`.
#   3. Registers a new revision copied from the CURRENT task definition with
#      only the container image changed to <repo>@sha256:..., so environment,
#      secrets, roles, CPU/memory, logging and health checks are preserved.
#   4. Shows the diff, and updates the service only with --apply.
#
# Nothing is changed in AWS without --apply except the image push and the
# task-definition registration (an unused revision changes nothing running).
# Use --plan to stop before both.
#
# Usage:
#   scripts/deploy-image-pinned.sh --plan           # read-only: show what would run
#   scripts/deploy-image-pinned.sh                  # build, push, register; no rollout
#   scripts/deploy-image-pinned.sh --apply          # ...and update the service
#   scripts/deploy-image-pinned.sh --rollback <task-def-arn>   # roll back to a recorded revision
#
# Production: account 442956083883, region ca-central-1.
set -euo pipefail

REGION="${AWS_REGION:-ca-central-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-442956083883}"
CLUSTER="${ECS_CLUSTER:-hls-converter-cluster}"
SERVICE="${ECS_SERVICE:-hls-converter-service}"
REPO="${ECR_REPOSITORY:-hls-converter}"
CONTAINER="${CONTAINER_NAME:-hls-converter}"
HEALTH_URL="${HEALTH_URL:-http://hls-converter-alb-119214933.ca-central-1.elb.amazonaws.com/health}"
RECORDS_DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy-records"

MODE=build
ROLLBACK_TO=""
case "${1:-}" in
  --plan) MODE=plan ;;
  --apply) MODE=apply ;;
  --rollback) MODE=rollback; ROLLBACK_TO="${2:?--rollback needs a task definition ARN}" ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

aws_() { aws --region "$REGION" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }

ACCOUNT="$(aws_ sts get-caller-identity --query Account --output text)"
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "AWS account is $ACCOUNT, expected $EXPECTED_ACCOUNT"
[ "$REGION" = "ca-central-1" ] || echo "WARNING: region is $REGION, production is ca-central-1" >&2

CURRENT_TD="$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)"
[ -n "$CURRENT_TD" ] && [ "$CURRENT_TD" != "None" ] || die "service $SERVICE not found in $REGION"
CURRENT_IMAGE="$(aws_ ecs describe-task-definition --task-definition "$CURRENT_TD" \
  --query "taskDefinition.containerDefinitions[?name=='$CONTAINER'].image | [0]" --output text)"
# Resolve the running image to its digest (a tag like :latest can move later).
CURRENT_DIGEST="$(aws_ ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --query 'taskArns[0]' --output text \
  | xargs -I{} aws --region "$REGION" ecs describe-tasks --cluster "$CLUSTER" --tasks {} \
      --query "tasks[0].containers[?name=='$CONTAINER'].imageDigest | [0]" --output text 2>/dev/null || true)"

echo "Current task definition: $CURRENT_TD"
echo "Current image:           $CURRENT_IMAGE"
echo "Running digest:          ${CURRENT_DIGEST:-unknown}"

if [ "$MODE" = rollback ]; then
  aws_ ecs describe-task-definition --task-definition "$ROLLBACK_TO" >/dev/null || die "no such task definition: $ROLLBACK_TO"
  echo "Rolling back $SERVICE to $ROLLBACK_TO"
  aws_ ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$ROLLBACK_TO" >/dev/null
  aws_ ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
  curl -fsS "$HEALTH_URL" && echo
  echo "Rolled back."
  exit 0
fi

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
SHA="$(git rev-parse --short=7 HEAD)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

if [ "$MODE" = plan ]; then
  echo
  echo "Plan: build $REGISTRY/$REPO:$SHA (linux/amd64), push that tag only,"
  echo "register a copy of $CURRENT_TD with image $REGISTRY/$REPO@<digest>,"
  echo "then (with --apply) update $SERVICE. Rollback target: $CURRENT_TD."
  exit 0
fi

if aws_ ecr describe-images --repository-name "$REPO" --image-ids imageTag="$SHA" >/dev/null 2>&1; then
  echo "Tag $SHA already exists in ECR; reusing it (not rebuilding)."
else
  aws_ ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker buildx build --platform linux/amd64 -t "$REGISTRY/$REPO:$SHA" --push .
fi
DIGEST="$(aws_ ecr describe-images --repository-name "$REPO" --image-ids imageTag="$SHA" \
  --query 'imageDetails[0].imageDigest' --output text)"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not resolve digest for $SHA"
NEW_IMAGE="$REGISTRY/$REPO@$DIGEST"

# Copy the current task definition, changing only this container's image.
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
aws_ ecs describe-task-definition --task-definition "$CURRENT_TD" --query taskDefinition > "$WORK/current.json"
python3 - "$WORK/current.json" "$WORK/new.json" "$CONTAINER" "$NEW_IMAGE" <<'PY'
import json, sys
src, dst, name, image = sys.argv[1:]
td = json.load(open(src))
for k in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
          "registeredAt", "registeredBy", "deregisteredAt"):
    td.pop(k, None)
hits = [c for c in td["containerDefinitions"] if c["name"] == name]
if len(hits) != 1:
    sys.exit(f"expected one container named {name}, found {len(hits)}")
hits[0]["image"] = image
json.dump(td, open(dst, "w"), indent=2, sort_keys=True)
PY
python3 - "$WORK/current.json" "$WORK/new.json" <<'PY'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:])
for k in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
          "registeredAt", "registeredBy", "deregisteredAt"):
    a.pop(k, None)
changed = [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
assert changed == ["containerDefinitions"], f"unexpected changes: {changed}"
for x, y in zip(a["containerDefinitions"], b["containerDefinitions"]):
    diff = [k for k in sorted(set(x) | set(y)) if x.get(k) != y.get(k)]
    assert diff in ([], ["image"]), f"unexpected container changes: {diff}"
    if diff:
        print(f"  image: {x['image']}\n      -> {y['image']}")
print("Only the image changes; env, secrets, roles and resources are preserved.")
PY

NEW_TD="$(aws_ ecs register-task-definition --cli-input-json "file://$WORK/new.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

mkdir -p "$RECORDS_DIR"
RECORD="$RECORDS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$SHA.txt"
cat > "$RECORD" <<EOF
commit:              $(git rev-parse HEAD)
new image:           $NEW_IMAGE
new task definition: $NEW_TD
rollback target:     $CURRENT_TD
rollback image:      $CURRENT_IMAGE (running digest ${CURRENT_DIGEST:-unknown})
rollback command:    scripts/deploy-image-pinned.sh --rollback $CURRENT_TD
EOF
echo "Recorded: $RECORD"
cat "$RECORD"

if [ "$MODE" != apply ]; then
  echo
  echo "Registered but NOT rolled out. To roll out: rerun with --apply (reuses the same image)."
  exit 0
fi

aws_ ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD" >/dev/null
echo "Waiting for $SERVICE to stabilise..."
aws_ ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
RUNNING="$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)"
[ "$RUNNING" = "$NEW_TD" ] || die "service runs $RUNNING, not $NEW_TD (circuit breaker rollback?)"
curl -fsS "$HEALTH_URL" && echo
# The new build serves no test page: GET / is 404 there and 200 on the old image.
ROOT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${HEALTH_URL%/health}/")"
[ "$ROOT_STATUS" = 404 ] || die "GET / returned $ROOT_STATUS; the new image does not look live"
echo "Deployed $NEW_IMAGE. Roll back with: scripts/deploy-image-pinned.sh --rollback $CURRENT_TD"
