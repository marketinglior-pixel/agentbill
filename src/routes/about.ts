import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'

// The honest version of "photos of me and the team".
//
// There is no team. There are no customers yet. This page says both of those
// things rather than staging a company that does not exist: no stock
// photography, no illustrated avatars, no logo wall, no "trusted by". A
// founder's face goes in FOUNDER_PHOTO when there is a real one to use; until
// then the page ships without an image rather than with a grey silhouette,
// because a placeholder person is worse than no person.

/** Set to a served path once a real photograph exists. Nothing else needed. */
const FOUNDER_PHOTO: { src: string; alt: string } | null = null

export async function aboutRoute(app: FastifyInstance) {
  app.get('/about', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/about',
      title: 'About · AgentBill',
      description: 'Who builds AgentBill, why a per-task ceiling exists, and what the product deliberately does not do.',
      current: '',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        url: 'https://agentbill.dev/about',
        mainEntity: { '@id': 'https://agentbill.dev/#organization' },
      },
      body: `
  <h1>About</h1>
  <p class="lede">One person builds this. That is worth knowing before you put it
     in front of a production loop.</p>
${FOUNDER_PHOTO ? `
  <p><img src="${FOUNDER_PHOTO.src}" alt="${FOUNDER_PHOTO.alt}" width="240" height="240" loading="lazy" /></p>` : ''}

  <h2>Why it exists</h2>
  <p>Provider spend caps are monthly and per vendor. They tell you about the
     money after the month that spent it. An agent loop does its damage in an
     evening, across whichever providers the job happens to touch, and a cap
     that resets tomorrow does not stop the run that is going now.</p>
  <p>So the ceiling here is attached to a job rather than to a calendar. Every
     call that carries the same <code class="inline">task_ref</code> draws down
     one budget, whatever the provider, and the call that would break it does
     not go out.</p>

  <h2>What it deliberately is not</h2>
  <p>It is not a proxy. Your traffic does not route through anything of ours and
     we never hold your provider keys. It does not read your provider bill, and
     it does not convert the units you pass into money. It will not tell you
     what a call cost; it will stop the one that would cost too much, on the
     number you gave it.</p>

  <h2>Who is behind it</h2>
  <p>AgentBill is built and run by Lior Cohen. There is no team, no support
     rota, and no queue: mail goes to a person who reads it. If that matters to
     your risk assessment either way, it should, and it is why the page says so
     instead of writing "we" everywhere.</p>

  <h2>Where it is</h2>
  <p>The server, both SDKs and this website are one open repository. The
     mechanism this page describes is a few hundred lines of it, and you can
     read the ones that matter rather than take the description on trust.</p>

  <p class="end"><a class="btn" href="/register">Get your API key</a></p>
`,
    }))
  })
}
