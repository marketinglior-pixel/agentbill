import { ORIGIN } from './site.js'
import { inlineScript } from '../lib/csp.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from './copy.js'
import { CONNECT_MARKS } from './connect-marks.js'
import { SDK_VERSIONS } from '../lib/llms.js'

// /integrations/mcp as a connect page, 2026-09-25: platform tabs across the
// top, one Connect action per platform, the URL in a copy box under each, and
// the exact steps behind a "How to connect?" disclosure. The structure is the
// one Lior pointed at (higgsfield.ai/mcp); the look is the canvas system.
//
// THE RULE FOR EVERY SNIPPET AND LINK BELOW: it is a claim, and each one was
// checked against the vendor's own current documentation on 2026-09-25. The
// URL it was checked against sits in a comment beside it. A format that could
// not be checked is not on the page. Where a vendor has no documented
// one-click link, the button opens that vendor's settings page instead and the
// page says so; no deep link here was guessed.
//
//   One-click, documented:  Cursor (cursor://anysphere.cursor-deeplink/mcp/install)
//                           VS Code (vscode:mcp/install)
//   Opens settings:         Claude (claude.ai/customize/connectors)
//                           ChatGPT (chatgpt.com/plugins, developer mode first)
//   Copy a command:         Claude Code, Codex
//   Copy a config:          Antigravity (no install link documented)
//
// Tabs without script: the tab bar is a row of links to the sections below,
// and every section is visible. The script turns the row into a WAI-ARIA tab
// list (arrow keys, Home, End, roving tabindex) and shows one panel at a time.

export const MCP_URL = `${ORIGIN}/mcp`

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Cursor's install link: name, and config as the base64 of the server object
// alone (no mcpServers wrapper). Checked by decoding the example on
// https://cursor.com/docs/context/mcp/install-links. OAuth, so no key in it.
const CURSOR_LINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=agentbill&config=${Buffer.from(JSON.stringify({ url: MCP_URL })).toString('base64')}`

// VS Code's install link: vscode:mcp/install?<encodeURIComponent(JSON)>, the
// JSON carrying name, type and url.
// https://code.visualstudio.com/api/extension-guides/ai/mcp (install links)
const VSCODE_LINK = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'agentbill', type: 'http', url: MCP_URL }))}`

// https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
// links https://claude.ai/customize/connectors. The claude:// scheme has no
// connector route (https://support.claude.com/en/articles/14729294).
const CLAUDE_SETTINGS = 'https://claude.ai/customize/connectors'

// https://developers.openai.com/plugins/deploy/connect-chatgpt: developer mode
// on, then chatgpt.com/plugins, the plus button, a name, and the URL under
// Connection. https://developers.openai.com/api/docs/guides/developer-mode
const CHATGPT_APPS = 'https://chatgpt.com/plugins'

// ---- The commands and configs, each against its source ----

// https://code.claude.com/docs/en/mcp: --transport http, then /mcp to sign in.
const CLAUDE_CODE_CMD = `claude mcp add --transport http agentbill ${MCP_URL}`
// Same page: --header adds a static header. The shell expands the variable
// when the command runs, so Claude Code stores the key itself.
const CLAUDE_CODE_KEY_CMD = `claude mcp add --transport http agentbill ${MCP_URL} --header "Authorization: Bearer $AGENTBILL_API_KEY"`
// Same page: .mcp.json expands \${VAR} in url and headers. AGENTBILL_API_KEY is
// outside the set of provider credential names it blanks.
const CLAUDE_CODE_JSON = `{
  "mcpServers": {
    "agentbill": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer \${AGENTBILL_API_KEY}"
      }
    }
  }
}`

// https://learn.chatgpt.com/docs/extend/mcp?surface=cli (developers.openai.com/
// codex/mcp redirects there): codex mcp add NAME --url URL, then codex mcp
// login NAME for OAuth; in config.toml, bearer_token_env_var names the
// variable that holds the token.
const CODEX_CMD = `codex mcp add agentbill --url ${MCP_URL}`
const CODEX_LOGIN = 'codex mcp login agentbill'
const CODEX_TOML = `[mcp_servers.agentbill]
url = "${MCP_URL}"
bearer_token_env_var = "AGENTBILL_API_KEY"`

