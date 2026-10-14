"""
TotalSegmentator 2.0.5 reads its own version through pkg_resources, which also checks that every declared
dependency is installed, including fury/vtk/xvfbwrapper (preview images only; no Python 3.8 ARM builds).
Read the version with importlib.metadata instead, which does no dependency check. Nothing else changes.
"""
import pathlib
import totalsegmentator

root = pathlib.Path(totalsegmentator.__file__).parent
SHIM = 'from importlib.metadata import version as _version\nrequire = lambda name: [type("Dist", (), {"version": _version(name)})]'
edits = {
    "bin/TotalSegmentator.py": [("from pkg_resources import require", SHIM)],
    "bin/crop_to_body.py": [("from pkg_resources import require", SHIM)],
    "config.py": [
        ("import pkg_resources", "import importlib.metadata"),
        ('pkg_resources.get_distribution("TotalSegmentator").version', 'importlib.metadata.version("TotalSegmentator")'),
        ("except pkg_resources.DistributionNotFound:", "except importlib.metadata.PackageNotFoundError:"),
    ],
}
for rel, pairs in edits.items():
    p = root / rel
    s = p.read_text()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new)
    p.write_text(s)
    print("patched", rel)
