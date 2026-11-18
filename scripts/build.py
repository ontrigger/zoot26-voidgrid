"""Build the site's data: each map's VolumeStats grid (the 1 m cells the void-out check looks up), its collision
(what stops Link, and what Link's ragdoll hits), and where save recovery can put Link.

    pnpm data <Map>... [--mark <Map>,x,y,z[,label]]... [--pad <m>] [--no-recovery] [--out <dir>]
    pnpm data --all [--variants] [--rebuild] [...]
        e.g. pnpm data SacredForestMeadow_Child InsideGanonCastle --mark SacredForestMeadow_Child,-29.7,129.9,-116.9,voided

--all builds every map without its state variants (--variants adds them) and without SKIP_AREAS, skipping maps
already in the manifest unless --rebuild is given.

Writes <out>/data (default site/data): manifest.json, maps/<Map>.vgz, col/<base map>.vgz. Maps are added to what is
already there. View with `pnpm dev` (see the README).

Needs the game dump and the decoders from the sloperina repo: OOTMENU_NUP = the .nup (Windows path), and
SLOPERINA_TOOLS = sloperina's tools/ folder (default: ../sloperina/tools next to this repo).

<Map> is a grid name as in romfs/Phive/VolumeStats/<Area>/: a map (SacredForestMeadow_Child, WaterTemple), a
whole-map state variant (WaterTemple_presence_Level01_True_...), or a one-tile state variant (Graveyard_Adult_X4_Z3_
presence_RFTomb_Open_True: that tile only).

Collision (phive.py) is the base map's (the name without _presence_... or _X.._Z.._presence_...), cropped to the
grid's cells plus --pad metres (default 12), shared by a map's variants. Field maps have both a nested Ground mesh
(the whole-map terrain) and the GroundHighRes layer (houses, cliffs, walls, detailed ground); both are kept. Each
triangle is flagged:
- stops Link: what phive.map_triangles keeps by default (no sensors, unplaced bodies, GroundHighResRough, or
  materials whose hit mask leaves out the Player layer);
- hit by Link's ragdoll, drawn front faces only (the bones pass through a triangle from behind; the front is the
  (b-a)x(c-a) side, which faces up on floors). The bones are layer Player, sub-layer PlayerRagdollBody, masks
  PlayerRagdoll / Default (Player_Base: Phive/Ragdoll/Structure/Player). A triangle is hit when the PhiveConfig
  mask PlayerRagdoll holds its layer and its material's masks hold Player and PlayerRagdollBody: so the ragdoll hits
  GroundHighResRough and not GroundHighResSmooth, and a few boxes only it hits (sub-layer mask
  HitOnlyPlayerRagdollBody). Moving actors are in neither set.

Save recovery (skipped with --no-recovery): the floor is sampled on a 1 m grid (cell centres) on every triangle that
stops Link and that he can stand on (normal within 45 deg of up), and the game's ground check
(volumestats.ground_probe, sloperina FINDINGS 9.7) is run with Link standing there: 'follows' = the restart point
moves to him, so a save there reloads there; 'holds' = the point stays where it was. Link is taken to arrive with no
ground hit held from where he came. Not modelled: moving bodies, deep water, events, ceilings too
low to stand under. Checked against an in-game log in InsideGanonCastle only.

Data files (.vgz) are gzip'd little-endian binaries (the page gunzips them itself, see site/src/data.ts):
- col: 'VGC1', u32 vertices, u32 triangles, f32 origin[3], f32 step[3]; u16 vertex[3] (position = origin +
  step * q); pad to 4; u32 triangle[3]; u8 flags per triangle: bit 0 stops Link, bit 1 ragdoll hits, bits 2-3 the
  ragdoll class (RAGDOLL_CLASSES), bit 4 an air wall (material AirWall).
- maps: 'VGG1', u32 cells, u32 recovery points; i16 cell min corner[3]; pad to 4; u8 attributes[len(KEEP_ATTRS)]
  per cell (255 = not stored); pad to 4; f32 recovery point[3]; u8 recovery class (RECOVERY_CLASSES).
"""
import gzip
import json
import os
import re
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the repo
TOOLS = os.environ.get("SLOPERINA_TOOLS") or os.path.join(ROOT, "..", "sloperina", "tools")
sys.path.insert(0, TOOLS)
try:
    import byml  # noqa: E402
    import gamefiles  # noqa: E402
    import phive  # noqa: E402
    import volumestats  # noqa: E402
