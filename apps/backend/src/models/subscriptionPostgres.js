/**
 * Subscription PostgreSQL model.
 * Keeps the same public API as subscriptionMysql so services can switch stores
 * through SUB_DB_CLIENT without changing business logic.
 */

const { Pool } = require('pg')
const logger = require('../utils/logger')

const connectionString = process.env.SUB_POSTGRES_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || ''
const sslEnabled = (process.env.SUB_POSTGRES_SSL || process.env.POSTGRES_SSL || '').toLowerCase() === 'true'

const DEFAULT_CONFIG = connectionString
  ? {
      connectionString,
      max: parseInt(process.env.SUB_POSTGRES_CONNECTION_LIMIT || process.env.POSTGRES_CONNECTION_LIMIT, 10) || 5,
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
    }
  : {
      host: process.env.SUB_POSTGRES_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.SUB_POSTGRES_PORT || process.env.POSTGRES_PORT, 10) || 5432,
      user: process.env.SUB_POSTGRES_USER || process.env.POSTGRES_USER || 'subscription',
      password: process.env.SUB_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || '',
      database: process.env.SUB_POSTGRES_DATABASE || process.env.POSTGRES_DATABASE || 'subscription',
      max: parseInt(process.env.SUB_POSTGRES_CONNECTION_LIMIT || process.env.POSTGRES_CONNECTION_LIMIT, 10) || 5,
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
    }

class SubscriptionPostgresClient {
  constructor() {
    this.pool = null
    this.isConnected = false
  }

