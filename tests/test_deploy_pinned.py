"""Offline tests for scripts/deploy-image-pinned.sh with fake aws/docker/curl/git.

No AWS, Docker or network: each fake keeps its state in a JSON file. The
fakes model the one property that matters for R5 (CTO re-review 2026-11-02):
a task definition that names a TAG runs whatever that tag points at when its
tasks start, while one pinned by DIGEST always runs those bytes.
"""
import json, os, stat, subprocess, tempfile, textwrap, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "deploy-image-pinned.sh")
ACCOUNT = "442956083883"
REG = f"{ACCOUNT}.dkr.ecr.ca-central-1.amazonaws.com/hls-converter"
OLD = "sha256:" + "a" * 64
NEW = "sha256:" + "b" * 64
OTHER = "sha256:" + "c" * 64
ARN = "arn:aws:ecs:ca-central-1:442956083883:task-definition/hls-converter:"

FAKE_AWS = r'''
import json, os, sys
S = os.environ["FAKE_STATE"]
def save(st):
    json.dump(st, open(S + ".tmp", "w")); os.replace(S + ".tmp", S)
st = json.load(open(S))
a = sys.argv[1:]
def opt(name):
    return a[a.index(name) + 1] if name in a else None
for flag in ("--region", "--output"):
    while flag in a:
        i = a.index(flag); del a[i:i + 2]
st["calls"].append(" ".join(a))
def out(x):
    save(st); print(json.dumps(x)); sys.exit(0)
def fail(code=254):
    save(st); sys.exit(code)
def resolve(image):
    if "@" in image:
        return image.split("@", 1)[1]
    return st["tags"].get(image.rsplit(":", 1)[1])
svc, cmd = a[0], a[1]
if (svc, cmd) == ("sts", "get-caller-identity"):
    out({"Account": st["account"]})
if (svc, cmd) == ("ecs", "describe-services"):
    out({"services": [{"taskDefinition": st["service_td"]}]})
if (svc, cmd) == ("ecs", "describe-task-definition"):
    td = st["tds"].get(opt("--task-definition"))
    if td is None: fail(255)
    out({"taskDefinition": td})
if (svc, cmd) == ("ecs", "list-tasks"):
    out({"taskArns": [f"task/{i}" for i in range(len(st["running"]))]})
if (svc, cmd) == ("ecs", "describe-tasks"):
    out({"tasks": [{"containers": [{"name": "hls-converter", "imageDigest": d}]} for d in st["running"]]})
if (svc, cmd) == ("ecs", "register-task-definition"):
    td = json.load(open(opt("--cli-input-json")[len("file://"):]))
    st["rev"] += 1
    arn = f"{td['family']}:{st['rev']}"
    arn = "arn:aws:ecs:ca-central-1:442956083883:task-definition/" + arn
    td["taskDefinitionArn"] = arn
    st["tds"][arn] = td
    out({"taskDefinition": td})
if (svc, cmd) == ("ecs", "update-service"):
    st["service_td"] = opt("--task-definition")
    out({})
if (svc, cmd) == ("ecs", "wait"):
    td = st["tds"][st["service_td"]]
    image = td["containerDefinitions"][0]["image"]
    d = st.get("force_running") or resolve(image)
    st["running"] = [d] * len(st["running"])
    save(st); sys.exit(0)
if (svc, cmd) == ("ecr", "describe-images"):
    ids = opt("--image-ids")
    k, v = ids.split("=", 1)
    d = v if k == "imageDigest" else st["tags"].get(v)
    if d is None or d not in st["digests"]: fail()
    out({"imageDetails": [{"imageDigest": d}]})
if (svc, cmd) == ("ecr", "get-login-password"):
    print("pw"); sys.exit(0)  # piped into docker login: leave the state to it
sys.exit(f"fake aws: unhandled {a}")
'''

