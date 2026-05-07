#!/usr/bin/env node

const path = require('path')
const dotenv = require('dotenv')
const mysql = require('mysql2/promise')
const { Pool } = require('pg')

dotenv.config({ path: path.resolve(__dirname, '../../..', '.env') })
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const postgresStore = require('../src/models/subscriptionPostgres')

function mysqlConfig() {
  return {
    host: process.env.SUB_MYSQL_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.SUB_MYSQL_PORT || process.env.MYSQL_PORT, 10) || 3306,
    user: process.env.SUB_MYSQL_USER || process.env.MYSQL_USER || 'subscription',
    password: process.env.SUB_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.SUB_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'subscription'
  }
}

function postgresConfig() {
  const connectionString = process.env.SUB_POSTGRES_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || ''
  const sslEnabled = (process.env.SUB_POSTGRES_SSL || process.env.POSTGRES_SSL || '').toLowerCase() === 'true'

  if (connectionString) {
    return {
      connectionString,
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
    }
  }

  return {
    host: process.env.SUB_POSTGRES_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.SUB_POSTGRES_PORT || process.env.POSTGRES_PORT, 10) || 5432,
    user: process.env.SUB_POSTGRES_USER || process.env.POSTGRES_USER || 'subscription',
    password: process.env.SUB_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || '',
    database: process.env.SUB_POSTGRES_DATABASE || process.env.POSTGRES_DATABASE || 'subscription',
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
  }
}

function normalizeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return JSON.stringify(fallback)
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return JSON.stringify(fallback)
    }
  }
  return JSON.stringify(value)
}

function normalizeDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeDateOnly(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

async function getColumns(mysqlConn, table) {
  const [rows] = await mysqlConn.execute(`SHOW COLUMNS FROM ${table}`)
  return new Set(rows.map(row => row.Field))
}

async function selectRows(mysqlConn, table, columns, defaults = {}) {
  const selectList = Object.entries(defaults).map(([column, fallback]) => {
    if (columns.has(column)) return `\`${column}\``
    return `${fallback} AS \`${column}\``
  })

  const [rows] = await mysqlConn.query(`SELECT ${selectList.join(', ')} FROM ${table}`)
  return rows
}

async function migrateUsers(mysqlConn, pgPool) {
  const columns = await getColumns(mysqlConn, 'sub_users')
  const rows = await selectRows(mysqlConn, 'sub_users', columns, {
    id: 'NULL',
    username: 'NULL',
    password_hash: 'NULL',
    name: 'NULL',
    role: "'user'",
    parent_id: 'NULL',
    subscription_token: 'NULL',
    expires_at: 'NULL',
    is_active: 'TRUE',
    last_login_at: 'NULL',
    created_at: 'CURRENT_TIMESTAMP',
    updated_at: 'CURRENT_TIMESTAMP',
    traffic_limit: '536870912000',
    traffic_used: '0',
    traffic_reset_at: 'NULL',
    token_mode: "'strict'"
  })

  for (const row of rows) {
    await pgPool.query(`
      INSERT INTO sub_users (
        id, username, password_hash, name, role, parent_id, subscription_token,
        expires_at, is_active, last_login_at, created_at, updated_at,
        traffic_limit, traffic_used, traffic_reset_at, token_mode
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        parent_id = EXCLUDED.parent_id,
        subscription_token = EXCLUDED.subscription_token,
        expires_at = EXCLUDED.expires_at,
        is_active = EXCLUDED.is_active,
        last_login_at = EXCLUDED.last_login_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        traffic_limit = EXCLUDED.traffic_limit,
        traffic_used = EXCLUDED.traffic_used,
        traffic_reset_at = EXCLUDED.traffic_reset_at,
        token_mode = EXCLUDED.token_mode
    `, [
      row.id,
      row.username,
      row.password_hash,
      row.name,
      row.role || 'user',
      row.parent_id || null,
      row.subscription_token || null,
      normalizeDate(row.expires_at),
      row.is_active !== false && row.is_active !== 0,
      normalizeDate(row.last_login_at),
      normalizeDate(row.created_at) || new Date(),
      normalizeDate(row.updated_at) || new Date(),
      row.traffic_limit ?? 536870912000,
      row.traffic_used ?? 0,
      normalizeDate(row.traffic_reset_at),
      row.token_mode || 'strict'
    ])
  }

  return rows.length
}

async function migrateTokens(mysqlConn, pgPool) {
  const columns = await getColumns(mysqlConn, 'sub_tokens')
  const rows = await selectRows(mysqlConn, 'sub_tokens', columns, {
    id: 'NULL',
    token: 'NULL',
    name: 'NULL',
    status: "'active'",
    expires_at: 'NULL',
    max_access: '0',
    access_count: '0',
    one_time_use: 'FALSE',
    is_consumed: 'FALSE',
    allowed_ips: 'NULL',
    enabled_nodes: 'NULL',
    created_by: 'NULL',
    user_id: 'NULL',
    vless_uuid: 'NULL',
    last_access_at: 'NULL',
    last_access_ip: 'NULL',
    last_user_agent: 'NULL',
    created_at: 'CURRENT_TIMESTAMP',
    updated_at: 'CURRENT_TIMESTAMP'
  })

  for (const row of rows) {
    await pgPool.query(`
      INSERT INTO sub_tokens (
        id, token, name, status, expires_at, max_access, access_count,
        one_time_use, is_consumed, allowed_ips, enabled_nodes, created_by,
        user_id, vless_uuid, last_access_at, last_access_ip, last_user_agent,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        token = EXCLUDED.token,
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        max_access = EXCLUDED.max_access,
        access_count = EXCLUDED.access_count,
        one_time_use = EXCLUDED.one_time_use,
        is_consumed = EXCLUDED.is_consumed,
        allowed_ips = EXCLUDED.allowed_ips,
        enabled_nodes = EXCLUDED.enabled_nodes,
        created_by = EXCLUDED.created_by,
        user_id = EXCLUDED.user_id,
        vless_uuid = EXCLUDED.vless_uuid,
        last_access_at = EXCLUDED.last_access_at,
        last_access_ip = EXCLUDED.last_access_ip,
        last_user_agent = EXCLUDED.last_user_agent,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, [
      row.id,
      row.token,
      row.name,
      row.status || 'active',
      normalizeDate(row.expires_at),
      row.max_access ?? 0,
      row.access_count ?? 0,
      row.one_time_use === true || row.one_time_use === 1,
      row.is_consumed === true || row.is_consumed === 1,
      normalizeJson(row.allowed_ips, []),
      normalizeJson(row.enabled_nodes, []),
      row.created_by || 'admin',
      row.user_id || null,
      row.vless_uuid || null,
      normalizeDate(row.last_access_at),
      row.last_access_ip || null,
      row.last_user_agent || null,
      normalizeDate(row.created_at) || new Date(),
      normalizeDate(row.updated_at) || new Date()
    ])
  }

  return rows.length
}

async function migrateStats(mysqlConn, pgPool) {
  const columns = await getColumns(mysqlConn, 'sub_user_stats')
  const rows = await selectRows(mysqlConn, 'sub_user_stats', columns, {
    id: 'NULL',
    user_id: 'NULL',
    date: 'CURRENT_DATE',
    access_count: '0',
    download_bytes: '0',
    upload_bytes: '0',
    created_at: 'CURRENT_TIMESTAMP',
    updated_at: 'CURRENT_TIMESTAMP'
  })

  for (const row of rows) {
    const values = [
      row.user_id,
      normalizeDateOnly(row.date),
      row.access_count ?? 0,
      row.download_bytes ?? 0,
      row.upload_bytes ?? 0,
      normalizeDate(row.created_at) || new Date(),
      normalizeDate(row.updated_at) || new Date()
    ]

    if (row.id === null || row.id === undefined) {
      await pgPool.query(`
        INSERT INTO sub_user_stats (
          user_id, date, access_count, download_bytes, upload_bytes, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, date) DO UPDATE SET
          access_count = EXCLUDED.access_count,
          download_bytes = EXCLUDED.download_bytes,
          upload_bytes = EXCLUDED.upload_bytes,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `, values)
    } else {
      await pgPool.query(`
        INSERT INTO sub_user_stats (
          id, user_id, date, access_count, download_bytes, upload_bytes, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id, date) DO UPDATE SET
          access_count = EXCLUDED.access_count,
          download_bytes = EXCLUDED.download_bytes,
          upload_bytes = EXCLUDED.upload_bytes,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `, [row.id, ...values])
    }
  }

  await pgPool.query(`
    SELECT setval(
      pg_get_serial_sequence('sub_user_stats', 'id'),
      COALESCE((SELECT MAX(id) FROM sub_user_stats), 1),
      true
    )
  `)

  return rows.length
}

async function main() {
  console.log('Initializing PostgreSQL schema...')
  await postgresStore.connect()
  await postgresStore.disconnect()

  const mysqlConn = await mysql.createConnection(mysqlConfig())
  const pgPool = new Pool(postgresConfig())

  try {
    await pgPool.query('BEGIN')

    const users = await migrateUsers(mysqlConn, pgPool)
    const tokens = await migrateTokens(mysqlConn, pgPool)
    const stats = await migrateStats(mysqlConn, pgPool)

    await pgPool.query('COMMIT')

    console.log(`Migration completed: ${users} users, ${tokens} tokens, ${stats} stats rows`)
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  } finally {
    await mysqlConn.end()
    await pgPool.end()
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
}

module.exports = {
  migrateUsers,
  migrateTokens,
  migrateStats
}
