/**
 * OpenClaw entry. Everything the plugin does lives in ceiling.ts; this file
 * only hands it the api. Kept apart so `npm test` never has to load the
 * plugin SDK, which is a Gateway-sized dependency.
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { registerCeiling } from './ceiling.js'

export { registerCeiling, resolveConfig, Ceiling } from './ceiling.js'
export type { PluginConfig, Units, FailMode, CustomerFrom } from './ceiling.js'

export default definePluginEntry({
  id: 'agentbill',
  name: 'AgentBill',
  description: 'One spend ceiling per session, consulted before every model turn and tool call.',
  register(api) {
    registerCeiling(api)
  },
})