  async connect() {
    if (this.isConnected) return this.pool

    try {
      this.pool = new Pool(DEFAULT_CONFIG)
      await this.pool.query('SELECT 1')

      this.isConnected = true
      logger.info('Subscription PostgreSQL connected successfully')

      await this.initTables()
      return this.pool
    } catch (error) {
      logger.error('Failed to connect to Subscription PostgreSQL:', error)
      throw error
    }
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
      this.isConnected = false
      logger.info('Subscription PostgreSQL disconnected')
    }
  }

  getPool() {
    return this.pool
  }

  async initTables() {
    if (!this.pool) return

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sub_users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user',
        parent_id VARCHAR(64) DEFAULT NULL,
        subscription_token VARCHAR(255),
        expires_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT TRUE,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        traffic_limit BIGINT DEFAULT 536870912000,
        traffic_used BIGINT DEFAULT 0,
        traffic_reset_at TIMESTAMPTZ DEFAULT NULL,
        token_mode VARCHAR(20) DEFAULT 'strict'
      )
    `)

    await this._addColumnIfNotExists('sub_users', 'role', "VARCHAR(20) DEFAULT 'user'")
    await this._addColumnIfNotExists('sub_users', 'parent_id', 'VARCHAR(64) DEFAULT NULL')
    await this._addColumnIfNotExists('sub_users', 'traffic_limit', 'BIGINT DEFAULT 536870912000')
    await this._addColumnIfNotExists('sub_users', 'traffic_used', 'BIGINT DEFAULT 0')
    await this._addColumnIfNotExists('sub_users', 'traffic_reset_at', 'TIMESTAMPTZ DEFAULT NULL')
    await this._addColumnIfNotExists('sub_users', 'token_mode', "VARCHAR(20) DEFAULT 'strict'")

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sub_tokens (
        id VARCHAR(64) PRIMARY KEY,
        token VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        expires_at TIMESTAMPTZ,
        max_access INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        one_time_use BOOLEAN DEFAULT FALSE,
        is_consumed BOOLEAN DEFAULT FALSE,
        allowed_ips JSONB,
        enabled_nodes JSONB,
        created_by VARCHAR(255),
        user_id VARCHAR(64) DEFAULT NULL,
        vless_uuid VARCHAR(36) DEFAULT NULL,
        last_access_at TIMESTAMPTZ,
        last_access_ip VARCHAR(100),
        last_user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await this._addColumnIfNotExists('sub_tokens', 'one_time_use', 'BOOLEAN DEFAULT FALSE')
    await this._addColumnIfNotExists('sub_tokens', 'is_consumed', 'BOOLEAN DEFAULT FALSE')
    await this._addColumnIfNotExists('sub_tokens', 'user_id', 'VARCHAR(64) DEFAULT NULL')
    await this._addColumnIfNotExists('sub_tokens', 'vless_uuid', 'VARCHAR(36) DEFAULT NULL')

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sub_user_stats (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        access_count INTEGER DEFAULT 0,
        download_bytes BIGINT DEFAULT 0,
        upload_bytes BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_sub_user_stats_user_date UNIQUE (user_id, date)
      )
    `)

    await this._createIndexes()
    await this._createUpdatedAtTriggers()

    logger.info('Subscription PostgreSQL tables initialized')
  }

  async _createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_sub_users_username ON sub_users (username)',
      'CREATE INDEX IF NOT EXISTS idx_sub_users_is_active ON sub_users (is_active)',
      'CREATE INDEX IF NOT EXISTS idx_sub_users_subscription_token ON sub_users (subscription_token)',
      'CREATE INDEX IF NOT EXISTS idx_sub_users_role ON sub_users (role)',
      'CREATE INDEX IF NOT EXISTS idx_sub_users_parent_id ON sub_users (parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_sub_tokens_token ON sub_tokens (token)',
      'CREATE INDEX IF NOT EXISTS idx_sub_tokens_status ON sub_tokens (status)',
      'CREATE INDEX IF NOT EXISTS idx_sub_tokens_expires_at ON sub_tokens (expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_sub_tokens_user_id ON sub_tokens (user_id)',
      'CREATE INDEX IF NOT EXISTS idx_sub_tokens_one_time_use ON sub_tokens (one_time_use)',
      'CREATE INDEX IF NOT EXISTS idx_sub_user_stats_user_id ON sub_user_stats (user_id)',
      'CREATE INDEX IF NOT EXISTS idx_sub_user_stats_date ON sub_user_stats (date)'
    ]

    for (const sql of indexes) {
      await this.pool.query(sql)
    }
  }

  async _createUpdatedAtTriggers() {
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION subscription_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)

    for (const table of ['sub_users', 'sub_tokens', 'sub_user_stats']) {
      const triggerName = `${table}_set_updated_at`
      await this.pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = '${triggerName}'
          ) THEN
            CREATE TRIGGER ${triggerName}
            BEFORE UPDATE ON ${table}
            FOR EACH ROW
            EXECUTE FUNCTION subscription_set_updated_at();
          END IF;
        END $$;
      `)
    }
  }

  async createUser(userData) {
    const {
      id,
      username,
      passwordHash,
      name,
      role,
      parentId,
      subscriptionToken,
      expiresAt,
      isActive,
      trafficLimit = 536870912000,
      trafficUsed = 0
    } = userData

    await this.pool.query(`
      INSERT INTO sub_users (
        id, username, password_hash, name, role, parent_id, subscription_token,
        expires_at, is_active, traffic_limit, traffic_used, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
    `, [
      id,
      username,
      passwordHash,
      name || username,
      role || 'user',
      parentId || null,
      subscriptionToken || null,
      expiresAt || null,
      isActive !== false,
      trafficLimit,
      trafficUsed
    ])

    return { id, username, name, role, trafficLimit, trafficUsed }
  }

  async getUserById(userId) {
    const { rows } = await this.pool.query('SELECT * FROM sub_users WHERE id = $1', [userId])
    return rows[0] ? this._formatUser(rows[0]) : null
  }

  async getUserBySubscriptionToken(token) {
    const { rows } = await this.pool.query('SELECT * FROM sub_users WHERE subscription_token = $1', [token])
    return rows[0] ? this._formatUser(rows[0]) : null
  }

  async getUserByUsername(username) {
    const { rows } = await this.pool.query('SELECT * FROM sub_users WHERE username = $1', [username])
    return rows[0] ? this._formatUser(rows[0]) : null
  }

  async updateUser(userId, updates) {
    const allowedFields = ['name', 'role', 'parent_id', 'subscription_token', 'expires_at', 'is_active', 'last_login_at', 'password_hash', 'traffic_limit', 'traffic_used', 'traffic_reset_at', 'token_mode']
    const setClauses = []
    const values = []

    for (const [key, value] of Object.entries(updates)) {
      const snakeKey = this._camelToSnake(key)
      if (allowedFields.includes(snakeKey)) {
        values.push(value)
        setClauses.push(`${snakeKey} = $${values.length}`)
      }
    }

    if (setClauses.length === 0) return

    values.push(userId)
    await this.pool.query(
      `UPDATE sub_users SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
      values
    )
  }

  async getSubUsers(parentId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM sub_users WHERE parent_id = $1 ORDER BY created_at DESC',
      [parentId]
    )
    return rows.map(row => this._formatUser(row))
  }

  async deleteUser(userId) {
    await this.pool.query('DELETE FROM sub_users WHERE id = $1', [userId])
  }

  async listUsers() {
    const { rows } = await this.pool.query('SELECT * FROM sub_users ORDER BY created_at DESC')
    return rows.map(row => this._formatUser(row))
  }

  async createToken(tokenData) {
    const {
      id,
      token,
      name,
      expiresAt,
      maxAccess,
      oneTimeUse,
      userId,
      allowedIPs,
      enabledNodes,
      createdBy,
      vlessUuid
    } = tokenData

    await this.pool.query(`
      INSERT INTO sub_tokens (
        id, token, name, expires_at, max_access, one_time_use, user_id,
        allowed_ips, enabled_nodes, created_by, vless_uuid, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, CURRENT_TIMESTAMP)
    `, [
      id,
      token,
      name,
      expiresAt,
      maxAccess || 0,
      oneTimeUse || false,
      userId || null,
      JSON.stringify(allowedIPs || []),
      JSON.stringify(enabledNodes || []),
      createdBy || 'admin',
      vlessUuid || null
    ])

    return { id, token, name, oneTimeUse, vlessUuid }
  }

  async getTokenByUserId(userId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM sub_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    )
    return rows[0] ? this._formatToken(rows[0]) : null
  }

  async markTokenConsumed(token) {
    await this.pool.query('UPDATE sub_tokens SET is_consumed = TRUE WHERE token = $1', [token])
  }

  async invalidateUserTokens(userId) {
    await this.pool.query(
      "UPDATE sub_tokens SET status = 'revoked' WHERE user_id = $1 AND status = 'active'",
      [userId]
    )
  }

  async regenerateToken(oldToken, newToken, strictMode = true, vlessUuid = null) {
    const oldTokenData = await this.getToken(oldToken)
    if (!oldTokenData) return false

    if (strictMode) {
      if (oldTokenData.userId) {
        await this.invalidateUserTokens(oldTokenData.userId)
      } else {
        await this.pool.query("UPDATE sub_tokens SET status = 'revoked' WHERE token = $1", [oldToken])
      }
    }

    const newTokenId = newToken.substring(0, 8)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const defaultAdminUserId = '2165a7372f9f56e0'
    const userId = oldTokenData.userId || defaultAdminUserId

    await this.pool.query(`
      INSERT INTO sub_tokens (
        id, token, name, status, expires_at, max_access, one_time_use, user_id,
        allowed_ips, enabled_nodes, created_by, vless_uuid, created_at
      )
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, CURRENT_TIMESTAMP)
    `, [
      newTokenId,
      newToken,
      oldTokenData.name || '订阅链接',
      expiresAt,
      oldTokenData.maxAccess || 0,
      oldTokenData.oneTimeUse || false,
      userId,
      JSON.stringify(oldTokenData.allowedIPs || []),
      JSON.stringify(oldTokenData.enabledNodes || []),
      oldTokenData.createdBy || 'admin',
      vlessUuid || null
    ])

    return true
  }

  async getTokensByUserId(userId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM sub_tokens WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC",
      [userId]
    )
    return rows.map(row => this._formatToken(row))
  }

  async getToken(token) {
    const { rows } = await this.pool.query('SELECT * FROM sub_tokens WHERE token = $1', [token])
    return rows[0] ? this._formatToken(rows[0]) : null
  }

  async getTokenById(id) {
    const { rows } = await this.pool.query('SELECT * FROM sub_tokens WHERE id = $1', [id])
    return rows[0] ? this._formatToken(rows[0]) : null
  }

  async updateToken(token, updates) {
    const allowedFields = ['name', 'status', 'expires_at', 'max_access', 'access_count', 'allowed_ips', 'enabled_nodes', 'last_access_at', 'last_access_ip', 'last_user_agent']
    const setClauses = []
    const values = []

    for (const [key, value] of Object.entries(updates)) {
      const snakeKey = this._camelToSnake(key)
      if (allowedFields.includes(snakeKey)) {
        values.push(snakeKey === 'allowed_ips' || snakeKey === 'enabled_nodes' ? JSON.stringify(value) : value)
        const cast = snakeKey === 'allowed_ips' || snakeKey === 'enabled_nodes' ? '::jsonb' : ''
        setClauses.push(`${snakeKey} = $${values.length}${cast}`)
      }
    }

    if (setClauses.length === 0) return

    values.push(token)
    await this.pool.query(
      `UPDATE sub_tokens SET ${setClauses.join(', ')} WHERE token = $${values.length}`,
      values
    )
  }

  async incrementTokenAccess(token, clientIP, userAgent) {
    await this.pool.query(`
      UPDATE sub_tokens
      SET access_count = access_count + 1,
          last_access_at = CURRENT_TIMESTAMP,
          last_access_ip = $1,
          last_user_agent = $2
      WHERE token = $3
    `, [clientIP, userAgent, token])
  }

  async deleteToken(token) {
    const result = await this.pool.query('DELETE FROM sub_tokens WHERE token = $1', [token])
    return result.rowCount > 0
  }

  async listTokens() {
    const { rows } = await this.pool.query('SELECT * FROM sub_tokens ORDER BY created_at DESC')
    return rows.map(row => this._formatToken(row))
  }

  async backfillVlessUuids() {
    const crypto = require('crypto')
    const { rows } = await this.pool.query(
      "SELECT id FROM sub_tokens WHERE status = 'active' AND vless_uuid IS NULL"
    )
    for (const row of rows) {
      const uuid = crypto.randomUUID()
      await this.pool.query('UPDATE sub_tokens SET vless_uuid = $1 WHERE id = $2', [uuid, row.id])
    }
    return rows.length
  }

  async getActiveTokensWithUuid() {
    const { rows } = await this.pool.query(
      "SELECT * FROM sub_tokens WHERE status = 'active' AND vless_uuid IS NOT NULL"
    )
    return rows.map(row => this._formatToken(row))
  }

  async getTokensByUserIdAndStatus(userId, status) {
    const { rows } = await this.pool.query(
      'SELECT * FROM sub_tokens WHERE user_id = $1 AND status = $2',
      [userId, status]
    )
    return rows.map(row => this._formatToken(row))
  }

  async updateTrafficUsed(userId, bytesUsed) {
    await this.pool.query('UPDATE sub_users SET traffic_used = traffic_used + $1 WHERE id = $2', [bytesUsed, userId])
  }

  async resetTraffic(userId) {
    await this.pool.query('UPDATE sub_users SET traffic_used = 0, traffic_reset_at = CURRENT_TIMESTAMP WHERE id = $1', [userId])
  }

  async getSubUserCount(parentId) {
    const { rows } = await this.pool.query('SELECT COUNT(*) as count FROM sub_users WHERE parent_id = $1', [parentId])
    return parseInt(rows[0]?.count, 10) || 0
  }

  async getSubUsersTotalTraffic(parentId) {
    const { rows } = await this.pool.query(
      'SELECT SUM(traffic_used) as total_used, SUM(traffic_limit) as total_limit FROM sub_users WHERE parent_id = $1',
      [parentId]
    )
    return {
      totalUsed: parseInt(rows[0]?.total_used, 10) || 0,
      totalLimit: parseInt(rows[0]?.total_limit, 10) || 0
    }
  }

  async recordUserStats(userId, stats = {}) {
    const { downloadBytes = 0, uploadBytes = 0 } = stats
    const today = new Date().toISOString().split('T')[0]

    await this.pool.query(`
      INSERT INTO sub_user_stats (user_id, date, access_count, download_bytes, upload_bytes)
      VALUES ($1, $2, 1, $3, $4)
      ON CONFLICT (user_id, date) DO UPDATE SET
        access_count = sub_user_stats.access_count + 1,
        download_bytes = sub_user_stats.download_bytes + EXCLUDED.download_bytes,
        upload_bytes = sub_user_stats.upload_bytes + EXCLUDED.upload_bytes
    `, [userId, today, downloadBytes, uploadBytes])
  }

  async getUserStats(userId) {
    const today = new Date().toISOString().split('T')[0]

    const totalRows = await this.pool.query(`
      SELECT
        SUM(access_count) as access_count,
        SUM(download_bytes) as download_bytes,
        SUM(upload_bytes) as upload_bytes,
        MAX(updated_at) as last_access_at
      FROM sub_user_stats WHERE user_id = $1
    `, [userId])

    const todayRows = await this.pool.query(`
      SELECT access_count, download_bytes, upload_bytes
      FROM sub_user_stats WHERE user_id = $1 AND date = $2
    `, [userId, today])

    const total = totalRows.rows[0] || {}
    const todayData = todayRows.rows[0] || {}

    return {
      total: {
        accessCount: parseInt(total.access_count, 10) || 0,
        downloadBytes: parseInt(total.download_bytes, 10) || 0,
        uploadBytes: parseInt(total.upload_bytes, 10) || 0,
        lastAccessAt: total.last_access_at || null
      },
      today: {
        accessCount: parseInt(todayData.access_count, 10) || 0,
        downloadBytes: parseInt(todayData.download_bytes, 10) || 0,
        uploadBytes: parseInt(todayData.upload_bytes, 10) || 0
      }
    }
  }

  async getSystemStats() {
    const tokenStats = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status != 'active' OR (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) as expired,
        SUM(access_count) as total_access
      FROM sub_tokens
    `)

    const userStats = await this.pool.query('SELECT COUNT(*) as count FROM sub_users')

    const stats = tokenStats.rows[0] || {}
    return {
      totalAccess: parseInt(stats.total_access, 10) || 0,
      activeTokens: parseInt(stats.active, 10) || 0,
      expiredTokens: parseInt(stats.expired, 10) || 0,
      userCount: parseInt(userStats.rows[0]?.count, 10) || 0
    }
  }

  async _addColumnIfNotExists(table, column, definition) {
    try {
      const { rows } = await this.pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = $2
      `, [table, column])

      if (rows.length === 0) {
        await this.pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
        logger.info(`Added column ${column} to ${table}`)
      }
    } catch (error) {
      logger.debug(`Column ${column} check for ${table}: ${error.message}`)
    }
  }

  _camelToSnake(str) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  }

  _formatUser(row) {
    if (!row) return null
    const parsedTrafficLimit = row.traffic_limit === null || row.traffic_limit === undefined ? NaN : parseInt(row.traffic_limit, 10)
    const parsedTrafficUsed = row.traffic_used === null || row.traffic_used === undefined ? NaN : parseInt(row.traffic_used, 10)
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      passwordHash: row.password_hash,
      role: row.role || 'user',
      parentId: row.parent_id || null,
      subscriptionToken: row.subscription_token || '',
      expiresAt: this._toISOString(row.expires_at, ''),
      isActive: row.is_active ? 'true' : 'false',
      lastLoginAt: this._toISOString(row.last_login_at, ''),
      createdAt: this._toISOString(row.created_at, ''),
      trafficLimit: Number.isNaN(parsedTrafficLimit) ? 536870912000 : parsedTrafficLimit,
      trafficUsed: Number.isNaN(parsedTrafficUsed) ? 0 : parsedTrafficUsed,
      trafficResetAt: this._toISOString(row.traffic_reset_at, null),
      tokenMode: row.token_mode || 'strict'
    }
  }

  _formatToken(row) {
    if (!row) return null
    return {
      id: row.id,
      token: row.token,
      name: row.name,
      status: row.status,
      expiresAt: this._toISOString(row.expires_at, null),
      maxAccess: row.max_access || 0,
      accessCount: row.access_count || 0,
      oneTimeUse: !!row.one_time_use,
      isConsumed: !!row.is_consumed,
      userId: row.user_id || null,
      allowedIPs: this._parseJson(row.allowed_ips) || [],
      enabledNodes: this._parseJson(row.enabled_nodes) || [],
      vlessUuid: row.vless_uuid || null,
      createdBy: row.created_by,
      lastAccessAt: this._toISOString(row.last_access_at, null),
      lastAccessIP: row.last_access_ip,
      lastUserAgent: row.last_user_agent,
      createdAt: this._toISOString(row.created_at, null)
    }
  }

  _parseJson(value) {
    if (!value) return null
    if (typeof value === 'object') return value
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  _toISOString(value, fallback) {
    if (!value) return fallback
    if (value instanceof Date) return value.toISOString()

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }
}

module.exports = new SubscriptionPostgresClient()
