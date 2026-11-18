# oot-voidgrid

A 3D viewer for the 1 m grid that Ocarina of Time checks for void-outs and save recovery, drawn over each map's
collision.

For every map it shows:
- **Grid cells**, coloured by their stored attributes: `OutsideOuterBoundary`, `OuterBoundaryDist`, `Intersect`,
  `InWater` and `InDoor`. The default view marks the **void-out cubes**: `OutsideOuterBoundary` = 1 and
  `OuterBoundaryDist` × 2/3 over 3 (5 or more).
- **Contact areas**: placed areas whose logic voids Link when he touches them (`Gimmick_AreaContact_FallDown*`, the
  Water Temple whirlpool, ...). Conditional ones (prefab logic) are drawn in purple.
- **The void box**: the map's `VolumeStatsAABB` grown by 5 m. Further out than that the game voids Link at once,
  whatever the cells say.
- **Collision**, in two views:
  - what stops Link;
  - what Link's ragdoll hits. Front faces only: the ragdoll passes through a triangle from behind.
- **Save recovery**: for every 1 m of floor, whether saving there reloads you there (*follows*), or the restart
  point stays where it was last set (*holds*).

The game-file decoding and the rules behind these views are documented in the
[sloperina](https://github.com/ontrigger/sloperina) repo: `tools/volumestats.py`, `tools/phive.py` and
`docs/FINDINGS.md` §9.7–9.8.

## Building

You need Node.js and pnpm for the page, [uv](https://docs.astral.sh/uv/) for the Python scripts in `scripts/` (it
installs their dependencies on the first run), a dump of the game, and a checkout of sloperina next to this repo, or
`SLOPERINA_TOOLS` pointing at its `tools/` folder.

```sh
pnpm install
export OOTMENU_NUP="F:/path/to/game.nup"    # Windows-style path
pnpm data --all                              # about an hour; or name maps: pnpm data KokiriForest_Child
pnpm dev                                     # then open the URL it prints
```

`pnpm data` runs `scripts/build.py`, which adds to what is already in `site/data/`. Its docstring lists the options
and describes the data files.

The page is TypeScript (`site/src/`, three.js), bundled with Vite: `pnpm dev` serves it with `site/data/`,
`pnpm check` type-checks it, `pnpm build` writes the page alone to `dist/`. It fetches its data, so it has to be
served over http; opening a file from disk won't work.

## Publishing

`site/data/` isn't committed. `pnpm deploy-site` (`scripts/publish.py`) builds the page and puts it and `site/data/` on a fresh orphan
`gh-pages` branch in `.publish/` and prints the push command; `--push` pushes it. Then enable Pages on the `gh-pages` branch.

## Limits

- Moving platforms and other actors aren't included.
- The 8 m rule isn't drawn: with no mapped cell under Link, he voids once the nearest cell the game has found (probe
  C, which keeps its best until a nearer one turns up) is 8 m or more away, measured level. That depends on the path
  Link took, so a spot with no red cube and inside the void box can still void. A red cube counts from any height:
  the cast down that finds it is 5000 m long.
- The save-recovery rule has been checked against an in-game log in Inside Ganon's Castle only.
- On field maps, the outer-boundary part of the save-recovery rule hasn't been checked in game yet.
