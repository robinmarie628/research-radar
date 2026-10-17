#!/usr/bin/env bash
# Cloudflare Pages build step for 科研雷达.
#
# Dashboard settings:
#   Framework preset       : None
#   Build command          : bash scripts/pages-build.sh
#   Build output directory : dist
#   Production branch      : main
#
# Why stage into dist/ instead of publishing the repo root:
# the repo also contains scripts/, worker/, .github/ and docs. Publishing them
# is harmless (the repo is public) but clutters the site and leaks the Worker
# source path. This copies only the files the app actually serves.
set -euo pipefail

rm -rf dist
mkdir -p dist

cp index.html manifest.webmanifest sw.js _headers dist/
cp -r assets data dist/

# GitHub Pages marker; not required by Pages, but harmless to carry over.
if [ -f .nojekyll ]; then cp .nojekyll dist/; fi

echo "pages-build: staged $(find dist -type f | wc -l) files into dist/"