// https://cursor.com/docs/mcp: url and headers, \${env:NAME} interpolation in
// both; .cursor/mcp.json in a project or ~/.cursor/mcp.json for every project.
const CURSOR_JSON = `{
  "mcpServers": {
    "agentbill": {
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer \${env:AGENTBILL_API_KEY}"
      }
    }
  }
}`

// https://antigravity.google/docs/mcp/: serverUrl is the field (url and httpUrl
// are not supported); ~/.gemini/config/mcp_config.json, or .agents/mcp_config.json
// in a workspace. OAuth is handled for servers with dynamic client
// registration. Variable interpolation is not documented there, so the key
// variant says where the key goes instead of pretending a variable works.
const ANTIGRAVITY_JSON = `{
  "mcpServers": {
    "agentbill": {
      "serverUrl": "${MCP_URL}"
    }
  }
}`
const ANTIGRAVITY_KEY_JSON = `{
  "mcpServers": {
    "agentbill": {
      "serverUrl": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer agb_your_key_here"
      }
    }
  }
}`

// https://code.visualstudio.com/docs/agents/reference/mcp-configuration:
// servers, type http, headers, and a promptString input marked password.
const VSCODE_JSON = `{
  "inputs": [
    { "type": "promptString", "id": "agentbill-key", "description": "AgentBill API key", "password": true }
  ],
  "servers": {
    "agentbill": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer \${input:agentbill-key}"
      }
    }
  }
}`

// OpenClaw, 2026-09-25. Not MCP: a native OpenClaw plugin, @agentbill/openclaw
// on ClawHub. The command, the listing and the config are byte for byte what
// plugins/openclaw/README.md says and what the listing itself shows
// (https://clawhub.ai/agentbill/plugins/openclaw, read 2026-09-25, v0.2.0).
export const CLAWHUB_URL = 'https://clawhub.ai/agentbill/plugins/openclaw'
export const OPENCLAW_CMD = 'openclaw plugins install clawhub:@agentbill/openclaw'
const OPENCLAW_JSON = `{
  "plugins": {
    "entries": {
      "agentbill": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "apiKey": "agb_...",
          "ceilingUnits": 500000
        }
      }
    }
  }
}`

// The local stdio server's two blocks, byte for byte from mcp/README.md: an
// [integrations] gate in verify.mjs holds this page to that file.
const LOCAL_CMD = 'uvx agentbill-mcp'
const LOCAL_JSON = `{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": {
        "AGENTBILL_API_KEY": "agb_your_key_here"
      }
    }
  }
}`

// ---- Pieces ----

const code = (id: string, text: string, label: string) =>
  `<div class="cv-snip mcp-snip"><div class="cv-snip-h"><span class="cv-label">${label}</span>` +
  `<button type="button" class="cp-btn" data-copy="${id}" aria-label="Copy ${esc(label)}">Copy</button></div>` +
  `<pre class="mcp-pre"><code id="${id}">${esc(text)}</code></pre></div>`

/** The URL under every tab. Each copy box has its own id; all hold the same URL. */
const urlBox = (tab: string) => `<div class="mcp-url"><span class="cv-label">Server URL</span>${copyPill(`url-${tab}`, MCP_URL)}</div>`

const steps = (items: string[]) => `<ol class="mcp-steps">${items.map((s) => `<li>${s}</li>`).join('')}</ol>`

const how = (inner: string) => `<details class="mcp-how"><summary>How to connect?</summary><div class="mcp-how-b">${inner}</div></details>`

interface Tab { id: string; label: string; body: string }

