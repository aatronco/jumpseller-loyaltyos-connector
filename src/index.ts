import { buildServer } from './server.js'

const PORT = Number(process.env.PORT ?? 3001)

const app = buildServer()
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => console.log(`connector listening at ${address}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
