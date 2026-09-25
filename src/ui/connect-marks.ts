// The mark beside each connection on /integrations/mcp (2026-09-25).
//
// The rule: a brand's own mark is used only when its owner publishes it for
// this kind of use and its guidelines were read and allow it. Where they do
// not, or could not be read, or no official asset exists, the tab carries a
// NEUTRAL icon drawn here for a kind of tool (a chat, a terminal, an editor, a
// plug-in) that imitates no one's logo, and the name beside it does the
// naming. Every entry below records what was checked, where, and the decision,
// and the [connect-marks] gate in scripts/preflight/verify.mjs fails when an
// entry loses its record or a tab loses its mark.
//
// Read on 2026-09-25:
//
//   claude, claude-code
//     source:    Simple Icons 16.32.0 "claude" (source claude.ai) and "claudecode" (source code.claude.com)
//     guideline: https://www.anthropic.com/legal/trademark-guidelines
//     decision:  generic. "You may only use our trademarks as specifically permitted by us and only in
//                materials we approve beforehand." No approval, so no mark.
//   chatgpt, codex
//     source:    none usable. OpenAI is not in Simple Icons 16.32.0, and https://openai.com/brand/
//                answered 403, so no official asset or rule could be read.
//     guideline: https://openai.com/brand/ (not readable from here)
//     decision:  generic.
//   cursor
//     source:    Simple Icons 16.32.0 "cursor" (source https://cursor.com/brand), and the SVGs on that page
//     guideline: https://cursor.com/brand. The page states no third-party rules; they are in its
//                downloadable ZIP, which was not downloaded here.
//     decision:  generic until someone reads the kit's rules. Switching to the mark is a one-line change here.
//   antigravity
//     source:    none. Not in Simple Icons 16.32.0; no public brand kit found (antigravity.google/brand is 404).
//     guideline: none found
//     decision:  generic.
//   other (VS Code, and any client)
//     source:    not in Simple Icons 16.32.0 (removed at Microsoft's request)
//     guideline: https://code.visualstudio.com/brand. It forbids using the icon to "identify or promote
//                your own product" or "associate your offerings with Microsoft or its brands".
//     decision:  generic.
//   openclaw
//     source:    none. Not in Simple Icons 16.32.0; openclaw.ai and openclaw.ai/press publish no logo kit
//                (only a footer image of the OpenClaw Foundation logo), and no trademark policy was found.
//     guideline: none found (press@openclaw.org is the contact)
//     decision:  generic.
//
// Every icon is currentColor, so it takes the tab's ink in light and dark and
// holds no hex, and aria-hidden: the text label is what a screen reader reads.

const svg = (body: string) =>
  `<svg class="mcp-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`

/** A chat assistant: a speech bubble. */
const CHAT = svg('<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>')
/** A command-line tool: a prompt in a window. */
const TERMINAL = svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/>')
/** An editor: angle brackets and a slash. */
const EDITOR = svg('<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M13.5 5l-3 14"/>')
/** A plug-in that runs inside its host: a plug. */
const PLUGIN = svg('<path d="M9 3v5"/><path d="M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>')

export type ConnectMark = { svg: string; kind: 'generic' | 'official' }

/** One per tab on /integrations/mcp, keyed by the tab's id. */
export const CONNECT_MARKS: Record<string, ConnectMark> = {
  claude: { svg: CHAT, kind: 'generic' },
  chatgpt: { svg: CHAT, kind: 'generic' },
  'claude-code': { svg: TERMINAL, kind: 'generic' },
  codex: { svg: TERMINAL, kind: 'generic' },
  cursor: { svg: EDITOR, kind: 'generic' },
  antigravity: { svg: EDITOR, kind: 'generic' },
  openclaw: { svg: PLUGIN, kind: 'generic' },
  other: { svg: EDITOR, kind: 'generic' },
}