const TABS: Tab[] = [
  {
    id: 'claude',
    label: 'Claude',
    body: `
      <p class="mcp-for">Claude.ai and Claude Desktop, with a custom connector. You sign in to AgentBill and approve it, no key to paste.</p>
      <div class="mcp-act">
        <a class="btn btn-lg" id="connect-claude" href="${CLAUDE_SETTINGS}" rel="noopener" target="_blank">Open Claude connectors</a>
        <button type="button" class="btn-alt" data-copy="url-claude" aria-label="Copy the server URL">Copy URL</button>
      </div>
      ${steps([
        'In Claude, open <b>Customize</b>, then <b>Connectors</b>. Press <b>+</b>, then <b>Add custom connector</b>.',
        'Paste the server URL and press <b>Add</b>.',
        'Connect it, sign in to AgentBill in the window that opens, and press <b>Allow</b>.',
      ])}
      ${urlBox('claude')}
      ${how(`
        <p>Custom connectors are on the Free, Pro, Max, Team and Enterprise plans; Free has one custom connector.
        Claude reaches AgentBill from Anthropic's cloud, not from your computer.</p>
        <p><b>Team and Enterprise:</b> an Owner adds it once under <b>Organization settings</b>, <b>Connectors</b>:
        <b>Add</b>, <b>Custom</b>, <b>Web</b>, then the server URL. Each member then finds it under <b>Customize</b>,
        <b>Connectors</b> and presses <b>Connect</b>.</p>
        <p><b>In a chat:</b> press <b>+</b>, then <b>Connectors</b>, and turn AgentBill on.</p>
        <p>Claude has no link that adds a connector for you, so this button opens the page where you add it.</p>`)}`,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    body: `
      <p class="mcp-for">ChatGPT on the web, as an app. It needs <b>developer mode</b>, on Pro, Plus, Business, Enterprise and Education
      accounts. ChatGPT connects with a sign-in only; it cannot send an API key.</p>
      <div class="mcp-act">
        <a class="btn btn-lg" id="connect-chatgpt" href="${CHATGPT_APPS}" rel="noopener" target="_blank">Open ChatGPT apps</a>
        <button type="button" class="btn-alt" data-copy="url-chatgpt" aria-label="Copy the server URL">Copy URL</button>
      </div>
      ${steps([
        'Turn on developer mode: <b>Settings</b>, <b>Security and login</b>, <b>Developer mode</b>.',
        'Open ChatGPT apps, press <b>+</b>, and give it a name (AgentBill) and a description.',
        'Under <b>Connection</b>, paste the server URL with its <b>/mcp</b> path, choose OAuth, sign in to AgentBill and press <b>Allow</b>.',
      ])}
      ${urlBox('chatgpt')}
      ${how(`
        <p>A new app shows under <b>Drafts</b>.</p>
        <p>ChatGPT has no link that adds an app for you, so this button opens the page where you add it.</p>`)}`,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    body: `
      <p class="mcp-for">One command in your terminal, then a sign-in inside Claude Code.</p>
      <div class="mcp-act">
        <button type="button" class="btn btn-lg" id="connect-claude-code" data-copy="cmd-claude-code" aria-label="Copy the command">Copy command</button>
      </div>
      <div class="mcp-cmd">${copyPill('cmd-claude-code', CLAUDE_CODE_CMD)}</div>
      ${steps([
        'Run the command.',
        'In Claude Code, run <b>/mcp</b>, choose <b>agentbill</b> and sign in to AgentBill in the browser.',
        'Press <b>Allow</b>.',
      ])}
      ${urlBox('claude-code')}
      ${how(`
        <p><b>With an API key instead of a sign-in.</b> Put your key in <span class="mono-in">AGENTBILL_API_KEY</span>. Your shell
        fills it in when the command runs, and Claude Code keeps it in its own config:</p>
        ${code('cc-key', CLAUDE_CODE_KEY_CMD, 'Terminal')}
        <p>Or in a project's <span class="mono-in">.mcp.json</span>, where Claude Code reads the variable each time it starts:</p>
        ${code('cc-json', CLAUDE_CODE_JSON, '.mcp.json')}`)}`,
  },
  {
    id: 'codex',
    label: 'Codex',
    body: `
      <p class="mcp-for">OpenAI Codex, the CLI and the IDE extension. Add the server, then sign in.</p>
      <div class="mcp-act">
        <button type="button" class="btn btn-lg" id="connect-codex" data-copy="cmd-codex" aria-label="Copy the command">Copy command</button>
      </div>
      <div class="mcp-cmd">${copyPill('cmd-codex', CODEX_CMD)}</div>
      ${steps([
        'Run the command.',
        `Run <span class="mono-in">${CODEX_LOGIN}</span> and sign in to AgentBill in the browser.`,
        'Press <b>Allow</b>.',
      ])}
      ${urlBox('codex')}
      ${how(`
        <p><b>With an API key instead of a sign-in.</b> In <span class="mono-in">~/.codex/config.toml</span>, name the variable
        that holds your key, and set <span class="mono-in">AGENTBILL_API_KEY</span> where Codex runs:</p>
        ${code('codex-toml', CODEX_TOML, 'config.toml')}
        <p>In the IDE extension: the gear menu, <b>MCP servers</b>, <b>Add server</b>, then <b>Streamable HTTP</b> and the server URL.</p>`)}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    body: `
      <p class="mcp-for">One click opens Cursor with AgentBill ready to add. Cursor then signs you in to AgentBill.</p>
      <div class="mcp-act">
        <a class="btn btn-lg" id="connect-cursor" href="${esc(CURSOR_LINK)}">Add to Cursor</a>
        <button type="button" class="btn-alt" data-copy="url-cursor" aria-label="Copy the server URL">Copy URL</button>
      </div>
      ${steps([
        'Press <b>Add to Cursor</b> and confirm the install in Cursor.',
        'Sign in to AgentBill when Cursor asks, and press <b>Allow</b>.',
      ])}
      ${urlBox('cursor')}
      ${how(`
        <p><b>With an API key instead of a sign-in.</b> In <span class="mono-in">.cursor/mcp.json</span> for one project, or
        <span class="mono-in">~/.cursor/mcp.json</span> for all of them. Cursor reads <span class="mono-in">AGENTBILL_API_KEY</span>
        from your environment:</p>
        ${code('cursor-json', CURSOR_JSON, 'mcp.json')}`)}`,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    body: `
      <p class="mcp-for">Google Antigravity, through its MCP config file. Antigravity signs you in to AgentBill when it connects.</p>
      <div class="mcp-act">
        <button type="button" class="btn btn-lg" id="connect-antigravity" data-copy="ag-json" aria-label="Copy the config">Copy config</button>
      </div>
      ${code('ag-json', ANTIGRAVITY_JSON, 'mcp_config.json')}
      ${steps([
        'In the agent panel, open the <b>&hellip;</b> menu, then <b>MCP Servers</b>, <b>Manage MCP Servers</b>, <b>View raw config</b>.',
        'Add the <span class="mono-in">agentbill</span> entry above and save.',
        'Sign in to AgentBill when Antigravity asks, and press <b>Allow</b>.',
      ])}
      ${urlBox('antigravity')}
      ${how(`
        <p>The file is <span class="mono-in">~/.gemini/config/mcp_config.json</span>, or <span class="mono-in">.agents/mcp_config.json</span>
        in a workspace. The field is <span class="mono-in">serverUrl</span>; Antigravity does not read <span class="mono-in">url</span> here.</p>
        <p><b>With an API key instead of a sign-in.</b> Antigravity's documentation does not say it reads environment variables in this
        file, so the key goes in it: put yours where <span class="mono-in">agb_your_key_here</span> is, and keep the file out of version control.</p>
        ${code('ag-key-json', ANTIGRAVITY_KEY_JSON, 'mcp_config.json, with a key')}
        <p>Antigravity has no install link, so this button copies the config.</p>`)}`,
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    body: `
      <p class="mcp-for">OpenClaw, with the AgentBill plugin from ClawHub, version ${SDK_VERSIONS.openclaw}. This one is not MCP: it is a
      native OpenClaw plugin that gives each session one ceiling and checks it before every model turn and every tool call. When the
      ceiling is spent, the call is refused and the session says so.</p>
      <div class="mcp-act">
        <a class="btn btn-lg" id="connect-openclaw" href="${CLAWHUB_URL}" rel="noopener" target="_blank">View on ClawHub</a>
        <button type="button" class="btn-alt" data-copy="cmd-openclaw" aria-label="Copy the install command">Copy command</button>
      </div>
      <div class="mcp-cmd">${copyPill('cmd-openclaw', OPENCLAW_CMD)}</div>
      ${steps([
        'Run the install command.',
        'Give it your key: <span class="mono-in">apiKey</span> in the plugin config below, or <span class="mono-in">AGENTBILL_API_KEY</span> in the Gateway environment. Keep <span class="mono-in">hooks.allowConversationAccess</span> on: without it OpenClaw does not gate model turns.',
        'Restart the Gateway. The log line <span class="mono-in">[agentbill] ceiling 500000 tokens per session</span> means it is on.',
      ])}
      ${code('openclaw-json', OPENCLAW_JSON, 'OpenClaw config')}
      ${how(`
        <p>The package is <span class="mono-in">@agentbill/openclaw</span>; its plugin id, the key under
        <span class="mono-in">plugins.entries</span>, is <span class="mono-in">agentbill</span>. The ceiling is per session, 500,000
        tokens by default, and subagents spawned from a session draw on the same ceiling.</p>
        <p>Every option, and what a refusal looks like, is on <a href="/integrations/openclaw">the OpenClaw guide</a>.</p>`)}`,
  },
  {
    id: 'other',
    label: 'Other',
    body: `
      <p class="mcp-for">VS Code with Copilot in one click, and any other client that speaks Streamable HTTP.</p>
      <div class="mcp-act">
        <a class="btn btn-lg" id="connect-vscode" href="${esc(VSCODE_LINK)}">Add to VS Code</a>
        <button type="button" class="btn-alt" data-copy="url-other" aria-label="Copy the server URL">Copy URL</button>
      </div>
      ${steps([
        'VS Code: press <b>Add to VS Code</b>, then start the server and sign in to AgentBill when it asks.',
        'Anything else: give it the server URL. It finds the sign-in on its own, or send your key as <span class="mono-in">Authorization: Bearer</span>.',
      ])}
      ${urlBox('other')}
      ${how(`
        <p><b>VS Code with an API key.</b> In <span class="mono-in">.vscode/mcp.json</span>. VS Code asks for the key once and keeps it
        out of the file:</p>
        ${code('vscode-json', VSCODE_JSON, '.vscode/mcp.json')}
        <p><b>Any client.</b> The endpoint is Streamable HTTP. With no credentials it answers 401 with a
        <span class="mono-in">WWW-Authenticate</span> header that points at its OAuth metadata, which is how a client learns to sign
        you in. A client that takes a static header sends <span class="mono-in">Authorization: Bearer</span> and your key.</p>
        <p><b>On your own machine, over stdio.</b> The Python package runs locally with your key in its environment:</p>
        <div class="code"><pre>${esc(LOCAL_CMD)}</pre></div>
        <div class="code"><pre>${esc(LOCAL_JSON)}</pre></div>
        <p>Put your key where <span class="mono-in">agb_your_key_here</span> is. Its <span class="mono-in">record_event</span> takes
        no task_ref, so a job's reservations are settled from code with the SDK or <span class="mono-in">POST /events</span>; the
        remote server's <span class="mono-in">record_event</span> takes task_ref and reservation_id and settles them itself.</p>`)}`,
  },
]

export const MCP_TAB_IDS = TABS.map((t) => t.id)

export const MCP_CONNECT_CSS = `${COPY_CSS}
  .mcp { margin-top: var(--s6); }
  .mcp-tabs { display: flex; flex-wrap: wrap; gap: var(--s2); padding: 6px; background: var(--surface2);
              border-radius: var(--r-pill); width: max-content; max-width: 100%; }
  .mcp-tab { display: inline-flex; align-items: center; min-height: var(--h-md); padding: 0 var(--s4);
             border-radius: var(--r-pill); color: var(--muted); text-decoration: none; font-size: var(--fs-small);
             font-weight: 500; white-space: nowrap; }
  .mcp-tab:hover { color: var(--text); }
  .mcp-tab[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--edge); }
  .mcp-tab:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  .mcp-panel { margin-top: var(--s6); padding: var(--s6); background: var(--panel-bg); border-radius: var(--r-card);
               display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); min-width: 0; }
  /* The class sets display, which outranks the browser's own [hidden] rule,
     so the script's hidden attribute needs this to take effect. */
  .mcp-panel[hidden] { display: none; }
  .mcp-panel > h2 { margin: 0; font-size: var(--fs-h3); }
  /* With the script, the selected tab names the panel (aria-labelledby), so
     the panel's own heading would say the same word twice. Without it, every
     panel is visible and titled by its heading. */
  .mcp.is-tabs .mcp-panel > h2 { display: none; }
  /* The mark at the top of a panel, 2026-09-25: in the h2 without script, and
     in this decorative row with it, where the h2 is hidden (aria-hidden, since
     the selected tab already names the panel). */
  .mcp-panel > h2 { display: flex; align-items: center; gap: var(--s2); }
  .mcp-ptop { display: none; align-items: center; gap: var(--s2); color: var(--text); font-weight: 500; }
  .mcp.is-tabs .mcp-ptop { display: flex; }
  .mcp-mark { flex: none; width: 18px; height: 18px; }
  .mcp-tab .mcp-mark { margin-inline-end: var(--s2); }
  /* A mark whose own file carries clear space: a bigger box, pulled back by the
     same amount, so the tab keeps its height and the mark reads at the size of
     its neighbours. See OPENAI_BLOSSOM in connect-marks.ts. */
  .mcp-mark[data-mark="roomy"] { width: 30px; height: 30px; margin-block: -6px; margin-inline-start: -6px; }
  .mcp-tab .mcp-mark[data-mark="roomy"] { margin-inline-end: calc(var(--s2) - 6px); }
  .mcp-panel > * { min-width: 0; }
  .mcp-for { color: var(--muted); max-width: 62ch; margin: 0; line-height: 1.55; }
  .mcp-act { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; }
  .mcp-steps { margin: 0; padding-inline-start: 22px; display: grid; gap: var(--s2); color: var(--text); line-height: 1.55; }
  .mcp-steps li::marker { color: var(--dim); font-family: var(--mono); }
  .mcp-url { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s2); }
  .mcp-url .cp, .mcp-cmd .cp { width: max-content; max-width: 100%; }
  /* A flex item will not shrink under its content without this, and the
     command is wider than a 320px phone: it scrolls inside its pill instead. */
  .mcp-url .cp code, .mcp-cmd .cp code { min-width: 0; }
  .mcp-how { border-top: 1px solid var(--border); padding-top: var(--s4); }
  .mcp-how summary { cursor: pointer; font-weight: 500; color: var(--text); list-style: none; display: inline-flex;
                     align-items: center; gap: var(--s2); min-height: var(--h-md); }
  .mcp-how summary::-webkit-details-marker { display: none; }
  .mcp-how summary::before { content: "+"; font-family: var(--mono); color: var(--dim); }
  .mcp-how[open] summary::before { content: "\\2212"; }
  .mcp-how summary:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; border-radius: var(--r-row); }
  .mcp-how-b { display: grid; gap: var(--s3); margin-top: var(--s3); color: var(--muted); line-height: 1.6; }
  .mcp-how-b p { margin: 0; max-width: 66ch; }
  .mcp-how-b b { color: var(--text); font-weight: 500; }
  .mcp-snip { min-width: 0; }
  .mcp-snip .cv-snip-h { padding-inline: var(--s4); }
  .mcp-pre { margin: 0; padding: var(--s4); overflow-x: auto; font-family: var(--mono); font-size: var(--fs-micro);
             line-height: 1.6; color: var(--code-ink); }
  .mcp-tools td:first-child { white-space: nowrap; }
  @media (max-width: 640px) {
    /* Eight tabs with a mark each do not fit two tidy rows on a phone, so the
       row scrolls sideways inside itself; the page never does. */
    .mcp-tabs { border-radius: var(--r-inner); width: 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    .mcp-tabs::-webkit-scrollbar { display: none; }
    .mcp-tab { flex: none; }
    .mcp-tab { padding: 0 var(--s3); }
    .mcp-panel { padding: var(--s4); }
    .mcp-url .cp, .mcp-cmd .cp { width: 100%; }
    .mcp-act .btn, .mcp-act .btn-alt { width: 100%; white-space: normal; text-align: center; }
  }
`

const TABS_SRC = `
(function () {
  var root = document.querySelector('.mcp[data-tabs]');
  if (!root) return;
  var tabs = [].slice.call(root.querySelectorAll('.mcp-tab'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('href').slice(1)); });
  if (!tabs.length || panels.some(function (p) { return !p; })) return;
  var list = root.querySelector('.mcp-tabs');
  list.setAttribute('role', 'tablist');
  root.classList.add('is-tabs');
  tabs.forEach(function (t, i) {
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-controls', panels[i].id);
    panels[i].setAttribute('role', 'tabpanel');
    panels[i].setAttribute('aria-labelledby', t.id);
    panels[i].setAttribute('tabindex', '0');
  });
  function select(i, focus) {
    tabs.forEach(function (t, j) {
      var on = i === j;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
      panels[j].hidden = !on;
    });
    if (focus) tabs[i].focus();
  }
  function fromHash() {
    var id = location.hash.slice(1);
    for (var i = 0; i < panels.length; i++) if (panels[i].id === id) return i;
    return 0;
  }
  select(fromHash(), false);
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function (e) {
      e.preventDefault();
      select(i, false);
      if (history.replaceState) history.replaceState(null, '', '#' + panels[i].id);
    });
    t.addEventListener('keydown', function (e) {
      var n = tabs.length, to = -1;
      if (e.key === 'ArrowRight') to = (i + 1) % n;
      else if (e.key === 'ArrowLeft') to = (i - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to < 0) return;
      e.preventDefault();
      select(to, true);
      if (history.replaceState) history.replaceState(null, '', '#' + panels[to].id);
    });
  });
  window.addEventListener('hashchange', function () { select(fromHash(), false); });
})();
`
const tabsScript = inlineScript(TABS_SRC)
export const MCP_SCRIPTS = [tabsScript, { html: COPY_JS, hash: COPY_HASH }]

export function mcpConnectBody(): string {
  return `
  <h1>Connect AgentBill to your AI tools</h1>
  <p class="lede">One URL. Your assistant reads what each job used and what it cost at list price, asks a job's ceiling
  before a call, and records what a call used. Pick where you work. OpenClaw has a plugin of its own instead.</p>

  <div class="mcp" data-tabs>
    <nav class="mcp-tabs" aria-label="Where you work">
