#!/usr/bin/env bash
# Turn a photograph into src/lib/photo.ts.
#
#   ./scripts/photo/build.sh ~/Downloads/portrait.jpg
#
# Three things happen here and the middle one is the one that matters.
#
#   1. Resized to 640px on the long edge. It renders at 280px on /about, so 640
#      covers a 2x screen and nothing more.
#   2. **EXIF stripped.** A photo off a phone carries GPS coordinates, the
#      device, and the timestamp. Publishing it untouched publishes where it was
#      taken. -strip removes all of it. Verified below rather than assumed.
#   3. Encoded as a Buffer in a TS module, because the runtime image copies
#      dist/ and nothing else. Same pattern as og-image.ts and icons.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC="${1:?usage: build.sh <path-to-photo>}"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

magick "$SRC" -auto-orient -resize '640x640>' -strip -quality 82 "$TMP/founder.jpg"

# The verification, not a comment claiming it: if any GPS or device tag
# survived, stop rather than ship it.
LEFT=$(magick identify -verbose "$TMP/founder.jpg" | grep -icE 'gps|exif:|Make:|Model:' || true)
if [ "$LEFT" != "0" ]; then
  echo "refusing to write: $LEFT EXIF/GPS field(s) survived the strip" >&2
  magick identify -verbose "$TMP/founder.jpg" | grep -iE 'gps|exif:|Make:|Model:' >&2
  exit 1
fi

# Not `read < <(...)`: identify prints no trailing newline, so read returns
# non-zero at EOF and set -e kills the script after doing all the work.
DIM=$(magick identify -format '%w %h' "$TMP/founder.jpg")
W=${DIM%% *}; H=${DIM##* }
B64=$(base64 < "$TMP/founder.jpg" | tr -d '\n')
DATE=$(date +%Y-%m-%d)

cat > src/lib/photo.ts <<EOF
// The founder photograph, served at /founder.jpg.
// Generated ${DATE} by scripts/photo/build.sh from a file that is NOT in this
// repository. Re-run the script to replace it; do not edit this by hand.
//
// EXIF is stripped, and the script refuses to write this file if any GPS or
// device tag survives. A phone photo carries the coordinates it was taken at.

export const FOUNDER_JPG: Buffer = Buffer.from('${B64}', 'base64')
export const FOUNDER_W = ${W}
export const FOUNDER_H = ${H}
EOF
echo "wrote src/lib/photo.ts  (${W}x${H}, $(wc -c < "$TMP/founder.jpg" | tr -d ' ') bytes, EXIF clean)"
