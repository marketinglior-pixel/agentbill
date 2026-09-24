import { ORIGIN } from './site.js'
import { OG_VERSION } from '../lib/og-image.js'

// The one URL of the share card, for every surface that names it: og:image and
// twitter:image in head(), primaryImageOfPage in the WebPage node, and the
// SoftwareApplication node's image in ld.ts.
//
// Versioned because WhatsApp, Slack and X cache a card by its URL. Until
// 2026-09-24 every head emitted a bare /og.png, so a rebuilt card reached no
// chat that had already seen the old one: a WhatsApp preview of agentbill.dev
// kept a retired headline on the retired dark card. OG_VERSION is a hash of
// the PNG's bytes, written by scripts/og/build.mts beside the bytes, so the URL
// changes exactly when the card does and nobody types a number. The same
// /og.png route serves it; see server.ts for the cache headers per case.
export const OG_IMAGE = `${ORIGIN}/og.png?v=${OG_VERSION}`