except ImportError as e:
    raise SystemExit("can't import the sloperina decoders from %s (%s): set SLOPERINA_TOOLS" % (TOOLS, e))

# per cell, one byte each; 255 = not stored in this map's cells
KEEP_ATTRS = ("OutsideOuterBoundary", "OuterBoundaryDist", "Intersect", "InWater", "InDoor")
GRID_PREFIX = "romfs/Phive/VolumeStats/"
SKIP_AREAS = {"HyruleField"}  # --all leaves these out: too big to build and view (name the maps to build them)
FLAG_LINK, FLAG_RAGDOLL, RAGDOLL_CLASS_SHIFT, FLAG_AIRWALL = 1, 2, 2, 16  # FLAG_AIRWALL: material AirWall


def all_grids():
    """[(area, grid name)] of every VolumeStats grid in the dump."""
    names = set()
    for path in gamefiles.nup().index:
        if path.startswith(GRID_PREFIX) and path.endswith(".bpvsts.zs"):
            area, name = path[len(GRID_PREFIX):].split("/")
            names.add((area, re.sub(r"(_X\d+_Z\d+)?\.bpvsts\.zs$", "", name)))
    return sorted(names)


def base_map(name):
    """The map whose collision a grid uses: its name without a state variant."""
    return re.sub(r"(_X\d+_Z\d+)?_presence_.*$", "", name)


def aabb(name):
    """The map's VolumeStatsAABB box [[x, y, z] min, max] (romfs/Game/VolumeStatsAABB/<base map>), or None. More than
    5 m outside it the game voids Link at once, whatever the cells say (sloperina FINDINGS 9.8: sensor +0xA8 bit 18)."""
    path = "romfs/Game/VolumeStatsAABB/%s.game__VolumeStatsAABB.bgyml" % base_map(name)
    if path not in gamefiles.nup().index:
        return None
    box = byml.load(gamefiles.read(path))
    return [[round(box[k][a], 3) for a in "XYZ"] for k in ("Min", "Max")]


# placed areas that void Link on contact (sloperina FINDINGS 9.8, "contact", abyss type 3): an AiGroup in the map's
# layout (romfs/Banc/<Area>/<map>_Static|_Dynamic.bcett.byml) runs a logic module on the Area actors it references;
# modules whose graph has HoldSensorHitInfoGiveAbyssActor void Link when he touches one, ...Condition ones only when
# their condition holds (prefabs: they can reference other areas too). Gimmick_AreaContact_FallDown_Item only takes
# items and animals, so it isn't kept. Shapes (sloperina FINDINGS 9.8, main+0x334FD40): the origin t is the middle of
# the bottom; Dynamic.RigidBodyShapeType 1 or none = a box of half extents s centred s.y up the area's own Y axis,
# 3 = a cylinder of radius s.x and height 2 s.y, 0 = a sphere; world = t + Rz Ry Rx (s * p).
AREA_SHAPES = {0: "sphere", 2: "capsule", 3: "cylinder"}
_abyss_modules = None


def abyss_modules():
    """{logic module name: 'void' | 'conditional'} for the modules that give Link an abyss."""
    global _abyss_modules
    if _abyss_modules is None:
        _abyss_modules = {}
        for path in gamefiles.nup().index:
            if path.startswith("romfs/Logic/") and path.endswith(".logic.module.ainb"):
                data = gamefiles.read(path)
                if b"HoldSensorHitInfoGiveAbyssActor" in data:
                    name = path[len("romfs/Logic/"):-len(".logic.module.ainb")]
                    plain = re.search(rb"HoldSensorHitInfoGiveAbyssActor(?!Condition)", data)
                    _abyss_modules[name] = "void" if plain else "conditional"
    return _abyss_modules


