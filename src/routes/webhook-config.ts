import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { plain } from '../lib/ids.js'
import { checkWebhookUrl, newWebhookNonce, webhookSecretFor } from '../lib/webhook-target.js'

const WebhookConfigBody = z.object({
  // .url() is not a filter: the WHATWG parser tolerates a control character
  // and zod returns the ORIGINAL string, NUL included, so this was a 500.
  url: plain(z.string().url().startsWith('https://').max(2048)),
})

export async function webhookConfigRoute(app: FastifyInstance) {
  app.post('/webhook-config', async (request, reply) => {
    const parse = WebhookConfigBody.safeParse(request.body)
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const { url } = parse.data
    const accountId = request.accountId

    // The address rules, at save time. The sender checks them again on the
    // address it actually dials, because DNS can change after this answer.
    const verdict = await checkWebhookUrl(url)
    if (!verdict.ok) {
      return reply.code(422).send({
        error: 'webhook_url_refused',
        message: `This URL cannot be used for the webhook: ${verdict.reason}. It must be https on a public address.`,
      })
    }

    // A new secret on every save: saving is how an account rotates it.
    const nonce = newWebhookNonce()
    const secret = webhookSecretFor(nonce)
    if (!secret) {
      request.log.error('webhook-config: no signing key on this server (WEBHOOK_SIGNING_KEY, APP_SESSION_SECRET and ADMIN_SECRET are all unset)')
      return reply.code(503).send({ error: 'webhook_signing_unavailable', message: 'Webhooks cannot be configured on this server right now.' })
    }

    await sql`
      UPDATE accounts SET webhook_url = ${url}, webhook_secret_nonce = ${nonce} WHERE id = ${accountId}
    `

    return reply.send({
      webhook_url: url,
      // Shown once. Store it where your receiver reads it; saving the URL
      // again issues a new one and the old one stops matching.
      signing_secret: secret,
      signature_header: 'X-AgentBill-Signature',
    })
  })
}