${TABS.map((t) => `      <a class="mcp-tab" id="tab-${t.id}" href="#${t.id}">${CONNECT_MARKS[t.id].svg}<span>${t.label}</span></a>`).join('\n')}
    </nav>
${TABS.map((t) => `    <section class="mcp-panel" id="${t.id}">
      <div class="mcp-ptop" aria-hidden="true">${CONNECT_MARKS[t.id].svg}<span>${t.label}</span></div>
      <h2 id="${t.id}-h">${CONNECT_MARKS[t.id].svg}<span>${t.label}</span></h2>${t.body}
    </section>`).join('\n')}
  </div>

  <h2>What your agent can do</h2>
  <table class="mcp-tools">
    <thead><tr><th>Tool</th><th>What it does</th><th>Scope</th></tr></thead>
    <tbody>
      <tr><td>preflight</td><td>Asks before a call whether the job and the customer have room left. <span class="inline">approved: false</span> comes back as the answer, with the reason and a sentence the model can act on. An approved call reserves its estimate against the job.</td><td>meter</td></tr>
      <tr><td>record_event</td><td>Records what a call used. With the model and the token counts in its metadata, AgentBill prices it at list price. With the job's task_ref and the reservation_id preflight returned, it settles that reservation.</td><td>meter</td></tr>
      <tr><td>task_status</td><td>One job: its ceiling, what it used and what is reserved, and its calls by model and by step.</td><td>read</td></tr>
      <tr><td>top_jobs</td><td>Your jobs ranked by an estimate in dollars at public list price, or by what they used in their own unit.</td><td>read</td></tr>
      <tr><td>recent_refusals</td><td>The calls refused on your account, the newest at the top, with the body each agent received.</td><td>read</td></tr>
    </tbody>
  </table>
  <p>Dollar figures are estimates at public list price, labelled as estimates, for calls recorded with a model named. They are
  not your invoice. The assistant does not meter the tokens of your chat with it: a call is recorded only when a tool records it.</p>

  <h2>How it signs in</h2>
  <p><b>With a sign-in (OAuth).</b> The app sends you to AgentBill, you sign in with Google, GitHub or an email link, and a page
  shows the app's name, where your browser goes next, and what it will be able to do. You press Allow or Deny. You can
  disconnect it any time in the console, under API keys. An account made with only an API key connects Google or GitHub there
  before it can approve an app.</p>
  <p><b>With an API key.</b> Clients that take a header send <span class="inline">Authorization: Bearer</span> and your key. The
  key's limits apply, and revoking the key disconnects the client.</p>
  <p>No tool can create, show or revoke an API key, change your plan or billing, or change the ceiling of a job that exists.</p>

  <h2>The host decides</h2>
  <p>The model decides whether to call preflight and what to do with <span class="inline">approved: false</span>. The server
  never sees the host's own model requests, so it does not limit what the host itself spends. Tell the agent in its instructions
  to call preflight before expensive work, and what to do when the answer is no. When the calls are in code you own, the
  <a href="/docs">SDK</a> puts preflight next to the model call instead.</p>
`
}