def contact_areas(area, name):
    """[{module, kind, shape, t, r, s}] of the areas that void Link on contact in a map's layout."""
    mods, out = abyss_modules(), []
    for part in ("Static", "Dynamic"):
        path = "romfs/Banc/%s/%s_%s.bcett.byml.zs" % (area, base_map(name), part)
        if path not in gamefiles.nup().index:
            continue
        root = byml.load(gamefiles.read(path))
        actors = {a.get("Hash"): a for a in root.get("Actors") or []}
        for group in root.get("AiGroups") or []:
            module = group.get("Logic", "").rsplit("/", 1)[-1].replace(".logic.module.ain", "")
            kind = next((k for m, k in mods.items() if module == m or module.startswith(m + "_")), None)
            if not kind:
                continue
            for ref in group.get("References") or []:
                a = actors.get(ref.get("Reference"))
                if not a or a.get("Gyaml") != "Area":
                    continue
                scale = a.get("Scale", 1.0)
                scale = [float(v) for v in scale] if isinstance(scale, list) else [float(scale)] * 3
                shape = AREA_SHAPES.get((a.get("Dynamic") or {}).get("RigidBodyShapeType"), "box")
                out.append({"module": module, "kind": kind, "shape": shape,
                            "t": [round(float(v), 3) for v in a.get("Translate", [0, 0, 0])],
                            "r": [round(float(v), 5) for v in a.get("Rotate") or [0, 0, 0]],
                            "s": [round(v, 3) for v in scale]})
    return out


def grid_cells(area, name):
    """(n,3) int16 min corners and (n,len(KEEP_ATTRS)) uint8 attributes."""
    pos, attrs = [], []
    for _, tile in volumestats.load_map(area, name):
        for x, y, z, a in volumestats.cells(tile, with_attrs=True):
            pos.append((x, y, z))
            a = a or {}
            attrs.append([min(int(a[k]), 254) if k in a else 255 for k in KEEP_ATTRS])
    return np.array(pos, np.int16).reshape(-1, 3), np.array(attrs, np.uint8).reshape(-1, len(KEEP_ATTRS))


# ---------------------------------------------------------------------------------------------------- collision


def map_triangles(area, mapname):
    """Every triangle of a map's static compound tiles (phive.map_triangles everything=True)."""
    paths = phive.map_tiles(area, mapname)
    return phive.map_triangles(paths, everything=True, log=lambda *_: None)[1] if paths else []


def stops_link(at):
    """What phive.map_triangles keeps by default: what can stop the player."""
    if at["src"] == "ground":
        return True
    return at["hitsPlayer"] and not at.get("extra") and at["layer"] not in phive.SKIP_LAYERS_DEFAULT


# Link's ragdoll bones: romfs/Pack/Actor/Player_Base.pack.zs, Phive/Ragdoll/Structure/Player Layer, SubLayer,
# LayerMask, SubLayerMask. A bone and a shape collide when each one's masks hold the other's layer and sub-layer.
RAGDOLL_LAYER, RAGDOLL_SUB_LAYER, RAGDOLL_LAYER_MASK, RAGDOLL_SUB_LAYER_MASK = (
    "Player", "PlayerRagdollBody", "PlayerRagdoll", "Default")
NESTED_GROUND_LAYER = "GroundHighRes"  # the nested ground mesh's placement block says layer 6
STATIC_SUB_LAYER = "Unspecified"  # the sub-layer byte of every static compound instance seen so far
RAGDOLL_CLASSES = ("both", "rough twin", "ragdoll only")


