import { inlineScript } from './csp.js'
// Pixel base code for marketing pages (home, register, pricing).
// Each snippet renders nothing until its env var is set, so the site
// stays clean until the pixel exists in the ad platform. Conversion
// events (CompleteRegistration, SignUp) fire from the register page's
// success handler.
export function pixelSnippet(): string {
  return [metaSnippet(), redditSnippet()].filter(Boolean).join('\n')
}

// Meta Pixel, renders nothing until META_PIXEL_ID is set.
function metaSnippet(): string {
  const id = process.env.META_PIXEL_ID
  if (!id || !/^\d{5,20}$/.test(id)) return ''
  return `<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none" alt=""
src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`
}

// Reddit Pixel, renders nothing until REDDIT_PIXEL_ID is set.
// Ids look like "a2_xxxxxxxx" (or "t2_" for older accounts).
function redditSnippet(): string {
  const id = process.env.REDDIT_PIXEL_ID
  if (!id || !/^[at]2_[a-z0-9]+$/i.test(id)) return ''
  return `<script>
!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js";t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);
rdt('init','${id}');
rdt('track','PageView');
</script>`
}

/**
 * What the CSP has to allow for whichever pixels are configured.
 *
 * Both return empty when no pixel env var is set, which is the current state:
 * META_PIXEL_ID has never been set, and REDDIT_PIXEL_ID was unset once the
 * channel it served was killed. If either is set again, the policy widens by
 * exactly the origin that needs it and nothing else.
 */
/** Image and connect origins each configured pixel beacons to. */
export function pixelExtra(): { script: string[]; img: string[]; connect: string[] } {
  const out = { script: [] as string[], img: [] as string[], connect: [] as string[] }
  if (metaSnippet()) { out.script.push('https://connect.facebook.net'); out.img.push('https://www.facebook.com'); out.connect.push('https://www.facebook.com') }
  if (redditSnippet()) { out.script.push('https://www.redditstatic.com'); out.img.push('https://alb.reddit.com', 'https://www.redditstatic.com'); out.connect.push('https://alb.reddit.com') }
  return out
}

export function pixelScriptSrc(): string[] {
  const out: string[] = []
  if (metaSnippet()) out.push('https://connect.facebook.net')
  if (redditSnippet()) out.push('https://www.redditstatic.com')
  return out
}

/** Hashes for the inline base code each pixel injects. */
export function pixelHashes(): string[] {
  const out: string[] = []
  for (const snip of [metaSnippet(), redditSnippet()]) {
    if (!snip) continue
    const m = snip.match(/<script>([\s\S]*?)<\/script>/)
    if (m) out.push(inlineScript(m[1]).hash)
  }
  return out
}
