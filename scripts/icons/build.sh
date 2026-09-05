#!/usr/bin/env bash
# Regenerate src/lib/icons.ts from the mark.
#
# The two raster icons are derived, never drawn: this script renders them from
# FAVICON_SVG in src/ui/mark.ts, which is the single definition of the mark. If
# the mark changes, run this and commit the result. Hand-editing src/lib/icons.ts
# creates a second drawing that will disagree with the SVG the day either moves.
#
# Needs rsvg-convert and ImageMagick (`brew install librsvg imagemagick`). They
# are build-time only; nothing here ships in the runtime image.
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/emit.mts" <<'TS'
import { FAVICON_SVG } from '../../src/ui/mark.js'
process.stdout.write(FAVICON_SVG)
TS
mkdir -p "$TMP/a/b" && mv "$TMP/emit.mts" "$TMP/a/b/emit.mts"
cp "$TMP/a/b/emit.mts" ./.icons-emit.mts
sed -i '' "s|'../../src/ui/mark.js'|'./src/ui/mark.js'|" ./.icons-emit.mts
npx tsx ./.icons-emit.mts > "$TMP/mark.svg"
rm -f ./.icons-emit.mts

# .ico carries 16 and 32 only. ICO entries are uncompressed BMP, so a 48 costs
# 9KB of base64 in source for a size nothing asks for: anything that can render
# 48 can render /favicon.svg, and /favicon.ico exists for the clients that cannot.
for s in 16 32; do rsvg-convert -w $s -h $s "$TMP/mark.svg" -o "$TMP/i-$s.png"; done
magick "$TMP/i-16.png" "$TMP/i-32.png" "$TMP/favicon.ico"

# apple-touch-icon is opaque on purpose: iOS composites transparency onto black.
rsvg-convert -w 180 -h 180 "$TMP/mark.svg" -o "$TMP/a180.png"
magick "$TMP/a180.png" -background '#22d3a0' -alpha remove -alpha off -strip "$TMP/apple-touch-icon.png"

ICO=$(base64 < "$TMP/favicon.ico" | tr -d '\n')
APL=$(base64 < "$TMP/apple-touch-icon.png" | tr -d '\n')
DATE=$(date +%Y-%m-%d)

cat > src/lib/icons.ts <<EOF
// Raster icons, rendered from FAVICON_SVG in src/ui/mark.ts.
// Generated ${DATE} by scripts/icons/build.sh. Do not edit by hand: rerun the
// script instead, or these stop being the same drawing as the mark.
//
// Buffers rather than files on disk because the Dockerfile's runtime stage
// copies dist/ and nothing else, so a file would need its own COPY line and a
// .dockerignore review while a compiled Buffer arrives for free. Same pattern
// as src/lib/og-image.ts.

/** 16 + 32 + 48. Crawlers and older Safari probe /favicon.ico whatever the <link> tags say. */
export const FAVICON_ICO: Buffer = Buffer.from('${ICO}', 'base64')

/** 180x180, opaque. Doubles as Organization.logo, which Google will not accept as SVG. */
export const APPLE_TOUCH_PNG: Buffer = Buffer.from('${APL}', 'base64')
EOF
echo "wrote src/lib/icons.ts  (ico $(wc -c < "$TMP/favicon.ico") bytes, apple $(wc -c < "$TMP/apple-touch-icon.png") bytes)"
