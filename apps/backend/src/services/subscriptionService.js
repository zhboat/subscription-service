/**
 * 订阅服务 - 安全的动态订阅链接管理
 * 支持 Token 验证、过期时间、访问限制等安全特性
 * 数据存储：MySQL（持久化）
 */

const crypto = require('crypto')
const subscriptionMysql = require('../models/subscriptionMysql')
const xrayService = require('./xrayService')
const logger = require('../utils/logger')

const DEFAULT_TOKEN_EXPIRY_DAYS = 30

class SubscriptionService {
  constructor() {
    // 节点配置 - 从环境变量或默认值加载
    this.nodes = this._loadNodesConfig()
    this.mysqlReady = false
  }

  /**
   * 初始化 MySQL 连接
   */
  async initMySQL() {
    if (this.mysqlReady) return
    try {
      await subscriptionMysql.connect()
      this.mysqlReady = true
      logger.info('✅ SubscriptionService MySQL initialized')
    } catch (error) {
      logger.error('❌ SubscriptionService MySQL init failed:', error)
      throw error
    }
  }

  /**
   * 确保 MySQL 已连接
   */
  async ensureMySQL() {
    if (!this.mysqlReady) {
      await this.initMySQL()
    }
  }

  /**
   * 加载节点配置
   */
  _loadNodesConfig() {
    const defaultNodes = [
      {
        id: 'hysteria2',
        name: 'Hysteria2-Node',
        type: 'hysteria2',
        enabled: true,
        config: {
          server: process.env.SUB_HY2_SERVER || 'example.com',
          port: parseInt(process.env.SUB_HY2_PORT) || 443,
          password: process.env.SUB_HY2_PASSWORD || 'CHANGE_ME',
          sni: process.env.SUB_HY2_SNI || 'example.com',
          insecure: process.env.SUB_HY2_INSECURE === 'true' ? 1 : 0
        }
      },
      {
        id: 'vless-grpc',
        name: 'VLESS-gRPC-Node',
        type: 'vless',
        enabled: true,
        config: {
          server: process.env.SUB_VLESS_SERVER || 'example.com',
          port: parseInt(process.env.SUB_VLESS_PORT) || 443,
          uuid: process.env.SUB_VLESS_UUID || '00000000-0000-0000-0000-000000000000',
          encryption: 'none',
          security: 'tls',
          sni: process.env.SUB_VLESS_SNI || 'example.com',
          alpn: 'h2',
          fp: 'chrome',
          type: process.env.SUB_VLESS_TYPE || 'grpc',
          serviceName: process.env.SUB_VLESS_SERVICE_NAME || 'vless-grpc',
          mode: process.env.SUB_VLESS_MODE || 'multi'
        }
      }
    ]

    return defaultNodes
  }

  /**
   * 生成安全的订阅 Token
   */
  generateToken() {
    return crypto.randomBytes(32).toString('hex')
  }

  /**
   * 创建订阅 Token
   */
  async createSubscriptionToken(options = {}) {
    await this.ensureMySQL()

    const {
      name = '默认订阅',
      expiryDays = DEFAULT_TOKEN_EXPIRY_DAYS,
      maxAccess = 0,
      oneTimeUse = false,
      userId = null,
      allowedIPs = [],
      enabledNodes = [],
      createdBy = 'admin'
    } = options

    const token = this.generateToken()
    const tokenId = token.substring(0, 8)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000)
    const vlessUuid = crypto.randomUUID()

