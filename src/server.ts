import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { eventsRoute } from './routes/events.js'
import { budgetRoute } from './routes/budget.js'
import { dashboardRoute } from './routes/dashboard.js'
import { registerRoute } from './routes/register.js'
import { homeRoute } from './routes/home.js'
import { registerAuth } from './middleware/auth.js'

const app = Fastify({ logger: true })

app.register(sensible)
app.register(homeRoute)
registerAuth(app)

// Health check - useful for deploy verification
app.get('/health', async () => ({ status: 'ok' }))

app.register(eventsRoute)
app.register(budgetRoute)
app.register(dashboardRoute)
app.register(registerRoute)

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
