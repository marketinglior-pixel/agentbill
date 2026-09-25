import { GOOGLE_G, GITHUB_MARK, GOOGLE_FONT, PROVIDER_CSS } from './provider-marks.js'
import type { Provider } from '../lib/oauth.js'

// The one sign-in block, 2026-09-25: Continue with Google, Continue with
// GitHub, and an email field that mails a one-time link. /login, /register and
// the console's own sign-in card all render it, so the three cannot offer
// different ways in.
//
// It ships no script. The two provider buttons are links (a GET that starts a
// flow and changes nothing), and the email field is a plain form POST to
// /auth/email, which answers with a redirect to "check your inbox". A provider
// whose client id and secret are not both configured is simply not drawn
// (src/lib/oauth.ts), and the email field is always there, so the page is never
// left without a way in.

export type SigninFrom = 'login' | 'register' | 'app'

export interface SigninOpts {
  providers: readonly Provider[]
  /** Which page the email form returns to with ?sent=1. */
  from: SigninFrom
  /** A validated same-host path to land on afterwards, or ''. */
  next?: string
  /** The email button's words. */
  submit?: string
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export function signinPanel({ providers, from, next = '', submit = 'Email me a sign-in link' }: SigninOpts): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : ''
  const buttons = [
    providers.includes('google')
      ? `<a class="pbtn is-google" href="/auth/google${escAttr(q)}">${GOOGLE_G}<span>Continue with Google</span></a>` : '',
    providers.includes('github')
      ? `<a class="pbtn is-github" href="/auth/github${escAttr(q)}">${GITHUB_MARK}<span>Continue with GitHub</span></a>` : '',
  ].filter(Boolean)
  return `<div class="signin">
      ${buttons.length ? `<div class="signin-p">
        ${buttons.join('\n        ')}
      </div>
      <p class="signin-or"><span>or with a link by email</span></p>` : ''}
      <form class="signin-email" id="email-form" method="post" action="/auth/email">
        <input type="hidden" name="from" value="${from}" />
        ${next ? `<input type="hidden" name="next" value="${escAttr(next)}" />` : ''}
        <label class="cv-flabel" for="email">Work email</label>
        <input class="cv-field" type="email" id="email" name="email" placeholder="you@company.com" required autocomplete="email" maxlength="254" />
        <button type="submit" class="btn btn-lg btn-email">${submit}</button>
      </form>
    </div>`
}

/** The head line for the Google button's typeface, only when it is drawn. */
export const signinFonts = (providers: readonly Provider[]): string => (providers.includes('google') ? GOOGLE_FONT : '')

export const SIGNIN_CSS = `${PROVIDER_CSS}
  .signin { display: grid; gap: var(--s4); }
  .signin-p { display: grid; gap: var(--s3); }
  /* A hairline either side of a quiet line, so the email form reads as the
     other way in and not as a step after the buttons. */
  .signin-or { display: flex; align-items: center; gap: var(--s3); color: var(--dim); font-size: var(--fs-micro);
               font-family: var(--mono); letter-spacing: var(--track-label); text-transform: uppercase; margin: 0; }
  .signin-or::before, .signin-or::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
  .signin-email { display: grid; gap: 0; }
  .signin-email .btn-email { width: 100%; margin-top: var(--s3); }
`
