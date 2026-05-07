/**
 * 订阅用户服务 - 后端认证
 * 支持用户管理、密码加密、会话管理
 * 数据存储：store（持久化） + Redis（会话缓存）
 */

const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const redis = require('../models/redis')
const subscriptionStore = require('../models/subscriptionStore')
const subscriptionService = require('./subscriptionService')
const logger = require('../utils/logger')

// Redis Key 前缀（仅用于会话）
const SUB_SESSION_PREFIX = 'sub_session:'
const SESSION_TTL = 24 * 60 * 60 // 24小时

// 配置常量
const MAX_SUB_USERS = 20 // 每个管理员最多创建20个下级用户
const DEFAULT_TRAFFIC_LIMIT = 500 * 1024 * 1024 * 1024 // 500GB per user
const TOTAL_TRAFFIC_LIMIT = 10 * 1024 * 1024 * 1024 * 1024 // 10TB total

class SubUserService {
  constructor() {
    this.saltRounds = 10
    this.storeReady = false
    this.maxSubUsers = MAX_SUB_USERS
    this.defaultTrafficLimit = DEFAULT_TRAFFIC_LIMIT
    this.totalTrafficLimit = TOTAL_TRAFFIC_LIMIT
  }

  /**
   * 初始化 store 连接
   */
  async initStore() {
    if (this.storeReady) return
    try {
      await subscriptionStore.connect()
      this.storeReady = true
      logger.info('✅ SubUserService store initialized')
    } catch (error) {
      logger.error('❌ SubUserService store init failed:', error)
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
   * 生成会话 Token
   */
  generateSessionToken() {
    return crypto.randomBytes(32).toString('hex')
  }

  /**
   * 创建订阅用户
   */
  async createUser(username, password, options = {}) {
    await this.ensureStore()

    const {
      name = username,
      role = 'user',
      parentId = null,
      subscriptionToken = null,
      expiresAt = null,
      isActive = true,
      trafficLimit = this.defaultTrafficLimit,
      trafficUsed = 0
    } = options

    const normalizedTrafficLimit = Number.isFinite(Number(trafficLimit)) && Number(trafficLimit) >= 0
      ? Math.floor(Number(trafficLimit))
      : this.defaultTrafficLimit
    const normalizedTrafficUsed = Number.isFinite(Number(trafficUsed)) && Number(trafficUsed) >= 0 ? Math.floor(Number(trafficUsed)) : 0

    // 检查用户是否已存在
    const existingUser = await this.getUserByUsername(username)
    if (existingUser) {
      return { success: false, error: '用户名已存在' }
    }

    // 如果指定了父级用户，验证父级用户存在且是管理员
    if (parentId) {
      const parentUser = await this.getUserById(parentId)
      if (!parentUser) {
        return { success: false, error: '父级用户不存在' }
      }
      if (parentUser.role !== 'admin') {
        return { success: false, error: '只有管理员可以创建下级用户' }
      }
    }

    // 加密密码
    const passwordHash = await bcrypt.hash(password, this.saltRounds)
    const userId = crypto.randomBytes(8).toString('hex')

    try {
      await subscriptionStore.createUser({
        id: userId,
        username,
        passwordHash,
        name,
        role,
        parentId,
        subscriptionToken,
        expiresAt,
        isActive,
        trafficLimit: normalizedTrafficLimit,
        trafficUsed: normalizedTrafficUsed
      })

      logger.info(`📋 Created subscription user: ${username} (${userId}), role: ${role}`)

      return {
        success: true,
        user: {
          id: userId,
          username,
          name,
          role,
          parentId,
          isActive,
          trafficLimit: normalizedTrafficLimit,
          trafficUsed: normalizedTrafficUsed
        }
      }
    } catch (error) {
      logger.error('❌ Failed to create user:', error)
      return { success: false, error: '创建用户失败' }
    }
  }

  /**
   * 通过用户名获取用户
   */
  async getUserByUsername(username) {
    await this.ensureStore()
    return subscriptionStore.getUserByUsername(username)
  }

  /**
   * 通过ID获取用户
   */
  async getUserById(userId) {
    await this.ensureStore()
    return subscriptionStore.getUserById(userId)
  }

  /**
   * 用户登录验证
   */
  async login(username, password) {
    await this.ensureStore()

    const user = await this.getUserByUsername(username)

    if (!user) {
      return { success: false, error: '用户名或密码错误' }
    }

    if (user.isActive !== 'true') {
      return { success: false, error: '账号已被禁用' }
    }

    // 检查账号是否过期
    if (user.expiresAt && new Date(user.expiresAt) < new Date()) {
      return { success: false, error: '账号已过期' }
    }

    // 验证密码
    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      return { success: false, error: '用户名或密码错误' }
    }

    // 创建会话（存储在 Redis 中，用于快速验证）
    const sessionToken = this.generateSessionToken()
    const sessionData = {
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      createdAt: new Date().toISOString()
    }

    await redis.client.setex(
      `${SUB_SESSION_PREFIX}${sessionToken}`,
      SESSION_TTL,
      JSON.stringify(sessionData)
    )

    // 更新最后登录时间
    await subscriptionStore.updateUser(user.id, {
      lastLoginAt: new Date()
    })

    logger.info(`✅ Subscription user logged in: ${username} (role: ${user.role})`)

    return {
      success: true,
      token: sessionToken,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        subscriptionToken: user.subscriptionToken
      }
    }
  }

