#!/usr/bin/env python3
"""JSON helpers for scripts/deploy-image-pinned.sh (standard library only).

  image-of <task-def.json> <container>          print the container's image
  digest-of <image>                             print sha256:... if the image is pinned by digest
  running-digests <tasks.json> <container>      print each running task's image digest
  pin <task-def.json> <container> <image> <out> write a registerable copy with only the image changed
  same-but-image <a.json> <b.json>              exit 1 unless the two differ at most in images
"""
import json, re, sys

READ_ONLY = ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
             "registeredAt", "registeredBy", "deregisteredAt")
DIGEST = re.compile(r"^[^@\s]+@(sha256:[0-9a-f]{64})$")


def load(p):
    with open(p) as f:
        data = json.load(f)
    return data.get("taskDefinition", data)


def container(td, name):
    hits = [c for c in td.get("containerDefinitions", []) if c.get("name") == name]
    if len(hits) != 1:
        sys.exit(f"expected one container named {name}, found {len(hits)}")
    return hits[0]


def main(argv):
    cmd = argv[0]
    if cmd == "image-of":
        print(container(load(argv[1]), argv[2])["image"])
    elif cmd == "digest-of":
        m = DIGEST.match(argv[1])
        print(m.group(1) if m else "")
    elif cmd == "running-digests":
        with open(argv[1]) as f:
            tasks = json.load(f).get("tasks", [])
        for t in tasks:
            for c in t.get("containers", []):
                if c.get("name") == argv[2]:
                    print(c.get("imageDigest") or "unknown")
    elif cmd == "pin":
        td = load(argv[1])
        for k in READ_ONLY:
            td.pop(k, None)
        container(td, argv[2])["image"] = argv[3]
        with open(argv[4], "w") as f:
            json.dump(td, f, indent=2, sort_keys=True)
    elif cmd == "same-but-image":
        a, b = load(argv[1]), load(argv[2])
        for k in READ_ONLY:
            a.pop(k, None)
            b.pop(k, None)
        changed = [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
        if changed not in ([], ["containerDefinitions"]):
            sys.exit(f"unexpected task definition changes: {changed}")
        for x, y in zip(a.get("containerDefinitions", []), b.get("containerDefinitions", [])):
            diff = [k for k in sorted(set(x) | set(y)) if x.get(k) != y.get(k)]
            if diff not in ([], ["image"]):
                sys.exit(f"unexpected container changes: {diff}")
            if diff:
                print(f"  {x['name']}: {x['image']}\n      -> {y['image']}")
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
