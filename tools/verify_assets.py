"""Verify shipped catalog and 176 WebP thumbnails without optional dependencies."""
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG_SHA256 = "3a3aa6152e749624fc5398b973a3f01494cd53ef9814e3469a2861ea4eedb98f"


def dimensions(raw):
    if raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise ValueError("Not WebP")
    kind = raw[12:16]
    if kind == b"VP8 ":
        return tuple(v & 0x3FFF for v in struct.unpack_from("<HH", raw, 26))
    if kind == b"VP8X":
        return int.from_bytes(raw[24:27], "little") + 1, int.from_bytes(raw[27:30], "little") + 1
    if kind == b"VP8L":
        value = int.from_bytes(raw[21:25], "little")
        return (value & 0x3FFF) + 1, ((value >> 14) & 0x3FFF) + 1
    raise ValueError("Unknown WebP chunk")


def main():
    raw_catalog = (ROOT / "data/prompt_effect_presets.json").read_bytes()
    assert hashlib.sha256(raw_catalog).hexdigest() == CATALOG_SHA256, "Catalog changed"
    catalog = json.loads(raw_catalog)
    manifest = json.loads((ROOT / "provenance/asset_manifest.json").read_text(encoding="utf-8"))
    assert len(catalog["presets"]) == len(manifest["assets"]) == 176
    paths = set()
    for item in manifest["assets"]:
        path = ROOT / item["target_path"]
        assert path.resolve().is_relative_to(ROOT)
        raw = path.read_bytes()
        assert len(raw) == item["byte_size"], item["target_path"]
        assert hashlib.sha256(raw).hexdigest() == item["sha256"], item["target_path"]
        assert dimensions(raw) == (item["width"], item["height"]) == (192, 128)
        preset = next(p for p in catalog["presets"] if p["id"] == item["preset_id"])
        assert preset["thumbnail"] == item["target_path"]
        paths.add(path.resolve())
    assert {p.resolve() for p in (ROOT / "assets/thumbnails").iterdir() if p.is_file()} == paths
    print(json.dumps({"status": "PASS", "presets": 176, "thumbnails": 176, "bytes": 630920}))


if __name__ == "__main__":
    main()
