#!/usr/bin/env bash
set -euo pipefail
mkdir site
if [ -d stored-site ]; then
  rsync -a --exclude='.git' stored-site/ site/
fi
# Replace production while retaining every other preview.
# Git checkout and downloaded artifacts can give different contents identical metadata.
rsync -a --checksum --delete --exclude='pr-preview' --exclude='branch-preview' incoming/site-production/ site/
if [ -n "$PREVIEW_PATH" ]; then
  [[ "$PREVIEW_PATH" =~ ^(pr-preview/pr-[0-9]+|branch-preview/[a-zA-Z0-9-]+)$ ]]
  if [ "$REMOVE_PREVIEW" = true ]; then
    rm -rf -- "site/$PREVIEW_PATH"
  else
    mkdir -p "site/$PREVIEW_PATH"
    rsync -a --checksum --delete incoming/site-preview/ "site/$PREVIEW_PATH/"
  fi
fi
# A preview can never replace the root index or production revision marker.
cmp incoming/site-production/index.html site/index.html
cmp incoming/site-production/deployed-version.json site/deployed-version.json
touch site/.nojekyll
