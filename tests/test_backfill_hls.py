"""Offline tests for scripts/backfill_hls.py: no database, no converter."""
import importlib.util, io, json, os, sys, tempfile, unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("backfill", os.path.join(HERE, "..", "scripts", "backfill_hls.py"))
bf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bf)

A = "00000000-0000-4000-8000-00000000000a"
B = "00000000-0000-4000-8000-00000000000b"
C = "00000000-0000-4000-8000-00000000000c"


def cand(pid):
    return {"g": "unified", "id": pid, "bucket": "unfiltered", "path": f"u/{pid}.mp4", "created_at": "2026-11-01"}


class Fake:
    """Stands in for the read-only query and the converter."""

    def __init__(self, candidates, responses, hls=None):
        self.candidates, self.responses = candidates, dict(responses)
        self.hls = dict(hls or {})  # id -> own_hls in the database
        self.sent = []

    def query(self, sql):
        if "storage.objects" in sql:
            return [{"id": c["id"], "reason": "hidden"} for c in self.candidates]
        if "own_hls" in sql:
            return [{"id": i, "has_hls": v, "own_hls": v} for i, v in self.hls.items() if f"'{i}'" in sql]
        return list(self.candidates)

    def post(self, route, payload, key, timeout):
        pid = payload["postId"]
        self.sent.append((route, pid))
        status, body, sets = self.responses[pid]
        if sets is not None:
            self.hls[pid] = sets
        return status, body


def run(fake, *args):
    out = io.StringIO()
    with mock.patch.object(bf, "mgmt_query", fake.query), mock.patch.object(bf, "post_json", fake.post), \
            mock.patch.object(bf.time, "sleep", lambda s: None), \
            mock.patch.dict(os.environ, {"HLS_API_KEY": "k"}), \
            mock.patch.object(sys, "argv", ["backfill_hls.py", *args]), redirect_stdout(out):
        try:
            code = bf.main()
        except SystemExit as e:
            code = e.code
    return code, out.getvalue()


class BackfillTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cp = os.path.join(self.dir, "cp.jsonl")

    def records(self):
        with open(self.cp) as fh:
            return [json.loads(l) for l in fh]

    def test_dry_run_sends_nothing(self):
        f = Fake([cand(A)], {})
        code, out = run(f)
        self.assertEqual(code, 0)
        self.assertEqual(f.sent, [])
        self.assertIn("DRY RUN", out)

    def test_apply_needs_a_checkpoint(self):
        code, _ = run(Fake([cand(A)], {}), "--apply")
        self.assertIn("--checkpoint", str(code))

    def test_attempt_is_recorded_before_the_request(self):
        f = Fake([cand(A)], {A: (200, {"success": True}, True)})
        seen = []
        orig = f.post
        def post(*a):
            seen.append([r["event"] for r in self.records()])
            return orig(*a)
        f.post = post
        code, _ = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 0)
        self.assertEqual(seen, [["attempt"]])
        self.assertEqual([r["event"] for r in self.records()], ["attempt", "reported", "done"])

    def test_timeout_stops_the_run_and_exits_nonzero(self):
        f = Fake([cand(A), cand(B), cand(C)], {
            A: (200, {"success": True}, True),
            B: (0, {"error": "TimeoutError"}, None),
            C: (200, {"success": True}, True),
        })
        code, out = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 1)
        self.assertEqual([p for _, p in f.sent], [A, B])
        self.assertIn("STOPPED", out)

    def test_5xx_and_success_false_are_uncertain(self):
        for resp in [(500, {"success": False}, None), (504, {}, None), (200, {"success": False}, None)]:
            with self.subTest(resp=resp):
                cp = os.path.join(self.dir, f"cp{resp[0]}{resp[1]}.jsonl")
                f = Fake([cand(A), cand(B)], {A: resp, B: (200, {"success": True}, True)})
                code, _ = run(f, "--apply", "--checkpoint", cp)
                self.assertEqual(code, 1)
                self.assertEqual([p for _, p in f.sent], [A])

    def test_refusals_continue_and_are_not_retried(self):
        f = Fake([cand(A), cand(B)], {A: (403, {"error": "post is hidden"}, None), B: (409, {}, None)})
        code, _ = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 0)
        f2 = Fake([cand(A), cand(B)], {})
        code, out = run(f2, "--apply", "--checkpoint", self.cp)
        self.assertEqual(f2.sent, [])
        self.assertIn("already settled in checkpoint: 2", out)

    def test_unsettled_ids_block_the_next_run_until_reconciled(self):
        run(Fake([cand(A)], {A: (0, {"error": "TimeoutError"}, None)}), "--apply", "--checkpoint", self.cp)
        # The converter is still working; nothing in the database yet: blocked.
        f = Fake([cand(A), cand(B)], {B: (200, {"success": True}, True)}, hls={A: False})
        code, out = run(f, "--apply", "--checkpoint", self.cp)
        self.assertIn("unsettled", str(code))
        self.assertEqual(f.sent, [])
        # --resubmit-unsettled is not enough while the attempt is recent.
        code, _ = run(f, "--apply", "--checkpoint", self.cp, "--resubmit-unsettled")
        self.assertEqual(f.sent, [])
        # The conversion finished meanwhile: reconciled as done, never resent.
        f = Fake([cand(B)], {B: (200, {"success": True}, True)}, hls={A: True})
        code, _ = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 0)
        self.assertEqual([p for _, p in f.sent], [B])
        self.assertIn({"id": A, "via": "reconciled"},
                      [{k: r.get(k) for k in ("id", "via")} for r in self.records()])

    def test_old_unsettled_ids_resubmit_only_when_asked(self):
        with open(self.cp, "w") as fh:
            fh.write(json.dumps({"id": A, "event": "attempt", "at": "2026-11-01T00:00:00Z"}) + "\n")
        f = Fake([cand(A)], {A: (200, {"success": True}, True)}, hls={A: False})
        code, _ = run(f, "--apply", "--checkpoint", self.cp, "--resubmit-unsettled")
        self.assertEqual(code, 0)
        self.assertEqual([p for _, p in f.sent], [A])

    def test_reported_success_that_is_not_in_the_database_fails(self):
        f = Fake([cand(A)], {A: (200, {"success": True}, False)})
        code, out = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 1)
        self.assertIn("NOT VERIFIED", out)

    def test_r7_an_unverified_success_is_never_marked_done(self):
        # Run 1: the converter answers 200 but HLS is not in the database.
        code, out = run(Fake([cand(A)], {A: (200, {"success": True}, False)}),
                        "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 1)
        self.assertNotIn("done", [r["event"] for r in self.records()])
        self.assertEqual(self.records()[-1]["event"], "unverified")
        # Run 2, same checkpoint: it does not skip the post or exit 0.
        f = Fake([cand(A)], {A: (200, {"success": True}, True)}, hls={A: False})
        code, out = run(f, "--apply", "--checkpoint", self.cp)
        self.assertIn("unsettled", str(code))
        self.assertEqual(f.sent, [])
        # Asked to resubmit: sent at once (the first request had finished),
        # verified, and only then done.
        code, out = run(f, "--apply", "--checkpoint", self.cp, "--resubmit-unsettled")
        self.assertEqual(code, 0, out)
        self.assertEqual([p for _, p in f.sent], [A])
        self.assertEqual(self.records()[-1]["event"], "done")

    def test_r7_a_verification_that_cannot_run_leaves_the_id_unsettled(self):
        f = Fake([cand(A)], {A: (200, {"success": True}, True)})
        calls = {"n": 0}
        orig = f.query
        def query(sql):
            if "own_hls" in sql:
                calls["n"] += 1
                raise SystemExit("query failed: 503")
            return orig(sql)
        f.query = query
        code, out = run(f, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 1)
        self.assertIn("VERIFICATION COULD NOT RUN", out)
        self.assertEqual(self.records()[-1]["event"], "reported")
        # Next run: verifies first, finds HLS, settles it, sends nothing.
        f2 = Fake([cand(A)], {}, hls={A: True})
        code, out = run(f2, "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 0, out)
        self.assertEqual(f2.sent, [])
        self.assertEqual(self.records()[-1]["event"], "done")

    def test_exclude_file(self):
        ex = os.path.join(self.dir, "ex.txt")
        open(ex, "w").write(f"{A.upper()}  # vp9\n")
        f = Fake([cand(A), cand(B)], {B: (200, {"success": True}, True)})
        code, _ = run(f, "--apply", "--checkpoint", self.cp, "--exclude-file", ex)
        self.assertEqual([p for _, p in f.sent], [B])

    def test_sweep_calls_revoke(self):
        f = Fake([cand(A)], {A: (200, {"success": True}, False)}, hls={A: True})
        code, _ = run(f, "--sweep", "--apply", "--checkpoint", self.cp)
        self.assertEqual(code, 0)
        self.assertEqual(f.sent, [("/api/revoke-hls", A)])


if __name__ == "__main__":
    unittest.main()