class RagdollFilter:
    """Which map triangles Link's ragdoll collides with, from PhiveConfig's layer tables."""

    def __init__(self):
        import airwalls
        import byml
        config = byml.load(gamefiles.sarc(gamefiles.read(airwalls.PHIVE_CONFIG[0]))[airwalls.PHIVE_CONFIG[1]])
        layers, subs = config["LayerEntityCollection"], config["SubLayerEntityCollection"]
        layer_masks = {e["ComponentName"]: int(e["MaskValue"]) for e in config["LayerHitMaskEntityCollection"]}
        sub_masks = {e["ComponentName"]: int(e["MaskValue"]) for e in config["SubLayerHitMaskEntityCollection"]}
        own_layers, own_subs = layer_masks[RAGDOLL_LAYER_MASK], sub_masks[RAGDOLL_SUB_LAYER_MASK]
        self.layers = {name for i, name in enumerate(layers) if own_layers >> i & 1}
        self.static_sub_ok = bool(own_subs >> subs.index(STATIC_SUB_LAYER) & 1)
        self.layer_bit = 1 << layers.index(RAGDOLL_LAYER)
        self.sub_bit = 1 << subs.index(RAGDOLL_SUB_LAYER)
        self.link_sub_bit = 1 << subs.index("Unspecified")  # Link on foot

    def classify(self, at):
        """None if the ragdoll passes through, else an index into RAGDOLL_CLASSES."""
        if at["layer"].startswith("sensor:") or at.get("extra") or not self.static_sub_ok:
            return None
        layer = NESTED_GROUND_LAYER if at["src"] == "ground" else at["layer"]
        if layer not in self.layers:
            return None
        masks = at.get("masks")
        if masks and not (masks[0] & self.layer_bit and masks[1] & self.sub_bit):
            return None
        if masks and not masks[1] & self.link_sub_bit:
            return 2
        return 1 if layer == "GroundHighResRough" else 0


_ragdoll_filter = None


def collision(tris, box):
    """(n,9) float32 triangles and (n,) uint8 flags (FLAG_*) of everything that stops Link or his ragdoll, cropped
    to box (min, max)."""
    global _ragdoll_filter
    _ragdoll_filter = _ragdoll_filter or RagdollFilter()
    t, flags = [], []
    for a, b, c, at in tris:
        f = FLAG_LINK if stops_link(at) else 0
        k = _ragdoll_filter.classify(at)
        if k is not None:
            f |= FLAG_RAGDOLL | k << RAGDOLL_CLASS_SHIFT
        if f:
            if at.get("material") == "AirWall":
                f |= FLAG_AIRWALL
            t.append([*a, *b, *c])
            flags.append(f)
    t = np.array(t, np.float32).reshape(-1, 9)
    flags = np.array(flags, np.uint8)
    v = t.reshape(-1, 3, 3)
    keep = np.all(v.max(1) >= box[0], 1) & np.all(v.min(1) <= box[1], 1)
    return t[keep], flags[keep]


# ---------------------------------------------------------------------------------------------------- save recovery

WALKABLE_NY = 0.7071  # cos 45 deg; a guess at the steepest floor Link stands on
RECOVERY_CLASSES = ("follows", "holds")


