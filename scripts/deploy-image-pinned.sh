#!/usr/bin/env bash
# Image-only rollout of the HLS converter, pinned to immutable digests both ways.
#
#   scripts/deploy-image-pinned.sh --plan              read-only: what would run
#   scripts/deploy-image-pinned.sh                     prepare rollback + build, push, register; no rollout
#   scripts/deploy-image-pinned.sh --apply             ...and update the service
#   scripts/deploy-image-pinned.sh --rollback <arn>    roll back to a digest-pinned revision
#
# Before anything new is built (CTO re-review 2026-11-02, R5):
#   * every running task's image digest is read; they must agree and be a
#     real sha256 digest present in ECR, or the script stops;
#   * a ROLLBACK revision is registered: the current task definition with only
#     the image changed to <repo>@<that digest> (or the current revision itself
#     when it is already pinned to it), and its image is read back and checked;
#   * the record in deploy-records/ names that revision, its digest and the
#     exact rollback command.
# The new revision is the current one with only the image changed to
# <repo>@<new digest>; nothing else in the task definition may differ.
# --rollback accepts only a revision whose image is pinned by a digest that
# exists in ECR, and checks afterwards that the tasks run that digest.
# It never pushes or moves `latest`. Production: 442956083883, ca-central-1.
set -euo pipefail

REGION="${AWS_REGION:-ca-central-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-442956083883}"
CLUSTER="${ECS_CLUSTER:-hls-converter-cluster}"
SERVICE="${ECS_SERVICE:-hls-converter-service}"
REPO="${ECR_REPOSITORY:-hls-converter}"
CONTAINER="${CONTAINER_NAME:-hls-converter}"
HEALTH_URL="${HEALTH_URL:-http://hls-converter-alb-119214933.ca-central-1.elb.amazonaws.com/health}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECORDS_DIR="${RECORDS_DIR:-$HERE/../deploy-records}"
TD="python3 $HERE/deploy_td.py"

MODE=build
ROLLBACK_TO=""
case "${1:-}" in
  --plan) MODE=plan ;;
  --apply) MODE=apply ;;
  --rollback) MODE=rollback; ROLLBACK_TO="${2:?--rollback needs a task definition ARN}" ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

aws_() { aws --region "$REGION" --output json "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
jfield() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))
for k in sys.argv[2:]: d=d[int(k)] if isinstance(d,list) else d[k]
print(d)' "$@"; }

aws_ sts get-caller-identity > "$WORK/id.json"
ACCOUNT="$(jfield "$WORK/id.json" Account)"
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "AWS account is $ACCOUNT, expected $EXPECTED_ACCOUNT"
[ "$REGION" = "ca-central-1" ] || echo "WARNING: region is $REGION, production is ca-central-1" >&2
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

digest_in_ecr() {  # $1 = sha256:...
  aws_ ecr describe-images --repository-name "$REPO" --image-ids imageDigest="$1" >/dev/null 2>&1
}

running_digest() {  # the one digest every running task of the service runs
  aws_ ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING > "$WORK/arns.json"
  python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["taskArns"]))' "$WORK/arns.json" > "$WORK/arns.txt"
  [ -s "$WORK/arns.txt" ] || die "no running tasks: cannot establish the running digest"
  # shellcheck disable=SC2046
  aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks $(cat "$WORK/arns.txt") > "$WORK/tasks.json"
  $TD running-digests "$WORK/tasks.json" "$CONTAINER" | sort -u > "$WORK/digests.txt"
  [ "$(wc -l < "$WORK/digests.txt")" -eq 1 ] || die "running tasks disagree on the image digest: $(tr '\n' ' ' < "$WORK/digests.txt")"
  local d; d="$(cat "$WORK/digests.txt")"
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || die "running image digest is unknown ($d)"
  echo "$d"
}

verify_running() {  # $1 = expected task def ARN, $2 = expected digest
  aws_ ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" > "$WORK/svc.json"
  local running; running="$(jfield "$WORK/svc.json" services 0 taskDefinition)"
  [ "$running" = "$1" ] || die "service runs $running, not $1 (circuit breaker rollback?)"
  local d; d="$(running_digest)"
  [ "$d" = "$2" ] || die "tasks run $d, expected $2"
}

aws_ ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" > "$WORK/svc.json"
CURRENT_TD="$(jfield "$WORK/svc.json" services 0 taskDefinition 2>/dev/null || true)"
[ -n "$CURRENT_TD" ] || die "service $SERVICE not found in $REGION"
aws_ ecs describe-task-definition --task-definition "$CURRENT_TD" > "$WORK/current.json"
CURRENT_IMAGE="$($TD image-of "$WORK/current.json" "$CONTAINER")"
echo "Current task definition: $CURRENT_TD"
echo "Current image:           $CURRENT_IMAGE"

