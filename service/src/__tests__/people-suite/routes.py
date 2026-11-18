"""Every HTTP route the hub's source registers, read from the source itself.

The people suite sends each one from a person's device and expects "not open to this person".
A route added next year is swept the day it is written, without anyone adding it to a list.
Where a router's mount point cannot be worked out the route is tried under /api/v1: a wrong
guess is still a path that must be closed, so it costs nothing.
"""
import os
import re
from collections import defaultdict

ROUTE = re.compile(r"\b(app|router|r)\.(get|post|put|delete|patch|all)\(\s*['\"`](/[^'\"`\s]*)['\"`]")
IMPORT = re.compile(r"import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+'\./(routes/[\w./-]+\.js)'")
MOUNT = re.compile(r"app\.use\(\s*'([^']+)'\s*,[^;\n]*?\b(\w+)\s*\)\s*;")
# A mount with its own middleware written out in between: app.use('/x', (req, res, next) => { ... }, xRouter);
MOUNT_LONG = re.compile(r"app\.use\(\s*'([^']+)'\s*,\s*\(req, res, next\) => \{.*?\n\}, (\w+)\);", re.S)


def _fill(path):
    path = re.sub(r":\w+\??", "x1", path)
    path = re.sub(r"\*\w*", "x1", path)
    path = re.sub(r"\{[^}]*\}", "", path)
    return re.sub(r"/{2,}", "/", path) or "/"


def hub_routes(src_dir):
    """[(METHOD, path)] for every route found under src_dir, parameters filled with x1."""
    server = open(os.path.join(src_dir, "server.js"), encoding="utf-8").read()
    imports = {name: rel for name, rel in IMPORT.findall(server)}
    mounts = defaultdict(list)
    for prefix, name in MOUNT.findall(server) + MOUNT_LONG.findall(server):
        if name in imports and prefix.rstrip("/") not in mounts[imports[name]]:
            mounts[imports[name]].append(prefix.rstrip("/"))
    found = set()
    for folder, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in ("__tests__", "evals", "node_modules")]
        for name in files:
            if not name.endswith(".js"):
                continue
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, src_dir).replace("\\", "/")
            try:
                text = open(full, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for obj, method, path in ROUTE.findall(text):
                prefixes = [""] if obj == "app" else (mounts.get(rel) or ["/api/v1"])
                methods = ["GET", "POST", "PUT", "DELETE"] if method == "all" else [method.upper()]
                for prefix in prefixes:
                    for m in methods:
                        found.add((m, _fill(prefix + path)))
    return sorted(found)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    routes = hub_routes(os.path.normpath(os.path.join(here, "..", "..")))
    for method, path in routes:
        print(method, path)
    print(len(routes), "routes")
