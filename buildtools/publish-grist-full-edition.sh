#!/usr/bin/env bash
#
# Builds a complete, self-contained "full edition" package from an already-built
# `grist` image and publishes it to the static host, so a grist-oss installation
# can download it and run it instead of the baked-in OSS build at runtime.
# See app/server/lib/bootstrapFullEdition.ts.
#
# The package is the exact `grist` image app payload, so it is byte-identical to
# what ships there (core <-> ext stay in lockstep). Per-arch (it contains native
# deps, e.g. @gristlabs/sqlite3). It produces, for label ${LABEL}:
#   - grist-${LABEL}-amd64.tar.gz
#   - grist-${LABEL}-arm64.tar.gz
# Each tarball extracts to:
#   grist/         <- the image's /grist (full _build, EE static, core node_modules,
#                     sandbox, bower_components, plugins, ext/assets, package.json, …)
#   node_modules/  <- the image's root /node_modules (ext deps), sibling to grist/
#
# Objects are laid out by channel, then a per-day build sequence, so the bucket stays
# navigable and the nightly channel can be pruned (lifecycle rule) without touching
# releases:
#   ${PREFIX}/${CHANNEL}/${YYYYMMDD}.${NNNN}/grist-${LABEL}-${arch}.tar.gz
# The unique ${NNNN} dir makes each build's path distinct, so a later build never
# clobbers an artifact an existing image depends on (no sha in the name needed). The
# sequence is allocated by listing S3 (highest existing + 1); the publish workflow
# serializes its runs (a `concurrency:` group) so the list->use step can't race.
#
# This script is the single source of the object name: it emits the full per-arch
# download URL and sha256 to $GITHUB_OUTPUT so the grist-oss build can bake them in
# (GRIST_FULL_EDITION_URL_<arch> / GRIST_FULL_EDITION_SHA256_<arch>); the runtime
# fetches the baked URL verbatim and verifies the bytes against the baked sha.
#
# Required env:
#   IMAGE    - the pushed grist image reference (e.g. gristlabs/grist:stable)
#   CHANNEL  - release | nightly (selects the prefix and retention policy)
#   LABEL    - human-friendly name embedded in the filename (release: the tag, e.g.
#              v1.7.8; nightly: latest-<commit>). This is cosmetic — NOT the stamp.
#              The stamp is the commit, baked separately as GRIST_FULL_EDITION_REF.

set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${CHANNEL:?CHANNEL is required (release|nightly)}"
: "${LABEL:?LABEL is required}"

BUCKET="${GRIST_STATIC_S3_BUCKET:-grist-static}"
PREFIX="${GRIST_STATIC_S3_PREFIX:-grist-full-edition}"
HOST="${GRIST_STATIC_HOST:-https://grist-static.com}"
DATE="$(date -u +%Y%m%d)"

work="$(mktemp -d)"

have_creds() { [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; }
sha_of() { sha256sum "$1" | awk '{print $1}'; }

# Next zero-padded build sequence for today's channel/date (highest existing + 1, else
# 0001). Lists S3, so it needs creds + s3:ListBucket and relies on the workflow's
# concurrency group to serialize runs. `10#` forces base-10 (a zero-padded value like
# 0008 would otherwise be read as octal).
allocate_seq() {
  local last
  last="$(aws s3 ls "s3://${BUCKET}/${PREFIX}/${CHANNEL}/" 2>/dev/null \
    | grep -oE "${DATE}\.[0-9]+" | sed -E 's/.*\.//' | sort -n | tail -1 || true)"
  printf '%04d' "$(( 10#${last:-0} + 1 ))"
}

declare -A shas
for arch in amd64 arm64; do
  stage="$work/$arch"
  mkdir -p "$stage"

  # `docker cp` copies (doesn't execute), so no QEMU is needed for the other arch.
  docker create --platform "linux/$arch" --name "grist-full-edition-$arch" "$IMAGE"
  docker cp "grist-full-edition-$arch:/grist" "$stage/grist"
  docker cp "grist-full-edition-$arch:/node_modules" "$stage/node_modules"
  docker rm "grist-full-edition-$arch"

  # Source maps are dev-only; drop them to trim the (large) package.
  find "$stage" -name '*.map' -delete

  # Drop dangling symlinks (checked-in dev/test links such as static/mocha.css,
  # static/sinon.js, bower_components/bootstrap, which point at devDependencies that
  # are absent from the production node_modules). They're unused at runtime, and
  # leaving them in breaks the container entrypoint's chown over /persist (it
  # dereferences symlinks) once this payload is unpacked there.
  find "$stage" -xtype l -delete

  tmp="$work/$arch.tgz"
  tar czf "$tmp" -C "$stage" .
  shas[$arch]="$(sha_of "$tmp")"
  mv "$tmp" "grist-${LABEL}-${arch}.tar.gz"
done

# Allocate this build's slot. Without creds (local/dry runs) we can't list S3, so fall
# back to 0001 for local artifact naming; nothing consumes the URL in that case.
if have_creds; then SEQ="$(allocate_seq)"; else SEQ="0001"; fi
DIR="${CHANNEL}/${DATE}.${SEQ}"

# Expose the per-arch download URL + checksum to the grist-oss build (baked in: the
# runtime fetches the URL and verifies the bytes against the sha).
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    for arch in amd64 arm64; do
      echo "full_url_${arch}=${HOST}/${PREFIX}/${DIR}/grist-${LABEL}-${arch}.tar.gz"
      echo "full_sha256_${arch}=${shas[$arch]}"
    done
  } >> "$GITHUB_OUTPUT"
fi

# Upload. Credentials come from the environment (GitHub secrets in CI); `aws s3 cp`
# reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION automatically.
# Skipped gracefully when creds aren't set (local/dry runs), so the build never fails
# for lack of an upload. Re-uploading is safe: the unique ${DIR} means a build's
# objects never land on top of another build's.
if have_creds; then
  echo "+ Uploading to s3://$BUCKET/$PREFIX/$DIR/"
  for arch in amd64 arm64; do
    f="grist-${LABEL}-${arch}.tar.gz"
    aws s3 cp "$f" "s3://$BUCKET/$PREFIX/$DIR/$f"
  done
  echo "+ Uploaded to ${HOST}/${PREFIX}/${DIR}/"
else
  echo "+ AWS credentials not set; skipping upload. Built artifacts:"
  ls -1 grist-"${LABEL}"-*.tar.gz
fi

rm -rf "$work"
