const logger = require('../utils/logger')

function resolveClientName() {
  const raw = (process.env.SUB_DB_CLIENT || process.env.DB_CLIENT || 'mysql').trim().toLowerCase()

  if (raw === 'mysql') return 'mysql'
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres'

  throw new Error(`Unsupported subscription database client: ${raw}`)
}

const clientName = resolveClientName()
const store = clientName === 'postgres'
  ? require('./subscriptionPostgres')
  : require('./subscriptionMysql')

store.clientName = clientName
logger.info(`Subscription database client: ${clientName}`)

module.exports = store