def floor_samples(tris):
    """(n,3) float32 points on walkable triangles at x, z = cell centres (k + 0.5), one per floor layer."""
    v = tris.reshape(-1, 3, 3).astype(np.float64)
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-9
    ny = np.zeros(len(v))
    ny[ok] = np.abs(n[ok, 1]) / ln[ok]
    out = {}
    for tri in v[ny >= WALKABLE_NY]:
        (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = tri
        det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
        if abs(det) < 1e-12:
            continue
        for ix in range(int(np.floor(min(x0, x1, x2) - 0.5)), int(np.ceil(max(x0, x1, x2) - 0.5)) + 1):
            px = ix + 0.5
            for iz in range(int(np.floor(min(z0, z1, z2) - 0.5)), int(np.ceil(max(z0, z1, z2) - 0.5)) + 1):
                pz = iz + 0.5
                a = ((z1 - z2) * (px - x2) + (x2 - x1) * (pz - z2)) / det
                b = ((z2 - z0) * (px - x2) + (x0 - x2) * (pz - z2)) / det
                c = 1 - a - b
                if a < -1e-6 or b < -1e-6 or c < -1e-6:
                    continue
                py = a * y0 + b * y1 + c * y2
                out[(ix, iz, int(round(py * 2)))] = (px, py, pz)
    return np.array(list(out.values()), np.float32).reshape(-1, 3)


def recovery(tiles, link_tris, log=None):
    """Floor samples (n,3) float32 and their class (n,) uint8, an index into RECOVERY_CLASSES."""
    pts = floor_samples(link_tris)
    cls = np.zeros(len(pts), np.uint8)
    grid = volumestats.Grid(tiles)
    for i, (x, y, z) in enumerate(pts):
        own = grid.leaf(int(np.floor(x)), int(np.floor(y + 0.1)), int(np.floor(z)))
        indoor = bool(own and own.get("InDoor", 0))
        sensor = (float(x), float(y) + volumestats.SENSOR_HEIGHT, float(z))
        cls[i] = volumestats.ground_probe(tiles, sensor, indoor=indoor, grid=grid)["holds"]
        if log and i and i % 50000 == 0:
            log("  %d / %d floor samples" % (i, len(pts)))
    return pts, cls


# ---------------------------------------------------------------------------------------------------- files


def safe(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def pad4(b):
    return b + b"\0" * (-len(b) % 4)


def write_vgz(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(gzip.compress(data, 9, mtime=0))
    os.replace(tmp, path)


def pack_collision(tris, flags):
    """The col file's bytes (see the module docstring): vertices quantised to 16 bits per axis over their box and
    shared between triangles."""
    v = tris.reshape(-1, 3).astype(np.float64)
    lo, hi = v.min(0) if len(v) else np.zeros(3), v.max(0) if len(v) else np.ones(3)
    step = np.maximum(hi - lo, 1e-3) / 65535
    q = np.round((v - lo) / step).astype(np.uint16)
    verts, idx = np.unique(q, axis=0, return_inverse=True)
    idx = idx.reshape(-1).astype(np.uint32)
    head = b"VGC1" + struct.pack("<II3f3f", len(verts), len(tris), *lo, *step)
    return head + pad4(verts.tobytes()) + idx.tobytes() + flags.tobytes()


def pack_grid(pos, attrs, rpts, rcls):
    head = b"VGG1" + struct.pack("<II", len(pos), len(rpts))
    return (head + pad4(np.ascontiguousarray(pos).tobytes()) + pad4(np.ascontiguousarray(attrs).tobytes())
            + rpts.astype(np.float32).tobytes() + rcls.astype(np.uint8).tobytes())


def build(out, area, name, marks, pad, with_recovery, manifest):
    pos, attrs = grid_cells(area, name)
    if not len(pos):
        print("%s: no cells, skipped" % name, file=sys.stderr)
        return
    lo, hi = pos.min(0), pos.max(0) + 1
    base = base_map(name)
    cols = manifest.setdefault("collision", {})
    col = cols.get(base)
    col_file = "col/%s.vgz" % safe(base)
    # one collision file per base map, covering the union of its grids' boxes
    want = [(lo - pad).tolist(), (hi + pad).tolist()]
    if col:
        want = [np.minimum(col["box"][0], want[0]).tolist(), np.maximum(col["box"][1], want[1]).tolist()]
    all_tris = None
    if not col or col["box"] != want or not os.path.exists(os.path.join(out, col_file)):
        all_tris = map_triangles(area, base)
        tris, flags = collision(all_tris, want)
        write_vgz(os.path.join(out, col_file), pack_collision(tris, flags))
        rag = flags & FLAG_RAGDOLL > 0
        cols[base] = {"file": col_file, "box": want, "triangles": len(tris), "link": int((flags & FLAG_LINK > 0).sum()),
                      "airwall": int((flags & FLAG_AIRWALL > 0).sum()),
                      "ragdoll": {c: int((rag & (flags >> RAGDOLL_CLASS_SHIFT == i)).sum())
                                  for i, c in enumerate(RAGDOLL_CLASSES)}}
        print("  collision %s: %d triangles, %d stop Link, ragdoll %s" % (
            base, len(tris), cols[base]["link"], cols[base]["ragdoll"]), file=sys.stderr)
    entry = {"area": area, "base": base, "file": "maps/%s.vgz" % safe(name), "cells": len(pos),
             "box": [lo.tolist(), hi.tolist()], "marks": [m for m in marks if m["map"] == name], "recovery": None,
             "aabb": aabb(name), "contact": contact_areas(area, name)}
    rpts, rcls = np.zeros((0, 3), np.float32), np.zeros(0, np.uint8)
    old = manifest.setdefault("maps", {}).get(name)
    if with_recovery:
        all_tris = all_tris if all_tris is not None else map_triangles(area, base)
        tris, flags = collision(all_tris, [(lo - 1).tolist(), (hi + 1).tolist()])
        tiles = [tile for _, tile in volumestats.load_map(area, name)]
        rpts, rcls = recovery(tiles, tris[flags & FLAG_LINK > 0], log=lambda msg: print(msg, file=sys.stderr))
        entry["recovery"] = {c: int((rcls == i).sum()) for i, c in enumerate(RECOVERY_CLASSES)}
        print("  save recovery: %s" % entry["recovery"], file=sys.stderr)
    elif old and old.get("recovery") and os.path.exists(os.path.join(out, old["file"])):
        # keep the recovery points already built (--no-recovery only skips the work)
        _, _, rpts, rcls = read_grid(os.path.join(out, old["file"]))
        entry["recovery"] = old["recovery"]
    write_vgz(os.path.join(out, entry["file"]), pack_grid(pos, attrs, rpts, rcls))
    manifest["maps"][name] = entry
    print("%s/%s: %d cells, collision %s: %d triangles" % (area, name, len(pos), base, cols[base]["triangles"]),
          file=sys.stderr)


def read_grid(path):
    """(pos, attrs, recovery points, recovery classes) from a maps/*.vgz."""
    d = gzip.decompress(open(path, "rb").read())
    n, nr = struct.unpack_from("<II", d, 4)
    p = 12
    pos = np.frombuffer(d, np.int16, n * 3, p).reshape(-1, 3)
    p += n * 6 + (-n * 6 % 4)
    attrs = np.frombuffer(d, np.uint8, n * len(KEEP_ATTRS), p).reshape(-1, len(KEEP_ATTRS))
    p += n * len(KEEP_ATTRS) + (-n * len(KEEP_ATTRS) % 4)
    rpts = np.frombuffer(d, np.float32, nr * 3, p).reshape(-1, 3)
    rcls = np.frombuffer(d, np.uint8, nr, p + nr * 12)
    return pos, attrs, rpts, rcls


def main():
    args = sys.argv[1:]
    marks, pad, out = [], 12.0, os.path.join(ROOT, "site", "data")
    with_recovery = "--no-recovery" not in args
    flags = {f: f in args for f in ("--no-recovery", "--variants", "--rebuild")}
    args = [a for a in args if a not in flags]
    while "--mark" in args:
        i = args.index("--mark")
        parts = args[i + 1].split(",")
        marks.append({"map": parts[0], "p": [float(v) for v in parts[1:4]], "label": ",".join(parts[4:])})
        del args[i:i + 2]
    for opt in ("--pad", "--out"):
        if opt in args:
            i = args.index(opt)
            if opt == "--pad":
                pad = float(args[i + 1])
            else:
                out = args[i + 1]
            del args[i:i + 2]
    if not args:
        raise SystemExit(__doc__)
    os.makedirs(os.path.join(out, "maps"), exist_ok=True)
    os.makedirs(os.path.join(out, "col"), exist_ok=True)
    manifest_path = os.path.join(out, "manifest.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    manifest.update(attributes=list(KEEP_ATTRS), recoveryClasses=list(RECOVERY_CLASSES),
                    ragdollClasses=list(RAGDOLL_CLASSES))

    grids = all_grids()
    if args != ["--all"]:
        by_name = {name: area for area, name in grids}
        missing = [name for name in args if name not in by_name]
        if missing:
            raise SystemExit("no VolumeStats grid named %s" % ", ".join(missing))
        grids = [(by_name[name], name) for name in args]
    else:
        grids = [(area, name) for area, name in grids if area not in SKIP_AREAS]
        if not flags["--variants"]:
            grids = [(area, name) for area, name in grids if base_map(name) == name]
        if not flags["--rebuild"]:
            grids = [(area, name) for area, name in grids if name not in manifest.get("maps", {})]
    for area, name in grids:
        build(out, area, name, marks, pad, with_recovery, manifest)
        tmp = manifest_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(manifest, f, indent=1, sort_keys=True)
        os.replace(tmp, manifest_path)
    print("-> %s" % manifest_path, file=sys.stderr)


if __name__ == "__main__":
    main()
