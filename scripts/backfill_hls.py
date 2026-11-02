#!/usr/bin/env python3
"""Backfill HLS for posts whose video never got a rendition, and sweep away HLS
that must no longer exist.

DRY RUN BY DEFAULT: lists what it would do and sends nothing. --apply sends the
requests, one at a time, to the converter. The converter does every production
write (uploads FlutterFlow/converted/<postId>/hls/, sets or clears hls_url) and
re-checks each post itself, so this script cannot convert or remove anything
the converter's policy (src/services/hls-policy.ts) would refuse.
Running --apply needs explicit CTO authorization.

Reads come from a READ ONLY, rolled-back query through the Supabase Management
API (same token file as docs/v1.1.0/build45/ro_query.py). The script itself
never writes to the database.

  python3 scripts/backfill_hls.py                                   # dry run, all groups
  python3 scripts/backfill_hls.py --only unified --limit 5          # one group, 5 posts
  python3 scripts/backfill_hls.py --exclude-file vp9.txt --checkpoint run1.jsonl --apply --limit 5
  python3 scripts/backfill_hls.py --sweep                           # dry run of revocations
  python3 scripts/backfill_hls.py --sweep --checkpoint sweep1.jsonl --apply

Groups (conversion):
  legacy        app posts with a public FlutterFlow video_url, no hls_url, since --since
  multiaccount  posts under Videos/multi-account/ with no hls_url (any date)
  unified       single-video posts with private media (unfiltered bucket), no hls_url
Every group only includes posts the converter would accept: not hidden, not VIP,
not expired (private media: no expiry at all), published in a feed, and the
author has no account-deletion job.

Sweep (--sweep): posts whose converted/<id>/hls/ copy must go (hidden, VIP,
expired, unpublished, author being deleted) and copies whose post row is gone.
Folders that any other post's hls_url points at are never listed.

Safety (CTO review 2026-11-02, finding 6):
  * --apply needs --checkpoint FILE. Each id is written there BEFORE its request
    is sent, and its outcome after.
  * The run STOPS at the first uncertain outcome (timeout, connection error, 5xx,
    unexpected status) and exits non-zero. The converter may still be working on
    that post, so it is never sent again automatically.
  * On the next run, ids in the checkpoint are reconciled against the database
    first: settled ones are skipped; unsettled ones block the run unless
    --resubmit-unsettled is given AND they were attempted more than
    --settle-minutes ago.
  * An id is only marked done after the database confirms it (hls_url on the
    post's own folder, or gone for --sweep). A failed or impossible check leaves
    it unsettled and the exit status non-zero; the next run re-checks it and
    resends it only with --resubmit-unsettled (no wait: the converter answered,
    so that request had finished).
  * Duplicates are harmless by construction (hls-converter#2): each attempt
    writes its own folder and only the first to finish publishes; the waits
    above only avoid wasted work.

Output never prints full post ids or paths (only the first 8 characters).
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.error, urllib.request

REF = "ohfzckfunpsjncjjzfyz"
CONVERTER = os.environ.get("HLS_CONVERTER_URL",
                           "http://hls-converter-alb-119214933.ca-central-1.elb.amazonaws.com")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
UUID_ANY = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# Mirrors conversionRefusal() in src/services/hls-policy.ts. The converter is
# the authority; this only keeps refusals out of the candidate list.
ELIGIBLE = """
  coalesce(p.is_hidden, false) = false and coalesce(p.is_vip, false) = false
  and not exists (select 1 from public.account_deletion_jobs j where j.profile_id = p.profile_id)