if [ "$MODE" = rollback ]; then
  aws_ ecs describe-task-definition --task-definition "$ROLLBACK_TO" > "$WORK/target.json" \
    || die "no such task definition: $ROLLBACK_TO"
  TARGET_IMAGE="$($TD image-of "$WORK/target.json" "$CONTAINER")"
  TARGET_DIGEST="$($TD digest-of "$TARGET_IMAGE")"
  [ -n "$TARGET_DIGEST" ] || die "$ROLLBACK_TO runs $TARGET_IMAGE, which is not pinned by digest; refusing"
  digest_in_ecr "$TARGET_DIGEST" || die "digest $TARGET_DIGEST is not in ECR $REPO; refusing"
  echo "Rolling back $SERVICE to $ROLLBACK_TO ($TARGET_IMAGE)"
  aws_ ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$ROLLBACK_TO" >/dev/null
  aws_ ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
  verify_running "$ROLLBACK_TO" "$TARGET_DIGEST"
  curl -fsS "$HEALTH_URL" && echo
  echo "Rolled back; tasks run $TARGET_DIGEST."
  exit 0
fi

CURRENT_DIGEST="$(running_digest)"
digest_in_ecr "$CURRENT_DIGEST" || die "running digest $CURRENT_DIGEST is not in ECR $REPO; no safe rollback"
echo "Running digest:          $CURRENT_DIGEST"

if [ "$MODE" = plan ]; then
  echo
  echo "Plan: register a rollback revision pinned to $REPO@$CURRENT_DIGEST; build $REPO:<commit>"
  echo "(linux/amd64), push that tag only; register a copy of $CURRENT_TD with image"
  echo "$REPO@<new digest>; with --apply, update $SERVICE and verify the tasks run it."
  exit 0
fi

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes"
SHA="$(git rev-parse --short=7 HEAD)"

# 1. The rollback revision, prepared and verified before anything changes.
ROLLBACK_IMAGE="$REGISTRY/$REPO@$CURRENT_DIGEST"
if [ "$CURRENT_IMAGE" = "$ROLLBACK_IMAGE" ]; then
  ROLLBACK_TD="$CURRENT_TD"
else
  $TD pin "$WORK/current.json" "$CONTAINER" "$ROLLBACK_IMAGE" "$WORK/rollback.json"
  $TD same-but-image "$WORK/current.json" "$WORK/rollback.json" >/dev/null
  aws_ ecs register-task-definition --cli-input-json "file://$WORK/rollback.json" > "$WORK/rollback-reg.json"
  ROLLBACK_TD="$(jfield "$WORK/rollback-reg.json" taskDefinition taskDefinitionArn)"
fi
aws_ ecs describe-task-definition --task-definition "$ROLLBACK_TD" > "$WORK/rollback-check.json"
[ "$($TD image-of "$WORK/rollback-check.json" "$CONTAINER")" = "$ROLLBACK_IMAGE" ] \
  || die "rollback revision $ROLLBACK_TD does not run $ROLLBACK_IMAGE"
$TD same-but-image "$WORK/current.json" "$WORK/rollback-check.json" >/dev/null
echo "Rollback revision:       $ROLLBACK_TD ($ROLLBACK_IMAGE)"

# 2. The new image: the commit tag only, never latest.
if aws_ ecr describe-images --repository-name "$REPO" --image-ids imageTag="$SHA" > "$WORK/img.json" 2>/dev/null; then
  echo "Tag $SHA already exists in ECR; reusing it (not rebuilding)."
else
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker buildx build --platform linux/amd64 -t "$REGISTRY/$REPO:$SHA" --push .
  aws_ ecr describe-images --repository-name "$REPO" --image-ids imageTag="$SHA" > "$WORK/img.json"
fi
DIGEST="$(jfield "$WORK/img.json" imageDetails 0 imageDigest)"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not resolve digest for $SHA"
NEW_IMAGE="$REGISTRY/$REPO@$DIGEST"

# 3. The new revision: the current one with only the image changed.
$TD pin "$WORK/current.json" "$CONTAINER" "$NEW_IMAGE" "$WORK/new.json"
$TD same-but-image "$WORK/current.json" "$WORK/new.json"
echo "Only the image changes; env, secrets, roles and resources are preserved."
aws_ ecs register-task-definition --cli-input-json "file://$WORK/new.json" > "$WORK/new-reg.json"
NEW_TD="$(jfield "$WORK/new-reg.json" taskDefinition taskDefinitionArn)"

mkdir -p "$RECORDS_DIR"
RECORD="$RECORDS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$SHA.txt"
cat > "$RECORD" <<REC
commit:              $(git rev-parse HEAD)
previous revision:   $CURRENT_TD ($CURRENT_IMAGE)
previous digest:     $CURRENT_DIGEST
rollback revision:   $ROLLBACK_TD ($ROLLBACK_IMAGE)
new image:           $NEW_IMAGE
new revision:        $NEW_TD
rollback command:    scripts/deploy-image-pinned.sh --rollback $ROLLBACK_TD
REC
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
verify_running "$NEW_TD" "$DIGEST"
curl -fsS "$HEALTH_URL" && echo
# The new build serves no test page: GET / is 404 there and 200 on the old image.
ROOT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${HEALTH_URL%/health}/")"
[ "$ROOT_STATUS" = 404 ] || die "GET / returned $ROOT_STATUS; the new image does not look live"
echo "Deployed $NEW_IMAGE. Roll back with: scripts/deploy-image-pinned.sh --rollback $ROLLBACK_TD"
