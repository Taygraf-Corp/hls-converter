#!/usr/bin/env python3
"""Backfill HLS for posts whose video never got a rendition.

DRY RUN BY DEFAULT: lists the candidates and sends nothing. With --apply it
asks the converter to convert them, one at a time, through the same endpoint
the app uses (/api/process-from-storage). The converter does the production
write: it uploads FlutterFlow/converted/<postId>/hls/ and sets posts.hls_url.
Running --apply needs explicit CTO authorization.

Candidates come from a READ ONLY, rolled-back query through the Supabase
Management API (same token file and wrapper as docs/v1.1.0/build45/ro_query.py).
Nothing in this script writes to the database itself.

  python3 scripts/backfill_hls.py                       # dry run, all groups
  python3 scripts/backfill_hls.py --only legacy         # one group
  python3 scripts/backfill_hls.py --exclude-file ids.txt --apply --limit 5

Groups:
  legacy        app posts with a public FlutterFlow video_url, no hls_url, since --since
  multiaccount  posts under Videos/multi-account/ with no hls_url (any date)
  unified       single-video posts with private media (unfiltered bucket), no hls_url.
                Needs Taygraf-Corp/hls-converter#2 deployed first: the guard binds each
                request to the post's own media.

Output never prints full post ids or paths (only the first 8 characters).
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.request

REF = "ohfzckfunpsjncjjzfyz"
CONVERTER = os.environ.get("HLS_CONVERTER_URL",
                           "http://hls-converter-alb-119214933.ca-central-1.elb.amazonaws.com")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

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
  union all
  select 'multiaccount', p.id, 'FlutterFlow',
         substring(p.video_url from '/storage/v1/object/public/FlutterFlow/([^?]+)'),
         p.created_at
  from public.posts p
  where p.hls_url is null and p.media_path is null
    and p.video_url like '%/storage/v1/object/public/FlutterFlow/Videos/multi-account/%'
  union all
  select 'unified', p.id, p.media_bucket, p.media_path, p.created_at
  from public.posts p
  where p.hls_url is null and p.media_bucket = 'unfiltered' and p.media_path is not null
    and coalesce(p.media_count, 1) = 1 and p.post_type = 'video'
) c
where path is not null
order by created_at
"""

VERIFY = "select id::text as id, hls_url is not null as has_hls from public.posts where id::text = any (array[{ids}])"


def mgmt_query(sql):
    tok = open(os.path.expanduser("~/.supabase/access-token")).read().strip()
    q = "begin transaction read only;\nset local statement_timeout='30s';\n" + sql + ";\nrollback;"
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query", method="POST",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                 "User-Agent": "hls-backfill-ro"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def convert(row, api_key, timeout):
    body = json.dumps({"videoPath": row["path"], "bucket": row["bucket"],
                       "videoId": row["id"], "postId": row["id"]}).encode()
    req = urllib.request.Request(f"{CONVERTER}/api/process-from-storage", method="POST", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error", "")
        except Exception:
            msg = ""
        return e.code, msg[:120]
    except Exception as e:  # timeout: the converter keeps working; verify later
        return 0, type(e).__name__


def short(s):
    return (s or "")[:8]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="legacy,multiaccount,unified")
    ap.add_argument("--since", default="2026-10-27T00:00:00Z", help="legacy group start (UTC)")
    ap.add_argument("--exclude-file", help="post ids to skip, one per line (e.g. the VP9 repair targets)")
    ap.add_argument("--limit", type=int, default=0, help="at most N conversions this run")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--apply", action="store_true", help="actually send conversions (production write)")
    a = ap.parse_args()
    if not TS.match(a.since):
        sys.exit("--since must be YYYY-MM-DDTHH:MM:SSZ")
    groups = {g.strip() for g in a.only.split(",") if g.strip()}

    exclude = set()
    if a.exclude_file:
        for line in open(a.exclude_file):
            exclude.update(m.lower() for m in re.findall(
                r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", line))

    rows = mgmt_query(QUERY.replace("{since}", a.since))
    if isinstance(rows, dict):
        sys.exit(f"query failed: {str(rows)[:300]}")
    rows = [r for r in rows if r["g"] in groups and UUID.match(r["id"]) and r["id"] not in exclude]
    if a.limit:
        rows = rows[:a.limit]

    by_group = {}
    for r in rows:
        by_group[r["g"]] = by_group.get(r["g"], 0) + 1
    print(f"candidates: {len(rows)} {by_group}  excluded ids: {len(exclude)}")
    for r in rows[:50]:
        print(f"  {r['g']:12} {str(r['created_at'])[:19]}  post {short(r['id'])}…  {r['bucket']}/{short(r['path'])}…")
    if len(rows) > 50:
        print(f"  … {len(rows) - 50} more")
    if not a.apply:
        print("DRY RUN: nothing sent. Re-run with --apply (needs CTO authorization).")
        return

    api_key = os.environ.get("HLS_API_KEY")
    if not api_key:
        sys.exit("set HLS_API_KEY (the converter key) in the environment; it is never printed")
    done, results = [], {}
    for i, r in enumerate(rows, 1):
        status, msg = convert(r, api_key, a.timeout)
        results[status] = results.get(status, 0) + 1
        print(f"[{i}/{len(rows)}] {r['g']:12} post {short(r['id'])}…  -> {status or 'timeout'} {msg}")
        done.append(r["id"])
        time.sleep(a.pause)
    print(f"responses: {results}")

    if done:
        ids = ",".join("'" + x + "'" for x in done)
        check = mgmt_query(VERIFY.replace("{ids}", ids))
        ok = sum(1 for c in check if c.get("has_hls"))
        print(f"verified: {ok}/{len(done)} now have hls_url "
              "(a timed-out request may still finish: re-run the dry run later to see what is left)")


if __name__ == "__main__":
    main()
