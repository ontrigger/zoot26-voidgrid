"""Put the site (the built page in dist/, plus site/data) on the gh-pages branch as a single fresh commit, so the data never piles up in
the repo's history.

    pnpm deploy-site             build the page (pnpm build), commit it and the data to a fresh orphan gh-pages in .publish/ and print the push command
    pnpm deploy-site --push      ... and force-push it to origin's gh-pages

Then in the repo's settings on GitHub: Pages > Build and deployment > Deploy from a branch > gh-pages, / (root).
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the repo
DATA = os.path.join(ROOT, "site", "data")
DIST = os.path.join(ROOT, "dist")
WORK = os.path.join(ROOT, ".publish")


def git(*args, cwd=WORK):
    subprocess.run(["git", *args], cwd=cwd, check=True)


def main():
    if not os.path.exists(os.path.join(DATA, "manifest.json")):
        raise SystemExit("site/data is empty: run pnpm data first")
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise SystemExit("pnpm not found: the page is built with it (pnpm install, then pnpm build)")
    subprocess.run([pnpm, "build"], cwd=ROOT, check=True)
    remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True)
    remote = remote.stdout.strip()
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    shutil.copytree(DIST, WORK)
    shutil.copytree(DATA, os.path.join(WORK, "data"), ignore=shutil.ignore_patterns("*.tmp"))
    open(os.path.join(WORK, ".nojekyll"), "w").close()  # serve the files as they are
    git("init", "-q", "-b", "gh-pages")
    git("add", "-A")
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    git("commit", "-q", "-m", "Site built from %s" % (head.stdout.strip() or "a working tree"))
    push = ["git", "push", "-f", remote or "<your GitHub repo URL>", "gh-pages"]
    if "--push" in sys.argv[1:]:
        if not remote:
            raise SystemExit("no origin remote: add one (git remote add origin <url>) or push from .publish/ yourself")
        subprocess.run(push, cwd=WORK, check=True)
    else:
        print("ready in %s; to publish:\n  cd .publish && %s" % (WORK, " ".join(push)))


if __name__ == "__main__":
    main()
