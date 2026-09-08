import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { FOUNDER_W, FOUNDER_H } from '../lib/photo.js'
import { KEY_CTA } from '../ui/chrome.js'

// The honest version of "photos of me and the team".
//
// There is no team. There are no customers yet. This page says both of those
// things rather than staging a company that does not exist: no stock
// photography, no illustrated avatars, no logo wall, no "trusted by". A
// founder's face goes in FOUNDER_PHOTO when there is a real one to use; until
// then the page ships without an image rather than with a grey silhouette,
// because a placeholder person is worse than no person.

// A real photograph of a real person, which is the only kind this page will
// carry. No stock, no illustrated avatar, no silhouette standing in for one.
// Served from a compiled Buffer at /founder.jpg; see scripts/photo/build.sh,
// which strips EXIF and refuses to write the module if a GPS or device tag
// survives.
const FOUNDER_PHOTO = {
  src: '/founder.jpg',
  alt: 'Lior Cohen, who builds and runs AgentBill',
  w: FOUNDER_W,
  h: FOUNDER_H,
}

export async function aboutRoute(app: FastifyInstance) {
  app.get('/about', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/about',
      // Four sections and about 450 words. A table of contents there announces
      // that the docs template was reused without judgment, and on a phone it
      // put 312px of navigation furniture above the H1. /status, /blog and
      // /thanks already opt out for the same reason.
      rail: false,
      title: 'About · AgentBill',
      description: 'Who builds AgentBill, why a per-task ceiling exists, and what the product deliberately does not do.',
      current: '',
      css: `
    /* width/height on the img are the real dimensions, so the space is
       reserved before it loads and nothing below it jumps. */
    .who-is { display: grid; grid-template-columns: 240px minmax(0, 1fr);
              gap: var(--s5); align-items: start; margin-block: var(--s4); }
    .who-photo { width: 100%; height: auto; border-radius: var(--r-frame);
                 border: 1px solid var(--border); display: block; }
    @media (max-width: 640px) {
      .who-is { grid-template-columns: minmax(0, 1fr); }
      .who-photo { max-width: 200px; }
    }
`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        '@id': 'https://agentbill.dev/about#aboutpage',
        url: 'https://agentbill.dev/about',
        mainEntity: { '@id': 'https://agentbill.dev/#organization' },
      },
      body: `
  <h1>About</h1>
  <p class="lede">One person builds this. That is worth knowing before you put it
     in front of a production loop.</p>

  <h2>Why it exists</h2>
  <p>Provider spend caps are real and they fire. What they are bound to is a
     project, an organization over a calendar month, or one session on that
     vendor's own harness. An agent loop does its damage in an evening, across
     whichever providers the job happens to touch, and a boundary drawn around
     the month is not drawn around that run.</p>
  <p>So the ceiling here is attached to a job rather than to a calendar. Every
     call that carries the same <code class="inline">task_ref</code> draws down
     one budget, whatever the provider, and the preflight for the call that would
     break it comes back <code class="inline">approved: false</code>.</p>

  <h2>What it deliberately is not</h2>
  <p>It is not a proxy. Your traffic does not route through anything of ours and
     we never hold your provider keys. It does not read your provider bill, and
     it does not convert the units you pass into money. It will not tell you
     what a call cost; it refuses the one that would cross the number you gave
     it, and what happens to the run after that is your code's decision.</p>

  <h2>Who is behind it</h2>
  <div class="who-is row-close">
    <img class="who-photo" src="${FOUNDER_PHOTO.src}" alt="${FOUNDER_PHOTO.alt}"
         width="${FOUNDER_PHOTO.w}" height="${FOUNDER_PHOTO.h}" loading="lazy" decoding="async" />
    <div>
      <p>AgentBill is built and run by Lior Cohen. There is no team, no support
         rota, and no queue: mail goes to a person who reads it. If that matters
         to your risk assessment either way, it should, and it is why the page
         says so instead of writing "we" everywhere.</p>
      <p>That is also the whole argument for the ceiling. One person cannot
         watch a loop at three in the morning, so the ceiling has to be the
         thing that does.</p>
    </div>
  </div>

  <h2>Where it is</h2>
  <p>The server, both SDKs and this website are one open repository. The
     mechanism this page describes is a few hundred lines of it, and you can
     read the ones that matter rather than take the description on trust.</p>

  <p class="end"><a class="btn" href="/register">${KEY_CTA}</a></p>
`,
    }))
  })
}