"""

QUERY = """
select g, id::text as id, bucket, path, created_at from (
  select 'legacy' as g, p.id, 'FlutterFlow' as bucket,
         substring(p.video_url from '/storage/v1/object/public/FlutterFlow/([^?]+)') as path,
         p.created_at
  from public.posts p
  where p.hls_url is null and p.media_path is null
    and p.video_url like '%/storage/v1/object/public/FlutterFlow/Videos/%'
    and p.video_url not like '%/multi-account/%'
    and p.video_url ~* '\\.(mp4|mov|m4v)(\\?|$)'
    and p.created_at >= '{since}'
    and (p.expires_at is null or p.expires_at > now())
    and {eligible}
  union all
  select 'multiaccount', p.id, 'FlutterFlow',
         substring(p.video_url from '/storage/v1/object/public/FlutterFlow/([^?]+)'),
         p.created_at
  from public.posts p
  where p.hls_url is null and p.media_path is null
    and p.video_url like '%/storage/v1/object/public/FlutterFlow/Videos/multi-account/%'
    and (p.expires_at is null or p.expires_at > now())
    and {eligible}
  union all
  select 'unified', p.id, p.media_bucket, p.media_path, p.created_at
  from public.posts p
  where p.hls_url is null and p.media_bucket = 'unfiltered' and p.media_path is not null
    and coalesce(p.media_count, 1) = 1 and p.post_type = 'video'
    and (p.channel = 'unfiltered' or p.in_general_feed is true)
    and p.type in ('UNFILTERED', 'PUBLIC')
    and p.expires_at is null
    and {eligible}
) c
where path is not null
order by created_at
""".replace("{eligible}", ELIGIBLE)

# Copies that must go. Only folders named by a UUID, and never one that another
# post's hls_url points at (older batch migrations named folders after files).
SWEEP_QUERY = """
with folders as (
  select distinct lower(split_part(o.name, '/', 2)) as fid
  from storage.objects o
  where o.bucket_id = 'FlutterFlow' and o.name like 'converted/%/hls/%'
    and split_part(o.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
select f.fid as id,
  case
    when p.id is null then 'post deleted'
    when coalesce(p.is_hidden, false) then 'hidden'
    when coalesce(p.is_vip, false) then 'vip'
    when exists (select 1 from public.account_deletion_jobs j where j.profile_id = p.profile_id) then 'author deletion'
    when p.media_path is not null and p.expires_at is not null then 'private media with expiry'
    when p.media_path is null and p.expires_at is not null and p.expires_at <= now() then 'expired'
    when p.media_path is not null and coalesce(p.media_count, 1) <> 1 then 'carousel'
    when p.media_path is not null and not (p.channel = 'unfiltered' or p.in_general_feed is true) then 'unpublished'
    when p.media_path is not null and p.type not in ('UNFILTERED', 'PUBLIC') then 'access type'
    else null
  end as reason
from folders f
left join public.posts p on p.id::text = f.fid
where not exists (
  select 1 from public.posts o
  where o.id::text <> f.fid and o.hls_url like '%/converted/' || f.fid || '/hls/%'
)
"""

VERIFY = """
select p.id::text as id,
       p.hls_url is not null as has_hls,
       coalesce(p.hls_url like '%/converted/' || lower(p.id::text) || '/hls/%', false) as own_hls
from public.posts p where p.id::text = any (array[{ids}])
"""

UNCERTAIN = "uncertain"
# Events that leave an id unsettled. "attempt"/UNCERTAIN: no answer, the
# converter may still be working. "reported": the converter answered done but
# the database check has not run. "unverified": it ran and HLS is not there.
UNSETTLED = ("attempt", UNCERTAIN, "reported", "unverified")
ANSWERED = ("reported", "unverified")


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def mgmt_query(sql):
    tok = open(os.path.expanduser("~/.supabase/access-token")).read().strip()
    q = "begin transaction read only;\nset local statement_timeout='30s';\n" + sql + ";\nrollback;"
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query", method="POST",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                 "User-Agent": "hls-backfill-ro"})
    with urllib.request.urlopen(req, timeout=90) as r:
        rows = json.loads(r.read())
    if isinstance(rows, dict):
        sys.exit(f"query failed: {str(rows)[:300]}")
    return rows


def post_json(route, payload, api_key, timeout):
    """(status, body dict). status 0 = no answer (timeout or connection error)."""
    req = urllib.request.Request(f"{CONVERTER}{route}", method="POST",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            try:
                return r.status, json.loads(r.read().decode() or "{}")
            except ValueError:
                return r.status, {}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}
    except Exception as e:
        return 0, {"error": type(e).__name__}


def classify(mode, status, body):
    """'reported' (the converter says done; not settled until verified in the
    database), 'refused' (the converter said no; safe, not retried) or UNCERTAIN."""
    if status == 200 and body.get("success") is True:
        return "reported"
    if status in (403, 409):
        return "refused"
    return UNCERTAIN  # 0 (timeout/connection), 400, 5xx, or a 200 without success


class Checkpoint:
    """Append-only JSON lines: {"id", "event": "attempt"|outcome, "at", ...}."""

    def __init__(self, path):
        self.path = path
        self.last = {}  # id -> last record
        if os.path.exists(path):
            with open(path) as fh:
                lines = fh.readlines()
            for line in lines:
                line = line.strip()
                if line:
                    rec = json.loads(line)
                    self.last[rec["id"]] = rec

    def write(self, rec):
        rec = {**rec, "at": now_iso()}
        with open(self.path, "a") as f:
            f.write(json.dumps(rec) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.last[rec["id"]] = rec

    def unsettled(self):
        """Ids not known to be finished: in flight or uncertain (the converter may
        still be working), or reported done but not (yet) verified."""
        return {i: r for i, r in self.last.items() if r["event"] in UNSETTLED}


def short(s):
    return (s or "")[:8]


def verify_rows(ids):
    if not ids:
        return {}
    arr = ",".join("'" + x + "'" for x in ids)
    return {r["id"]: r for r in mgmt_query(VERIFY.replace("{ids}", arr))}


def reconcile(cp, mode, a):
    """Settle ids left unsettled by an earlier run. Returns ids that may be resubmitted."""
    pending = cp.unsettled()
    if not pending:
        return set()
    state = verify_rows(list(pending))
    resubmit, blocked = set(), []
    for pid, rec in pending.items():
        row = state.get(pid)
        if mode == "convert" and row and row["own_hls"]:
            cp.write({"id": pid, "event": "done", "via": "reconciled"})
        elif mode == "convert" and row is None:
            # Post deleted meanwhile; any copy it left is the sweep's job.
            cp.write({"id": pid, "event": "refused", "via": "reconciled: post gone"})
        elif mode == "sweep" and (row is None or not row["has_hls"]):
            # Row gone or hls_url cleared: the revoke finished, or the next sweep
            # dry run will list the folder again.
            cp.write({"id": pid, "event": "done", "via": "reconciled"})
        elif rec["event"] in ANSWERED:
            # The converter answered, so that request has finished; its result
            # is just not in the database. Safe to send again when asked.
            cp.write({"id": pid, "event": "unverified", "via": "reconciled"})
            if a.resubmit_unsettled:
                resubmit.add(pid)
            else:
                blocked.append((pid, None))
        else:
            # No answer: the converter may still be working. A duplicate would
            # be harmless (attempts use separate folders and only the first to
            # finish publishes), but it is only sent when asked, after a pause.
            age = (dt.datetime.now(dt.timezone.utc)
                   - dt.datetime.strptime(rec["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc))
            if a.resubmit_unsettled and age.total_seconds() >= a.settle_minutes * 60:
                resubmit.add(pid)
            else:
                blocked.append((pid, int(age.total_seconds() // 60)))
    if blocked:
        print("UNSETTLED from an earlier run:")
        for pid, mins in blocked:
            if mins is None:
                print(f"  post {short(pid)}…  converter answered done, but HLS is not in the database")
            else:
                print(f"  post {short(pid)}…  no answer, attempted {mins} min ago (may still be running)")
        sys.exit(f"stopping: {len(blocked)} unsettled id(s). Check the converter logs; re-run with "
                 f"--resubmit-unsettled once they are older than --settle-minutes ({a.settle_minutes}).")
    return resubmit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="legacy,multiaccount,unified")
    ap.add_argument("--since", default="2026-10-27T00:00:00Z", help="legacy group start (UTC)")
    ap.add_argument("--exclude-file", help="post ids to skip, one per line (e.g. the VP9 repair targets)")
    ap.add_argument("--limit", type=int, default=0, help="at most N requests this run")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    ap.add_argument("--timeout", type=float, default=600.0,
                    help="seconds to wait per request (the ALB itself times out after ~60 s; "
                         "a longer conversion then counts as uncertain and stops the run)")
    ap.add_argument("--sweep", action="store_true", help="revoke HLS that must no longer exist")
    ap.add_argument("--checkpoint", help="append-only record of every attempt (required with --apply)")
    ap.add_argument("--resubmit-unsettled", action="store_true",
                    help="send unsettled ids from an earlier run again (only after --settle-minutes)")
    ap.add_argument("--settle-minutes", type=int, default=30)
    ap.add_argument("--apply", action="store_true", help="actually send requests (production write)")
    a = ap.parse_args()
    if not TS.match(a.since):
        sys.exit("--since must be YYYY-MM-DDTHH:MM:SSZ")
    if a.apply and not a.checkpoint:
        sys.exit("--apply needs --checkpoint FILE")
    mode = "sweep" if a.sweep else "convert"
    groups = {g.strip() for g in a.only.split(",") if g.strip()}

    exclude = set()
    if a.exclude_file:
        for line in open(a.exclude_file):
            exclude.update(m.lower() for m in UUID_ANY.findall(line))

    cp = Checkpoint(a.checkpoint) if a.checkpoint else None
    resubmit = reconcile(cp, mode, a) if (cp and a.apply) else set()
    settled = {i for i, r in (cp.last.items() if cp else []) if r["event"] in ("done", "refused")}

    if mode == "convert":
        rows = [r for r in mgmt_query(QUERY.replace("{since}", a.since))
                if r["g"] in groups and UUID.match(r["id"])]
    else:
        rows = [{"g": r["reason"], "id": r["id"]} for r in mgmt_query(SWEEP_QUERY)
                if r["reason"] and UUID.match(r["id"])]
    rows = [r for r in rows if r["id"] not in exclude and r["id"] not in settled
            and (r["id"] not in (cp.unsettled() if cp else {}) or r["id"] in resubmit)]
    if a.limit:
        rows = rows[:a.limit]

    by_group = {}
    for r in rows:
        by_group[r["g"]] = by_group.get(r["g"], 0) + 1
    verb = "to revoke" if mode == "sweep" else "to convert"
    print(f"{verb}: {len(rows)} {by_group}  excluded ids: {len(exclude)}  "
          f"already settled in checkpoint: {len(settled)}")
    for r in rows[:50]:
        extra = f"{r['bucket']}/{short(r['path'])}…" if mode == "convert" else ""
        print(f"  {r['g']:24} post {short(r['id'])}…  {extra}")
    if len(rows) > 50:
        print(f"  … {len(rows) - 50} more")
    if not a.apply:
        print("DRY RUN: nothing sent. Re-run with --apply --checkpoint FILE (needs CTO authorization).")
        return 0

    api_key = os.environ.get("HLS_API_KEY")
    if not api_key:
        sys.exit("set HLS_API_KEY (the converter key) in the environment; it is never printed")

    route = "/api/revoke-hls" if mode == "sweep" else "/api/process-from-storage"
    done, results, stopped = [], {}, None
    for i, r in enumerate(rows, 1):
        payload = ({"postId": r["id"]} if mode == "sweep" else
                   {"videoPath": r["path"], "bucket": r["bucket"], "videoId": r["id"], "postId": r["id"]})
        cp.write({"id": r["id"], "event": "attempt", "mode": mode})
        status, body = post_json(route, payload, api_key, a.timeout)
        outcome = classify(mode, status, body)
        cp.write({"id": r["id"], "event": outcome, "status": status})
        results[outcome] = results.get(outcome, 0) + 1
        msg = str(body.get("error", ""))[:100]
        print(f"[{i}/{len(rows)}] {r['g']:24} post {short(r['id'])}…  -> {status or 'no answer'} {outcome} {msg}")
        if outcome == "reported":
            done.append(r["id"])
        if outcome == UNCERTAIN:
            stopped = r["id"]
            break
        time.sleep(a.pause)
    print(f"outcomes: {results}")

    # Only the database check settles an id (CTO re-review R7): "done" is
    # written after it, a failed check leaves the id unsettled ("unverified"),
    # and a check that cannot run leaves it "reported" for the next run.
    failed = []
    try:
        state = verify_rows(done)
    except BaseException as e:  # noqa: B902 - includes the SystemExit of a failed query
        print(f"VERIFICATION COULD NOT RUN ({type(e).__name__}): {len(done)} id(s) stay unsettled "
              f"in {a.checkpoint}; the next run verifies them first.")
        return 1
    for pid in done:
        row = state.get(pid)
        ok = (row is not None and row["own_hls"]) if mode == "convert" else (row is None or not row["has_hls"])
        cp.write({"id": pid, "event": "done" if ok else "unverified"})
        if not ok:
            failed.append(pid)
    print(f"verified: {len(done) - len(failed)}/{len(done)} reported done are done in the database")
    for pid in failed:
        print(f"  NOT VERIFIED: post {short(pid)}… (left unsettled; the next run blocks on it "
              "until it is reconciled or --resubmit-unsettled is given)")

    if stopped:
        print(f"STOPPED on an uncertain outcome for post {short(stopped)}…. It stays unsettled in "
              f"{a.checkpoint}; the next run reconciles it before sending anything.")
    return 1 if (stopped or failed) else 0


if __name__ == "__main__":
    sys.exit(main())
