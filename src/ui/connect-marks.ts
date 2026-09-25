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
//   chatgpt
//     source:    OpenAI's own kit, https://cdn.openai.com/brand/openai-logos.zip, file
//                OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg, downloaded 2026-09-25 after ticking
//                "By using our logos, you agree to our Marks usage terms" on https://openai.com/brand/
//                (Lior agreed to those terms in chat).
//     guideline: https://openai.com/brand/ ("Only use our Marks if they adhere to these brand guidelines";
//                "Use the logo only when it directly relates to OpenAI services"; "Use the logo exactly as
//                provided"; do not imply endorsement; "Do not feature our Marks more prominently than your
//                own"; no added colours). Connecting AgentBill to ChatGPT and to Codex relates directly to
//                those services, the Blossom is used as provided (black, its paths untouched, only sized),
//                it is 18px beside a text label, smaller than our own wordmark in the header, and the copy
//                says "Connect AgentBill to", never partner or endorsement.
//     decision:  official (the Blossom, which OpenAI uses for ChatGPT; Codex has no separate mark in the kit).
//   codex
//     source:    the same file as chatgpt: OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg from
//                https://cdn.openai.com/brand/openai-logos.zip. The kit has no separate Codex mark.
//     guideline: https://openai.com/brand/, the same terms as chatgpt. Codex is OpenAI's, and the tab
//                connects AgentBill to it, so the use relates directly to an OpenAI service.
//     decision:  official (the Blossom, as provided).
//   cursor
//     source:    Cursor's own kit, https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip
//                (linked as "Download brand assets" on https://cursor.com/brand), file
//                General Logos/Cube/SVG/CUBE_2D_LIGHT.svg, downloaded 2026-09-25 with Lior's approval.
//     guideline: https://cursor.com/brand: "Resources to represent Cursor consistently and accurately", and
//                "Refer to us as Cursor". The kit holds only asset files, no further rules. The cube is used
//                as provided (its one fill, #26251e, and paths untouched, only sized) for the light page.
//     decision:  official.
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

/** OpenAI's Blossom, as provided in its kit (see the record above). Its viewBox
 *  carries OpenAI's prescribed clear space, so the Blossom fills about half of
 *  it: the box is drawn larger (data-mark="roomy") instead of cropping that space
 *  away, and the clear space eats the extra size. */
const OPENAI_BLOSSOM = `<svg class="mcp-mark" data-mark="roomy" width="30" height="30" viewBox="0 0 716 716" aria-hidden="true" focusable="false"><path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z" fill="black"/></svg>`
/** Cursor's 2D cube for light backgrounds, as provided in its kit (see the record above). */
const CURSOR_CUBE = `<svg class="mcp-mark" width="18" height="18" viewBox="0 0 466.73 532.09" aria-hidden="true" focusable="false"><path fill="#26251e" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>`

export type ConnectMark = { svg: string; kind: 'generic' | 'official' }

/** One per tab on /integrations/mcp, keyed by the tab's id. */
export const CONNECT_MARKS: Record<string, ConnectMark> = {
  claude: { svg: CHAT, kind: 'generic' },
  chatgpt: { svg: OPENAI_BLOSSOM, kind: 'official' },
  'claude-code': { svg: TERMINAL, kind: 'generic' },
  codex: { svg: OPENAI_BLOSSOM, kind: 'official' },
  cursor: { svg: CURSOR_CUBE, kind: 'official' },
  antigravity: { svg: EDITOR, kind: 'generic' },
  openclaw: { svg: PLUGIN, kind: 'generic' },
  other: { svg: EDITOR, kind: 'generic' },
}
