import 'dotenv/config'
import { buildServer } from './server.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const PORT = config.PORT

const app = buildServer({
  oauth: {
    app: {
      appId: config.JUMPSELLER_APP_ID,
      appSecret: config.JUMPSELLER_APP_SECRET,
      redirectUri: `${config.APP_URL}/oauth/callback`,
      scopes: config.JUMPSELLER_SCOPES,
    },
    encryptionKey: config.TOKEN_ENCRYPTION_KEY,
    appUrl: config.APP_URL,
  },
})

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => console.log(`connector listening at ${address}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
