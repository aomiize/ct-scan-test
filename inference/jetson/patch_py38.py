"""
Make nnU-Net v2, TotalSegmentator and their helpers run on Python 3.8 (Jetson / JetPack 5).

1. Files whose function signatures use Python 3.9+ type hints such as dict[str, int] get
   `from __future__ import annotations`, so Python 3.8 does not evaluate those hints. Nothing else changes.
2. TotalSegmentator reads its own version through pkg_resources, which also checks optional preview-only
   dependencies (fury/vtk) that have no Python 3.8 ARM builds; read it with importlib.metadata instead.

Safe to run more than once.
"""
import ast
import importlib.util
import pathlib

PACKAGES = ["nnunetv2", "totalsegmentator", "batchgeneratorsv2", "dynamic_network_architectures", "acvl_utils", "batchgenerators"]
BUILTINS = {"list", "dict", "tuple", "set", "frozenset", "type"}


def needs_future(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anns = [a.annotation for a in node.args.args + node.args.kwonlyargs + node.args.posonlyargs if a.annotation]
            if node.returns:
                anns.append(node.returns)
            for a in anns:
                for sub in ast.walk(a):
                    if isinstance(sub, ast.Subscript) and isinstance(sub.value, ast.Name) and sub.value.id in BUILTINS:
                        return True
                    if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                        return True
    return False


def add_future(path: pathlib.Path) -> bool:
    src = path.read_text(encoding="utf-8", errors="ignore")
    if "from __future__ import annotations" in src:
        return False
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return False
    if not needs_future(tree):
        return False
    lines = src.splitlines(keepends=True)
    insert_at = 0
    body = tree.body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) and isinstance(body[0].value.value, str):
        insert_at = body[0].end_lineno  # after the module docstring
    # keep any existing __future__ imports first
    for stmt in body:
        if isinstance(stmt, ast.ImportFrom) and stmt.module == "__future__":
            insert_at = max(insert_at, stmt.end_lineno)
    lines.insert(insert_at, "from __future__ import annotations\n")
    path.write_text("".join(lines), encoding="utf-8")
    return True


patched = 0
for pkg in PACKAGES:
    spec = importlib.util.find_spec(pkg)
    if not spec or not spec.submodule_search_locations:
        continue
    for root in spec.submodule_search_locations:
        for f in pathlib.Path(root).rglob("*.py"):
            if add_future(f):
                patched += 1
                print("py3.8 type hints:", f.relative_to(pathlib.Path(root).parent))
print(f"{patched} file(s) given 'from __future__ import annotations'")

# TotalSegmentator version lookup without pkg_resources' dependency check
spec = importlib.util.find_spec("totalsegmentator")
if spec and spec.submodule_search_locations:
    root = pathlib.Path(list(spec.submodule_search_locations)[0])
    shim = 'from importlib.metadata import version as _version\nrequire = lambda name: [type("Dist", (), {"version": _version(name)})]'
    edits = {
        "bin/TotalSegmentator.py": [("from pkg_resources import require", shim)],
        "bin/crop_to_body.py": [("from pkg_resources import require", shim)],
        "config.py": [("import pkg_resources", "import importlib.metadata"),
                      ('pkg_resources.get_distribution("TotalSegmentator").version', 'importlib.metadata.version("TotalSegmentator")'),
                      ("except pkg_resources.DistributionNotFound:", "except importlib.metadata.PackageNotFoundError:")],
    }
    for rel, pairs in edits.items():
        p = root / rel
        if not p.exists():
            continue
        s = p.read_text()
        new = s
        for old, rep in pairs:
            new = new.replace(old, rep)
        if new != s:
            p.write_text(new)
            print("TotalSegmentator version lookup:", rel)
