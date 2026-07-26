#!/usr/bin/env bash
# Regenerates po/eppmode.pot from extension.js, merges it into the
# existing .po files, and compiles them into locale/. Idempotent.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname "${script_dir}")"
cd "${repo_dir}"

xgettext --from-code=UTF-8 --language=JavaScript \
  --keyword=_ --keyword=pgettext:1c,2 \
  --package-name=eppmode --package-version=1 \
  --copyright-holder="EPP Power Modes contributors" \
  -o po/eppmode.pot extension.js

for lang_po in po/*.po; do
  lang="$(basename "${lang_po}" .po)"
  msgmerge --quiet --update --backup=off "${lang_po}" po/eppmode.pot
  mkdir -p "locale/${lang}/LC_MESSAGES"
  msgfmt "${lang_po}" -o "locale/${lang}/LC_MESSAGES/eppmode.mo"
  echo "Built locale/${lang}/LC_MESSAGES/eppmode.mo"
done