  /**
   * 验证会话
   */
  async validateSession(sessionToken) {
    if (!sessionToken) {
      return { valid: false, error: '未提供会话令牌' }
    }

    const sessionData = await redis.client.get(`${SUB_SESSION_PREFIX}${sessionToken}`)
    if (!sessionData) {
      return { valid: false, error: '会话已过期或无效' }
    }

    try {
      await this.ensureStore()
      const session = JSON.parse(sessionData)
      const user = await this.getUserById(session.userId)

      if (!user || user.isActive !== 'true') {
        return { valid: false, error: '用户已被禁用' }
      }

      // 检查账号是否过期
      if (user.expiresAt && new Date(user.expiresAt) < new Date()) {
        return { valid: false, error: '账号已过期' }
      }

      return {
        valid: true,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          subscriptionToken: user.subscriptionToken,
          tokenMode: user.tokenMode
        }
      }
    } catch (e) {
      return { valid: false, error: '会话数据无效' }
    }
  }

  /**
   * 登出
   */
  async logout(sessionToken) {
    if (sessionToken) {
      await redis.client.del(`${SUB_SESSION_PREFIX}${sessionToken}`)
    }
    return { success: true }
  }

  /**
   * 修改密码
   */
  async changePassword(userId, oldPassword, newPassword) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    const isValid = await bcrypt.compare(oldPassword, user.passwordHash)
    if (!isValid) {
      return { success: false, error: '原密码错误' }
    }

    const newPasswordHash = await bcrypt.hash(newPassword, this.saltRounds)
    await subscriptionStore.updateUser(userId, { passwordHash: newPasswordHash })

    logger.info(`🔑 Password changed for subscription user: ${user.username}`)

    return { success: true }
  }

  /**
   * 管理员重置密码
   */
  async resetPassword(userId, newPassword) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    const newPasswordHash = await bcrypt.hash(newPassword, this.saltRounds)
    await subscriptionStore.updateUser(userId, { passwordHash: newPasswordHash })

    logger.info(`🔑 Password reset for subscription user: ${user.username}`)

    return { success: true }
  }

  /**
   * 更新用户信息
   */
  async updateUser(userId, updates) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    const allowedFields = ['name', 'role', 'subscriptionToken', 'expiresAt', 'isActive', 'trafficLimit', 'tokenMode']
    const updateData = {}

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateData[field] = updates[field]

        if (field === 'trafficLimit') {
          updateData[field] = Math.max(0, Math.floor(Number(updates[field]) || 0))
        }
      }
    }

    if (Object.keys(updateData).length > 0) {
      await subscriptionStore.updateUser(userId, updateData)
    }

    logger.info(`📝 Updated subscription user: ${user.username}`)

    return { success: true }
  }

  /**
   * 设置用户角色
   */
  async setUserRole(userId, role) {
    await this.ensureStore()

    if (!['admin', 'user'].includes(role)) {
      return { success: false, error: '无效的角色' }
    }

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    await subscriptionStore.updateUser(userId, { role })
    logger.info(`👤 Set user role: ${user.username} -> ${role}`)

    return { success: true }
  }

  /**
   * 获取下级用户列表
   */
  async getSubUsers(parentId) {
    await this.ensureStore()
    const users = await subscriptionStore.getSubUsers(parentId)
    return users.map(user => ({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      isActive: user.isActive === 'true',
      expiresAt: user.expiresAt,
      subscriptionToken: user.subscriptionToken,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      // 流量信息
      trafficLimit: user.trafficLimit,
      trafficUsed: user.trafficUsed,
      trafficResetAt: user.trafficResetAt
    }))
  }

  /**
   * 获取管理员的下级用户统计信息
   */
  async getSubUserStats(adminId) {
    await this.ensureStore()

    const subUserCount = await subscriptionStore.getSubUserCount(adminId)
    const trafficStats = await subscriptionStore.getSubUsersTotalTraffic(adminId)

    return {
      subUserCount,
      maxSubUsers: this.maxSubUsers,
      remainingSlots: Math.max(0, this.maxSubUsers - subUserCount),
      totalTrafficUsed: trafficStats.totalUsed,
      totalTrafficLimit: this.totalTrafficLimit,
      trafficUsedPercent: ((trafficStats.totalUsed / this.totalTrafficLimit) * 100).toFixed(2)
    }
  }

  /**
   * 更新用户流量使用量
   */
  async updateTrafficUsed(userId, bytesUsed) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    // 检查是否超出流量限制
    if (user.trafficUsed + bytesUsed > user.trafficLimit) {
      return { success: false, error: '流量已用尽' }
    }

    await subscriptionStore.updateTrafficUsed(userId, bytesUsed)
    logger.info(`📊 Updated traffic for user ${user.username}: +${bytesUsed} bytes`)

    return { success: true }
  }

  /**
   * 重置用户流量
   */
  async resetTraffic(userId) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    await subscriptionStore.resetTraffic(userId)
    logger.info(`🔄 Reset traffic for user ${user.username}`)

    return { success: true }
  }

  /**
   * 检查用户流量是否可用
   */
  async checkTrafficAvailable(userId) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { available: false, error: '用户不存在' }
    }

    const available = user.trafficUsed < user.trafficLimit
    const remaining = Math.max(0, user.trafficLimit - user.trafficUsed)

    return {
      available,
      trafficUsed: user.trafficUsed,
      trafficLimit: user.trafficLimit,
      remaining,
      usedPercent: ((user.trafficUsed / user.trafficLimit) * 100).toFixed(2)
    }
  }

  /**
   * 管理员创建下级用户（带自动生成订阅链接）
   */
  async createSubUser(adminId, username, password, options = {}) {
    await this.ensureStore()

    // 验证管理员权限
    const admin = await this.getUserById(adminId)
    if (!admin || admin.role !== 'admin') {
      return { success: false, error: '无权限创建下级用户' }
    }

    // 检查下级用户数量限制
    const subUserCount = await subscriptionStore.getSubUserCount(adminId)
    if (subUserCount >= this.maxSubUsers) {
      return { success: false, error: `已达到下级用户数量上限（最多${this.maxSubUsers}个）` }
    }

    // 使用自定义流量限制或默认值
    const trafficLimit = Number.isFinite(Number(options.trafficLimit)) && Number(options.trafficLimit) > 0
      ? options.trafficLimit
      : this.defaultTrafficLimit

    // 创建用户，设置流量限制
    const result = await this.createUser(username, password, {
      ...options,
      role: 'user',
      parentId: adminId,
      trafficLimit,
      trafficUsed: 0
    })

    return result
  }

  /**
   * 删除用户
   */
  async deleteUser(userId) {
    await this.ensureStore()

    const user = await this.getUserById(userId)
    if (!user) {
      return { success: false, error: '用户不存在' }
    }

    await subscriptionStore.deleteUser(userId)

    logger.info(`🗑️ Deleted subscription user: ${user.username}`)

    return { success: true }
  }

  /**
   * 获取所有用户列表
   */
  async listUsers() {
    await this.ensureStore()

    const users = await subscriptionStore.listUsers()
    return users.map(user => ({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      parentId: user.parentId,
      isActive: user.isActive === 'true',
      expiresAt: user.expiresAt,
      subscriptionToken: user.subscriptionToken,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt
    }))
  }

  /**
   * 确保用户有可用的订阅 Token
   */
  async ensureUserSubscriptionToken(user, createdBy = 'system') {
    await this.ensureStore()

    if (!user || !user.id) {
      return { success: false, error: '用户不存在' }
    }

    if (user.subscriptionToken) {
      return { success: true, token: user.subscriptionToken, created: false }
    }

    try {
      const tokenData = await subscriptionService.createSubscriptionToken({
        name: `${user.username}默认订阅`,
        expiryDays: 3650,
        oneTimeUse: false,
        userId: user.id,
        createdBy
      })

      await this.updateUser(user.id, {
        subscriptionToken: tokenData.token
      })

      logger.info(`🔗 Bound default subscription token for user: ${user.username}`)

      return { success: true, token: tokenData.token, created: true }
    } catch (error) {
      logger.error('❌ Failed to ensure user subscription token:', error)
      return { success: false, error: '创建默认订阅链接失败' }
    }
  }

  /**
   * 初始化默认管理员账号
   */
  async initDefaultAdmin() {
    await this.ensureStore()

    let adminUser = await this.getUserByUsername('admin')
    let defaultPassword = null

    if (!adminUser) {
      // 生成随机密码
      defaultPassword = crypto.randomBytes(8).toString('hex')
      const createResult = await this.createUser('admin', defaultPassword, {
        name: '管理员',
        role: 'admin',
        isActive: true
      })

      if (!createResult.success) {
        return { created: false, error: createResult.error }
      }

      adminUser = createResult.user

      const tokenResult = await this.ensureUserSubscriptionToken(adminUser, 'system')
      if (!tokenResult.success) {
        return { created: true, password: defaultPassword, warning: tokenResult.error }
      }

      logger.info(`📋 Created default subscription admin account`)
      logger.info(`📋 Default admin password: ${defaultPassword}`)
      return { created: true, password: defaultPassword }
    } else if (adminUser.role !== 'admin') {
      // 如果 admin 用户存在但不是管理员角色，升级为管理员
      await this.setUserRole(adminUser.id, 'admin')
      adminUser.role = 'admin'
      logger.info(`📋 Upgraded admin user to admin role`)
    }

    const tokenResult = await this.ensureUserSubscriptionToken(adminUser, 'system')
    if (!tokenResult.success) {
      return { created: false, warning: tokenResult.error }
    }

    return { created: false }
  }
}

module.exports = new SubUserService()