FAKE_DOCKER = r'''
import json, os, sys
S = os.environ["FAKE_STATE"]
def save(st):
    json.dump(st, open(S + ".tmp", "w")); os.replace(S + ".tmp", S)
st = json.load(open(S))
st["calls"].append("docker " + " ".join(sys.argv[1:]))
if sys.argv[1:2] == ["login"]: sys.stdin.read()
if sys.argv[1:3] == ["buildx", "build"]:
    tag = sys.argv[sys.argv.index("-t") + 1].rsplit(":", 1)[1]
    st["tags"][tag] = st["build_digest"]; st["digests"].append(st["build_digest"])
save(st)
'''

FAKE_CURL = r'''
import json, os, sys
st = json.load(open(os.environ["FAKE_STATE"]))
if "-w" in sys.argv: print(st.get("root_status", "404"), end="")
else: print('{"status":"ok"}')
'''

FAKE_GIT = r'''
import sys
a = sys.argv[1:]
if a[:1] == ["status"]: print("", end="")
elif a[:2] == ["rev-parse", "--short=7"]: print("abc1234")
elif a[:1] == ["rev-parse"]: print("abc1234" + "0" * 33)
'''


def td(rev, image, env=None):
    return {
        "taskDefinitionArn": f"{ARN}{rev}", "revision": rev, "status": "ACTIVE",
        "family": "hls-converter", "cpu": "2048", "memory": "4096",
        "executionRoleArn": "arn:aws:iam::442956083883:role/hls-converter-execution-role",
        "containerDefinitions": [{
            "name": "hls-converter", "image": image,
            "environment": env or [{"name": "TARGET_BUCKET", "value": "FlutterFlow"}],
            "secrets": [{"name": "SUPABASE_SERVICE_ROLE_KEY", "valueFrom": "arn:secret"}],
        }],
    }


class DeployPinnedTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.bin = os.path.join(self.dir, "bin")
        os.mkdir(self.bin)
        for name, body in (("aws", FAKE_AWS), ("docker", FAKE_DOCKER), ("curl", FAKE_CURL), ("git", FAKE_GIT)):
            p = os.path.join(self.bin, name)
            with open(p, "w") as f:
                f.write("#!/usr/bin/env python3\n" + textwrap.dedent(body))
            os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        self.state_path = os.path.join(self.dir, "state.json")
        # Production today: rev 5 names the mutable :latest tag, which runs OLD.
        self.save({
            "account": ACCOUNT, "service_td": f"{ARN}5", "rev": 5,
            "tds": {f"{ARN}5": td(5, f"{REG}:latest")},
            "tags": {"latest": OLD, "71ed68c": OLD}, "digests": [OLD],
            "running": [OLD, OLD], "build_digest": NEW, "calls": [],
        })

    def save(self, st):
        with open(self.state_path, "w") as f:
            json.dump(st, f)

    def state(self):
        with open(self.state_path) as f:
            return json.load(f)

    def run_script(self, *args):
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_STATE": self.state_path,
               "RECORDS_DIR": os.path.join(self.dir, "records")}
        return subprocess.run(["bash", SCRIPT, *args], env=env, capture_output=True, text=True, cwd=self.dir)

    def record(self):
        d = os.path.join(self.dir, "records")
        (name,) = os.listdir(d)
        with open(os.path.join(d, name)) as f:
            return f.read()

    def test_prepares_a_digest_pinned_rollback_before_building(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        st = self.state()
        rollback, new = st["tds"][f"{ARN}6"], st["tds"][f"{ARN}7"]
        self.assertEqual(rollback["containerDefinitions"][0]["image"], f"{REG}@{OLD}")
        self.assertEqual(new["containerDefinitions"][0]["image"], f"{REG}@{NEW}")
        for t in (rollback, new):  # nothing but the image differs
            self.assertEqual(t["containerDefinitions"][0]["secrets"], st["tds"][f"{ARN}5"]["containerDefinitions"][0]["secrets"])
            self.assertEqual(t["containerDefinitions"][0]["environment"], st["tds"][f"{ARN}5"]["containerDefinitions"][0]["environment"])
        calls = st["calls"]
        reg = [i for i, c in enumerate(calls) if c.startswith("ecs register-task-definition")]
        build = [i for i, c in enumerate(calls) if c.startswith("docker buildx")]
        self.assertLess(reg[0], build[0], "the rollback revision exists before anything is built")
        self.assertFalse(any(":latest" in c for c in calls if c.startswith("docker")), "latest is never pushed")
        self.assertFalse(any(c.startswith("ecs update-service") for c in calls), "no rollout without --apply")
        rec = self.record()
        self.assertIn(f"rollback revision:   {ARN}6 ({REG}@{OLD})", rec)
        self.assertIn(f"rollback command:    scripts/deploy-image-pinned.sh --rollback {ARN}6", rec)

    def test_apply_rolls_out_and_verifies_the_new_digest(self):
        r = self.run_script("--apply")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        st = self.state()
        self.assertEqual(st["service_td"], f"{ARN}7")
        self.assertEqual(st["running"], [NEW, NEW])

    def test_r5_rollback_refuses_a_revision_that_names_a_tag(self):
        # The reproduction: rev 5 names :latest; meanwhile latest moved.
        st = self.state(); st["tags"]["latest"] = OTHER; st["digests"].append(OTHER); self.save(st)
        r = self.run_script("--rollback", f"{ARN}5")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not pinned by digest", r.stderr)
        self.assertFalse(any(c.startswith("ecs update-service") for c in self.state()["calls"]))

    def test_rollback_to_the_prepared_revision_restores_the_recorded_digest(self):
        self.assertEqual(self.run_script("--apply").returncode, 0)
        st = self.state(); st["tags"]["latest"] = OTHER; st["digests"].append(OTHER); self.save(st)
        r = self.run_script("--rollback", f"{ARN}6")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertEqual(self.state()["running"], [OLD, OLD], "the old bytes, whatever latest is now")
        self.assertIn(f"tasks run {OLD}", r.stdout)

    def test_rollback_fails_when_the_tasks_do_not_run_the_digest(self):
        self.assertEqual(self.run_script("--apply").returncode, 0)
        st = self.state(); st["force_running"] = OTHER; self.save(st)
        r = self.run_script("--rollback", f"{ARN}6")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("expected", r.stderr)

    def test_rollback_refuses_a_digest_missing_from_ecr(self):
        self.assertEqual(self.run_script().returncode, 0)
        st = self.state(); st["digests"].remove(OLD); self.save(st)
        r = self.run_script("--rollback", f"{ARN}6")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not in ECR", r.stderr)

    def test_refuses_to_start_without_a_known_running_digest(self):
        for running in (["unknown", "unknown"], [OLD, OTHER], []):
            with self.subTest(running=running):
                self.setUp()
                st = self.state(); st["running"] = running; st["digests"].append(OTHER); self.save(st)
                r = self.run_script()
                self.assertNotEqual(r.returncode, 0)
                calls = self.state()["calls"]
                self.assertFalse(any(c.startswith(("ecs register", "docker")) for c in calls), calls)

    def test_refuses_when_the_running_digest_is_not_in_ecr(self):
        st = self.state(); st["digests"] = []; self.save(st)
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no safe rollback", r.stderr)

    def test_an_already_pinned_current_revision_is_its_own_rollback(self):
        st = self.state()
        st["tds"][f"{ARN}5"] = td(5, f"{REG}@{OLD}")
        self.save(st)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        st = self.state()
        self.assertEqual(sorted(st["tds"]), [f"{ARN}5", f"{ARN}6"], "only the new revision was registered")
        self.assertIn(f"rollback command:    scripts/deploy-image-pinned.sh --rollback {ARN}5", self.record())

    def test_plan_changes_nothing(self):
        r = self.run_script("--plan")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(any(c.startswith(("ecs register", "ecs update", "docker")) for c in self.state()["calls"]))


if __name__ == "__main__":
    unittest.main()
