/**
 * 订阅服务 - 安全的动态订阅链接管理
 * 支持 Token 验证、过期时间、访问限制等安全特性
 * 数据存储：store（持久化）
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const subscriptionStore = require('../models/subscriptionStore')
const xrayService = require('./xrayService')
const logger = require('../utils/logger')

const DEFAULT_TOKEN_EXPIRY_DAYS = 30
const MIHOMO_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.yaml'), 'utf8')
const MIHOMO_MIN_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.min.yaml'), 'utf8')
const MIHOMO_LITE_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_DNS_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.dns.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_DNS_SNIFFER_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.dns.sniffer.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.dns.sniffer.geo.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_DOH_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.dns.sniffer.geo.doh.yaml'), 'utf8')
const MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_FULLDNS_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.lite.private.dns.sniffer.geo.fulldns.yaml'), 'utf8')
const MIHOMO_FULL_NOFALLBACK_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.full.nofallback.yaml'), 'utf8')
const MIHOMO_FULL_STABLE_DNS_TEMPLATE = fs.readFileSync(path.join(__dirname, '../templates/ohyes.mihomo.full.stable-dns.yaml'), 'utf8')

class SubscriptionService {
  constructor() {
    // 节点配置 - 从环境变量或默认值加载
    this.nodes = this._loadNodesConfig()
    this.storeReady = false
  }

  /**
   * 初始化 store 连接
   */
  async initStore() {
    if (this.storeReady) return
    try {
      await subscriptionStore.connect()
      this.storeReady = true
      logger.info('✅ SubscriptionService store initialized')
    } catch (error) {
      logger.error('❌ SubscriptionService store init failed:', error)
      throw error
    }
  }

  /**
   * 确保 store 已连接
   */
  async ensureStore() {
    if (!this.storeReady) {
      await this.initStore()
    }
  }

  /**
   * 加载节点配置
   */
  _loadNodesConfig() {
    const hy2Configured = Boolean(
      process.env.SUB_HY2_SERVER &&
      process.env.SUB_HY2_SERVER !== 'example.com' &&
      process.env.SUB_HY2_SNI &&
      process.env.SUB_HY2_SNI !== 'example.com' &&
      process.env.SUB_HY2_PASSWORD &&
      process.env.SUB_HY2_PASSWORD !== 'CHANGE_ME'
    )

    return [
      {
        id: 'hysteria2',
        name: 'Hysteria2-Node',
        type: 'hysteria2',
        enabled: hy2Configured,
        config: {
          server: process.env.SUB_HY2_SERVER || 'example.com',
          port: parseInt(process.env.SUB_HY2_PORT) || 443,
          password: process.env.SUB_HY2_PASSWORD || 'CHANGE_ME',
          sni: process.env.SUB_HY2_SNI || 'example.com',
          insecure: process.env.SUB_HY2_INSECURE === 'true' ? 1 : 0
        }
      }
    ]
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
    await this.ensureStore()

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
      await subscriptionStore.createToken({
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
    await this.ensureStore()

    const data = await subscriptionStore.getToken(token)

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
    await this.ensureStore()
    await subscriptionStore.incrementTokenAccess(token, clientIP || 'unknown', userAgent || 'unknown')

    // 如果是一次性链接，标记为已消费
    if (tokenData && tokenData.oneTimeUse && !tokenData.isConsumed) {
      await subscriptionStore.markTokenConsumed(token)
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
  async generateSubscription(token, clientIP = null, userAgent = null, trafficInfo = null, format = '') {
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

    const outputFormat = this._normalizeOutputFormat(format)

    // hy2 密码 = URL 中的 token（每个订阅链接独立）
    // 严格模式下旧 token 被 revoke → hy2 认证失败；宽松模式旧 token 保持 active → 认证成功
    const hy2Password = token

    if (outputFormat === 'mihomo' || outputFormat === 'mihomo-min' || outputFormat === 'mihomo-lite' || outputFormat === 'mihomo-lite-private' || outputFormat === 'mihomo-lite-private-dns' || outputFormat === 'mihomo-lite-private-dns-sniffer' || outputFormat === 'mihomo-lite-private-dns-sniffer-geo' || outputFormat === 'mihomo-lite-private-dns-sniffer-geo-fulldns' || outputFormat === 'mihomo-lite-private-dns-sniffer-geo-doh' || outputFormat === 'mihomo-full-nofallback' || outputFormat === 'mihomo-full-stable-dns') {
      const primaryNode = nodes.find(node => node.type === 'hysteria2')
      if (!primaryNode) {
        return { success: false, error: 'No available hysteria2 node' }
      }

      let content
      if (outputFormat === 'mihomo-min') {
        content = this._generateMinimalMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite') {
        content = this._generateLiteMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private') {
        content = this._generateLitePrivateMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private-dns') {
        content = this._generateLitePrivateDnsMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private-dns-sniffer') {
        content = this._generateLitePrivateDnsSnifferMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private-dns-sniffer-geo') {
        content = this._generateLitePrivateDnsSnifferGeoMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private-dns-sniffer-geo-fulldns') {
        content = this._generateLitePrivateDnsSnifferGeoFullDnsMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-lite-private-dns-sniffer-geo-doh') {
        content = this._generateLitePrivateDnsSnifferGeoDohMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-full-nofallback') {
        content = this._generateFullNoFallbackMihomoConfig(primaryNode, hy2Password)
      } else if (outputFormat === 'mihomo-full-stable-dns') {
        content = this._generateFullStableDnsMihomoConfig(primaryNode, hy2Password)
      } else {
        content = this._generateMihomoConfig(primaryNode, hy2Password)
      }

      content = this._injectTrafficInfoGroup(content, trafficInfo)

      return {
        success: true,
        content,
        contentType: 'text/yaml; charset=utf-8',
        fileExtension: 'yaml',
        outputFormat,
        nodeCount: nodes.length,
        userId: data.userId
      }
    }

    // 生成订阅链接
    const links = []

    // 流量信息改由 Subscription-Userinfo 响应头承载，避免在 base64 订阅中插入伪 VLESS 节点

    // 添加实际节点
    links.push(...nodes.map(node => this._generateNodeLink(node, hy2Password)))

    return {
      success: true,
      content: Buffer.from(links.join('\n')).toString('base64'),
      contentType: 'text/plain; charset=utf-8',
      fileExtension: 'txt',
      outputFormat,
      nodeCount: nodes.length,
      userId: data.userId // 返回关联的用户ID，用于获取流量信息
    }
  }

  /**
   * 生成节点链接
   * @param {object} node - 节点配置
   * @param {string} userToken - 用户的订阅 Token（用作密码）
   */
  _generateNodeLink(node, userToken = null) {
    switch (node.type) {
      case 'hysteria2':
        return this._generateHysteria2Link(node, userToken)
      default:
        return ''
    }
  }

  _normalizeOutputFormat(format = '') {
    const normalized = String(format || '').trim().toLowerCase()
    if (normalized === 'clash-min' || normalized === 'mihomo-min') return 'mihomo-min'
    if (normalized === 'clash-lite' || normalized === 'mihomo-lite') return 'mihomo-lite'
    if (normalized === 'clash-lite-private' || normalized === 'mihomo-lite-private') return 'mihomo-lite-private'
    if (normalized === 'clash-lite-private-dns' || normalized === 'mihomo-lite-private-dns') return 'mihomo-lite-private-dns'
    if (normalized === 'clash-lite-private-dns-sniffer' || normalized === 'mihomo-lite-private-dns-sniffer') return 'mihomo-lite-private-dns-sniffer'
    if (normalized === 'clash-lite-private-dns-sniffer-geo' || normalized === 'mihomo-lite-private-dns-sniffer-geo') return 'mihomo-lite-private-dns-sniffer-geo'
    if (normalized === 'clash-lite-private-dns-sniffer-geo-fulldns' || normalized === 'mihomo-lite-private-dns-sniffer-geo-fulldns') return 'mihomo-lite-private-dns-sniffer-geo-fulldns'
    if (normalized === 'clash-lite-private-dns-sniffer-geo-doh' || normalized === 'mihomo-lite-private-dns-sniffer-geo-doh') return 'mihomo-lite-private-dns-sniffer-geo-doh'
    if (normalized === 'clash-full-nofallback' || normalized === 'mihomo-full-nofallback') return 'mihomo-full-nofallback'
    if (normalized === 'clash-full-stable-dns' || normalized === 'mihomo-full-stable-dns') return 'mihomo-full-stable-dns'
    if (normalized === 'clash' || normalized === 'mihomo') return 'mihomo-full-stable-dns'
    return 'base64'
  }

  _generateMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_TEMPLATE, node, userToken)
  }

  _generateMinimalMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_MIN_TEMPLATE, node, userToken)
  }

  _generateLiteMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_TEMPLATE, node, userToken)
  }

  _generateLitePrivateMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_TEMPLATE, node, userToken)
  }

  _generateLitePrivateDnsMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_DNS_TEMPLATE, node, userToken)
  }

  _generateLitePrivateDnsSnifferMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_DNS_SNIFFER_TEMPLATE, node, userToken)
  }

  _generateLitePrivateDnsSnifferGeoMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_TEMPLATE, node, userToken)
  }

  _generateLitePrivateDnsSnifferGeoFullDnsMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_FULLDNS_TEMPLATE, node, userToken)
  }

  _generateLitePrivateDnsSnifferGeoDohMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_LITE_PRIVATE_DNS_SNIFFER_GEO_DOH_TEMPLATE, node, userToken)
  }

  _generateFullNoFallbackMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_FULL_NOFALLBACK_TEMPLATE, node, userToken)
  }

  _generateFullStableDnsMihomoConfig(node, userToken = null) {
    return this._renderMihomoTemplate(MIHOMO_FULL_STABLE_DNS_TEMPLATE, node, userToken)
  }

  _renderMihomoTemplate(template, node, userToken = null) {
    const { config } = node
    const password = userToken || config.password

    return template
      .replace(/__HY2_SERVER__/g, config.server)
      .replace(/__HY2_PORT__/g, String(config.port))
      .replace(/__HY2_PASSWORD__/g, password)
      .replace(/__HY2_SNI__/g, config.sni)
      .replace(/__HY2_SKIP_CERT_VERIFY__/g, config.insecure ? 'true' : 'false')
  }

  _injectTrafficInfoGroup(content, trafficInfo = null) {
    if (!trafficInfo || !content.includes('proxy-groups:\n')) {
      return content
    }

    const groupName = this._buildTrafficInfoLabel(trafficInfo)
    const trafficGroup = `  - name: "${groupName}"
    type: select
    proxies:
      - REJECT
`

    return content.replace('proxy-groups:\n', `proxy-groups:\n${trafficGroup}`)
  }

  _buildTrafficInfoLabel(trafficInfo) {

    const { used = 0, limit = 0, expiresAt } = trafficInfo
    const remaining = Math.max(0, limit - used)
    const remainingStr = this._formatBytes(remaining)
    const limitStr = this._formatBytes(limit)

    if (!expiresAt) {
      return `📊 剩余: ${remainingStr} / ${limitStr}`
    }

    const expireDate = new Date(expiresAt)
    return `📊 剩余: ${remainingStr} / ${limitStr} | 到期: ${expireDate.getFullYear()}-${String(expireDate.getMonth() + 1).padStart(2, '0')}-${String(expireDate.getDate()).padStart(2, '0')}`
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
   * 生成流量信息节点链接（不可用节点，仅显示信息）
   * @param {object} trafficInfo - 流量信息
   * @param {number} trafficInfo.used - 已用流量（字节）
   * @param {number} trafficInfo.limit - 流量限制（字节）
   * @param {Date|string} trafficInfo.expiresAt - 过期时间
   */
  _generateTrafficInfoLink(trafficInfo) {
    const { used = 0, limit = 0, expiresAt } = trafficInfo
    const nodeName = this._buildTrafficInfoLabel({ used, limit, expiresAt })

    // 使用无效的 VLESS 链接格式（127.0.0.1:1 不可连接）
    // 这样客户端会显示这个节点但无法连接
    return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1?encryption=none&type=tcp#${encodeURIComponent(nodeName)}`
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  /**
   * 获取所有订阅 Token 列表
   */
  async listTokens() {
    await this.ensureStore()

    const tokens = await subscriptionStore.listTokens()
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
    await this.ensureStore()
    return subscriptionStore.getToken(token)
  }

  /**
   * 更新 Token 状态
   */
  async updateTokenStatus(token, status) {
    await this.ensureStore()

    const exists = await subscriptionStore.getToken(token)
    if (!exists) {
      return { success: false, error: 'Token not found' }
    }

    await subscriptionStore.updateToken(token, { status })
    logger.info(`📋 Updated subscription token status: ${token.substring(0, 8)} -> ${status}`)

    return { success: true }
  }

  /**
   * 删除 Token
   */
  async deleteToken(token) {
    await this.ensureStore()

    // 先获取 token 数据（用于删除 Xray 用户）
    const tokenData = await subscriptionStore.getToken(token)
    const deleted = await subscriptionStore.deleteToken(token)

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
    await this.ensureStore()

    const tokenData = await subscriptionStore.getToken(oldToken)
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
      revokedTokens = await subscriptionStore.getTokensByUserIdAndStatus(tokenData.userId, 'active')
    }

    const created = await subscriptionStore.regenerateToken(oldToken, newToken, strictMode, newVlessUuid)
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
    await this.ensureStore()

    // 获取用户关联的 Token
    const tokenData = await subscriptionStore.getTokenByUserId(userId)
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
    await this.ensureStore()
    return subscriptionStore.getUserStats(userId)
  }

  /**
   * 记录用户使用统计
   */
  async recordUserStats(userId, stats = {}) {
    await this.ensureStore()
    await subscriptionStore.recordUserStats(userId, stats)
  }

  /**
   * 获取系统概览统计
   */
  async getSystemStats() {
    await this.ensureStore()

    const stats = await subscriptionStore.getSystemStats()
    return {
      ...stats,
      nodeCount: this.nodes.filter(n => n.enabled).length
    }
  }
}

module.exports = new SubscriptionService()
