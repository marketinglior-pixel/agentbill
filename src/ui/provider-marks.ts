// The two third-party marks the sign-in buttons carry, as their owners publish
// them, and the button styling their brand rules fix.
//
// Exempt from the hex ratchet (scripts/ratchet/count.mjs) for the reason the
// AgentBill mark is: these colours are not ours to tokenise. Google's rules
// (developers.google.com/identity/branding-guidelines, read 2026-09-25): the
// standard colour "G", unaltered, on a white ground; light button fill
// #FFFFFF, a 1px inside stroke #747775, text #1F1F1F in Google Sans Medium
// 14/20; 12px before the logo, 10px after it, 12px after the text; pill shape
// allowed; the words "Continue with Google". GitHub's: the Invertocat mark,
// unaltered, in one colour.

/** Google's standard "G", the one its own sign-in button draws. */
export const GOOGLE_G = `<svg class="pm" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>`

/** GitHub's Invertocat mark, in the button's ink. */
export const GITHUB_MARK = `<svg class="pm" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`

/** Google Sans Medium, only the glyphs "Continue with Google" needs. */
export const GOOGLE_FONT = `  <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@500&text=Continue%20with%20Google&display=swap" rel="stylesheet" />`

/** The two provider buttons. The Google one is Google's light button to the
 *  letter; the GitHub one takes the same shape so the pair reads as one set,
 *  with GitHub's mark in the site's ink. 44px tall, the kit's L height. */
export const PROVIDER_CSS = `
  :root { --gsi-fill: #FFFFFF; --gsi-line: #747775; --gsi-ink: #1F1F1F; }
  .pbtn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
          min-height: var(--h-lg); padding: 0 12px; border-radius: var(--r-control); text-decoration: none;
          font-weight: 500; font-size: var(--fs-small); line-height: 20px; white-space: nowrap; cursor: pointer;
          transition: background .15s, border-color .15s; }
  .pbtn .pm { flex: none; width: 20px; height: 20px; }
  .pbtn.is-google { background: var(--gsi-fill); border: 1px solid var(--gsi-line); color: var(--gsi-ink);
                    font-family: 'Google Sans', var(--sans); }
  .pbtn.is-github { background: var(--surface); border: 1px solid var(--border2); color: var(--text); font-family: var(--sans); }
  .pbtn:hover { text-decoration: none; }
  .pbtn.is-github:hover { border-color: var(--dim); }
  .pbtn:active { transform: translateY(1px); }
  .pbtn:focus-visible { outline: 2px solid var(--field-focus); outline-offset: 2px; }
`