    try {
      await subscriptionMysql.createToken({
        id: tokenId,
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
      })

      // 异步添加 Xray 用户（不阻塞返回）
      xrayService.addTokenUser(tokenId, vlessUuid).catch(err => {
        logger.error(`Failed to add Xray user for token ${tokenId}:`, err)
      })

      logger.info(`📋 Created subscription token: ${tokenId} (${name}), oneTimeUse: ${oneTimeUse}`)

      return {
        id: tokenId,
        token,
        name,
        oneTimeUse,
        expiresAt: expiresAt.toISOString(),
        subscribeUrl: `/sub/${token}`
      }
    } catch (error) {
      logger.error('❌ Failed to create subscription token:', error)
      throw error
    }
  }

  /**
   * 验证订阅 Token
   */
  async validateToken(token, clientIP = null) {
    await this.ensureMySQL()

    const data = await subscriptionMysql.getToken(token)

    if (!data || !data.token) {
      return { valid: false, error: 'Token not found or expired' }
    }

    // 检查状态
    if (data.status !== 'active') {
      return { valid: false, error: 'Token is disabled' }
    }

    // 检查过期时间
    if (data.expiresAt) {
      const expiresAt = new Date(data.expiresAt)
      if (expiresAt < new Date()) {
        return { valid: false, error: 'Token expired' }
      }
    }

    // 检查一次性链接是否已被消费
    if (data.oneTimeUse && data.isConsumed) {
      return { valid: false, error: '订阅链接已失效，请重新生成' }
    }

    // 检查访问次数
    if (data.maxAccess > 0 && data.accessCount >= data.maxAccess) {
      return { valid: false, error: 'Max access count exceeded' }
    }

    // 检查 IP 限制
    const allowedIPs = data.allowedIPs || []
    if (allowedIPs.length > 0 && clientIP && !allowedIPs.includes(clientIP)) {
      logger.warn(`🚫 Subscription access denied for IP: ${clientIP}, token: ${data.id}`)
      return { valid: false, error: 'IP not allowed' }
    }

    return { valid: true, data }
  }

  /**
   * 记录访问并更新统计
   */
  async recordAccess(token, clientIP, userAgent, tokenData = null) {
    await this.ensureMySQL()
    await subscriptionMysql.incrementTokenAccess(token, clientIP || 'unknown', userAgent || 'unknown')

    // 如果是一次性链接，标记为已消费
    if (tokenData && tokenData.oneTimeUse && !tokenData.isConsumed) {
      await subscriptionMysql.markTokenConsumed(token)
      logger.info(`🔒 One-time token consumed: ${token.substring(0, 8)}...`)
    }
  }

  /**
   * 生成订阅内容
   * @param {string} token - 订阅 Token
   * @param {string} clientIP - 客户端 IP
   * @param {string} userAgent - 用户代理
   * @param {object} trafficInfo - 流量信息（可选）
   * @param {number} trafficInfo.used - 已用流量（字节）
   * @param {number} trafficInfo.limit - 流量限制（字节）
   * @param {Date|string} trafficInfo.expiresAt - 过期时间
   */
  async generateSubscription(token, clientIP = null, userAgent = null, trafficInfo = null) {
    // 验证 Token
    const validation = await this.validateToken(token, clientIP)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    const { data } = validation

    // 记录访问（传递 tokenData 以处理一次性链接）
    await this.recordAccess(token, clientIP, userAgent, data)

    // 获取启用的节点
    const enabledNodeIds = data.enabledNodes || []
    const nodes = this.nodes.filter(node => {
      if (!node.enabled) return false
      if (enabledNodeIds.length > 0 && !enabledNodeIds.includes(node.id)) return false
      return true
    })

    // 生成订阅链接
    const links = []

    // 添加流量信息节点（放在最前面）
    if (trafficInfo) {
      const infoLink = this._generateTrafficInfoLink(trafficInfo)
      if (infoLink) {
        links.push(infoLink)
      }
    }

    // hy2 密码 = URL 中的 token（每个订阅链接独立）
    // 严格模式下旧 token 被 revoke → hy2 认证失败；宽松模式旧 token 保持 active → 认证成功
    const hy2Password = token
    const vlessUuid = data.vlessUuid

    // 添加实际节点
    links.push(...nodes.map(node => this._generateNodeLink(node, hy2Password, vlessUuid)))

    // Base64 编码
    const content = Buffer.from(links.join('\n')).toString('base64')

    return {
      success: true,
      content,
      contentType: 'text/plain',
      nodeCount: nodes.length,
      userId: data.userId // 返回关联的用户ID，用于获取流量信息
    }
  }

  /**
   * 生成节点链接
   * @param {object} node - 节点配置
   * @param {string} userToken - 用户的订阅 Token（用作密码）
   */
  _generateNodeLink(node, userToken = null, vlessUuid = null) {
    switch (node.type) {
      case 'hysteria2':
        return this._generateHysteria2Link(node, userToken)
      case 'vless':
        return this._generateVlessLink(node, vlessUuid)
      default:
        return ''
    }
  }

  /**
   * 生成 Hysteria2 链接
   * @param {object} node - 节点配置
   * @param {string} userToken - 用户的订阅 Token（用作密码，实现用户独立流量统计）
   */
  _generateHysteria2Link(node, userToken = null) {
    const { config, name } = node
    const params = new URLSearchParams({
      insecure: config.insecure.toString(),
      sni: config.sni
    })

    // 使用用户的订阅 Token 作为密码（如果提供）
    // 这样 Hysteria2 服务器可以通过密码识别用户并统计流量
    // 如果没有提供 userToken，则使用全局密码（兼容旧配置）
    const password = userToken || config.password

    return `hysteria2://${password}@${config.server}:${config.port}/?${params.toString()}#${encodeURIComponent(name)}`
  }

  /**
   * 生成 VLESS 链接
   */
  _generateVlessLink(node, dynamicUuid = null) {
    const { config, name } = node
    const uuid = dynamicUuid || config.uuid
    const params = new URLSearchParams({
      encryption: config.encryption,
      security: config.security,
      sni: config.sni,
      alpn: config.alpn || 'h2',
      fp: config.fp,
      type: config.type,
      serviceName: config.serviceName,
      mode: config.mode
    })
    return `vless://${uuid}@${config.server}:${config.port}?${params.toString()}#${encodeURIComponent(name)}`
  }

  /**
   * 生成流量信息节点链接（不可用节点，仅显示信息）
   * @param {object} trafficInfo - 流量信息
   * @param {number} trafficInfo.used - 已用流量（字节）
   * @param {number} trafficInfo.limit - 流量限制（字节）
   * @param {Date|string} trafficInfo.expiresAt - 过期时间
   */
  _generateTrafficInfoLink(trafficInfo) {
    const { used = 0, limit = 0, expiresAt } = trafficInfo

    // 格式化流量显示
    const formatBytes = bytes => {
      if (bytes === 0) return '0 B'
      const k = 1024
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    }

    // 计算剩余流量
    const remaining = Math.max(0, limit - used)
    const remainingStr = formatBytes(remaining)
    const limitStr = formatBytes(limit)

    // 格式化过期时间
    let expireStr = ''
    if (expiresAt) {
      const expireDate = new Date(expiresAt)
      expireStr = ` | 到期: ${expireDate.getFullYear()}-${String(expireDate.getMonth() + 1).padStart(2, '0')}-${String(expireDate.getDate()).padStart(2, '0')}`
    }

    // 生成节点名称
    const nodeName = `📊 剩余: ${remainingStr} / ${limitStr}${expireStr}`

    // 使用无效的 VLESS 链接格式（127.0.0.1:1 不可连接）
    // 这样客户端会显示这个节点但无法连接
    return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1?encryption=none&type=tcp#${encodeURIComponent(nodeName)}`
  }

  /**
   * 获取所有订阅 Token 列表
   */
  async listTokens() {
    await this.ensureMySQL()

    const tokens = await subscriptionMysql.listTokens()
    return tokens.map(token => ({
      id: token.id,
      name: token.name,
      status: token.status,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      accessCount: token.accessCount,
      maxAccess: token.maxAccess,
      lastAccessAt: token.lastAccessAt,
      lastAccessIP: token.lastAccessIP,
      createdBy: token.createdBy
    }))
  }

  /**
   * 获取单个 Token 详情
   */
  async getToken(token) {
    await this.ensureMySQL()
    return subscriptionMysql.getToken(token)
  }

  /**
   * 更新 Token 状态
   */
  async updateTokenStatus(token, status) {
    await this.ensureMySQL()

    const exists = await subscriptionMysql.getToken(token)
    if (!exists) {
      return { success: false, error: 'Token not found' }
    }

    await subscriptionMysql.updateToken(token, { status })
    logger.info(`📋 Updated subscription token status: ${token.substring(0, 8)} -> ${status}`)

    return { success: true }
  }

  /**
   * 删除 Token
   */
  async deleteToken(token) {
    await this.ensureMySQL()

    // 先获取 token 数据（用于删除 Xray 用户）
    const tokenData = await subscriptionMysql.getToken(token)
    const deleted = await subscriptionMysql.deleteToken(token)

    if (deleted) {
      // 异步删除 Xray 用户
      if (tokenData && tokenData.vlessUuid) {
        xrayService.removeTokenUser(tokenData.id).catch(err => {
          logger.error(`Failed to remove Xray user for token ${tokenData.id}:`, err)
        })
      }
      logger.info(`🗑️ Deleted subscription token: ${token.substring(0, 8)}`)
      return { success: true }
    }

    return { success: false, error: 'Token not found' }
  }

  /**
   * 重新生成订阅 Token
   * 根据用户的 token_mode 配置决定模式：
   * - strict: 严格模式，生成新链接后旧链接失效
   * - loose: 宽松模式，新旧链接并存
   */
  async regenerateToken(oldToken, tokenMode = 'strict') {
    await this.ensureMySQL()

    const tokenData = await subscriptionMysql.getToken(oldToken)
    if (!tokenData) {
      return { success: false, error: 'Token not found' }
    }

    // 生成新 Token 和新 VLESS UUID
    const newToken = this.generateToken()
    const newVlessUuid = crypto.randomUUID()

    // 根据模式决定是否使旧 token 失效
    const strictMode = tokenMode === 'strict'

    // 严格模式：获取将被 revoke 的旧 token，用于删除 Xray 用户
    let revokedTokens = []
    if (strictMode && tokenData.userId) {
      revokedTokens = await subscriptionMysql.getTokensByUserIdAndStatus(tokenData.userId, 'active')
    }

    const created = await subscriptionMysql.regenerateToken(oldToken, newToken, strictMode, newVlessUuid)
    if (!created) {
      return { success: false, error: 'Failed to create new token' }
    }

    // 严格模式：删除被 revoke 的旧 token 的 Xray 用户
    if (strictMode) {
      for (const rt of revokedTokens) {
        if (rt.vlessUuid) {
          xrayService.removeTokenUser(rt.id).catch(err => {
            logger.error(`Failed to remove Xray user for revoked token ${rt.id}:`, err)
          })
        }
      }
    }

    // 添加新 token 的 Xray 用户
    const newTokenId = newToken.substring(0, 8)
    xrayService.addTokenUser(newTokenId, newVlessUuid).catch(err => {
      logger.error(`Failed to add Xray user for new token ${newTokenId}:`, err)
    })

    const modeDesc = strictMode ? '旧链接已失效' : '旧链接仍有效'
    logger.info(`🔄 Created new subscription token for user ${tokenData.userId}: ${newToken.substring(0, 8)}... (${modeDesc})`)

    return {
      success: true,
      token: newToken,
      subscribeUrl: `/sub/${newToken}`
    }
  }

  /**
   * 为用户重新生成订阅链接
   */
  async regenerateUserToken(userId, tokenMode = 'strict') {
    await this.ensureMySQL()

    // 获取用户关联的 Token
    const tokenData = await subscriptionMysql.getTokenByUserId(userId)
    if (!tokenData) {
      return { success: false, error: '未找到关联的订阅链接' }
    }

    // 重新生成
    return this.regenerateToken(tokenData.token, tokenMode)
  }

  /**
   * 获取节点列表
   */
  getNodes() {
    return this.nodes.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      enabled: node.enabled
    }))
  }

  /**
   * 更新节点配置
   */
  updateNode(nodeId, updates) {
    const nodeIndex = this.nodes.findIndex(n => n.id === nodeId)
    if (nodeIndex === -1) {
      return { success: false, error: 'Node not found' }
    }

    this.nodes[nodeIndex] = { ...this.nodes[nodeIndex], ...updates }
    logger.info(`📋 Updated node config: ${nodeId}`)

    return { success: true, node: this.nodes[nodeIndex] }
  }

  /**
   * 获取用户统计信息
   */
  async getUserStats(userId) {
    await this.ensureMySQL()
    return subscriptionMysql.getUserStats(userId)
  }

  /**
   * 记录用户使用统计
   */
  async recordUserStats(userId, stats = {}) {
    await this.ensureMySQL()
    await subscriptionMysql.recordUserStats(userId, stats)
  }

  /**
   * 获取系统概览统计
   */
  async getSystemStats() {
    await this.ensureMySQL()

    const stats = await subscriptionMysql.getSystemStats()
    return {
      ...stats,
      nodeCount: this.nodes.filter(n => n.enabled).length
    }
  }
}

module.exports = new SubscriptionService()
