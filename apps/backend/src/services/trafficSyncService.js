/**
 * 流量同步服务
 * 定时从 Hysteria2 获取用户流量统计并更新到数据库
 */

const subscriptionStore = require('../models/subscriptionStore')
const logger = require('../utils/logger')
const { fetchHy2Traffic } = require('../utils/hy2StatsClient')

// 配置
const CONFIG = {
  hysteria2: {
    apiUrl: process.env.HY2_STATS_URL || 'http://127.0.0.1:9999',
    secret: process.env.HY2_STATS_SECRET || 'CHANGE_ME'
  },
  // 同步间隔（毫秒）- 默认 60 秒
  syncInterval: parseInt(process.env.TRAFFIC_SYNC_INTERVAL) || 60000,
  // 是否清除 Hysteria2 统计（获取后重置）
  clearStats: process.env.TRAFFIC_SYNC_CLEAR !== 'false'
}

class TrafficSyncService {
  constructor() {
    this.syncTimer = null
    this.isRunning = false
    this.lastSyncTime = null
    this.lastStats = {}
  }

  /**
   * 启动流量同步服务
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Traffic sync service is already running')
      return
    }

    this.isRunning = true
    logger.info(`✅ Traffic sync service started (interval: ${CONFIG.syncInterval / 1000}s)`)

    // 立即执行一次同步
    await this.syncTraffic()

    // 设置定时同步
    this.syncTimer = setInterval(async () => {
      await this.syncTraffic()
    }, CONFIG.syncInterval)
  }

  /**
   * 停止流量同步服务
   */
  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.isRunning = false
    logger.info('Traffic sync service stopped')
  }

  /**
   * 执行流量同步
   */
  async syncTraffic() {
    try {
      // 获取 Hysteria2 流量统计
      const stats = await this.getHysteria2Stats()

      if (!stats.success) {
        logger.debug(`Traffic sync: Hysteria2 stats unavailable - ${stats.error}`)
        return
      }

      // 更新用户流量
      const updateCount = await this.updateUserTraffic(stats.users)

      if (updateCount > 0) {
        logger.info(`📊 Traffic sync: Updated ${updateCount} users`)
      }

      this.lastSyncTime = new Date()
    } catch (error) {
      logger.error('Traffic sync error:', error)
    }
  }

  /**
   * 获取 Hysteria2 流量统计
   */
  async getHysteria2Stats() {
    try {
      const result = await fetchHy2Traffic({
        apiUrl: CONFIG.hysteria2.apiUrl,
        secret: CONFIG.hysteria2.secret,
        clear: CONFIG.clearStats,
        timeoutMs: 5000
      })

      if (!result.success) {
        throw new Error(result.error)
      }

      // Hysteria2 返回格式: { "userId": { "tx": 上传字节, "rx": 下载字节 } }
      // tx = 客户端上传 = 服务器接收
      // rx = 客户端下载 = 服务器发送
      return {
        success: true,
        users: result.data
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        users: {}
      }
    }
  }

  /**
   * 更新用户流量到数据库
   */
  async updateUserTraffic(usersStats) {
    let updateCount = 0

    try {
      await subscriptionStore.connect()

      for (const [userId, stats] of Object.entries(usersStats)) {
        // 跳过默认用户（兼容旧配置）
        if (userId === 'default') {
          continue
        }

        // tx = 上传（客户端发送到服务器）
        // rx = 下载（服务器发送到客户端）
        // 对于用户来说，主要关心的是下载流量（rx）
        const uploadBytes = stats.tx || 0
        const downloadBytes = stats.rx || 0
        const totalBytes = uploadBytes + downloadBytes

        if (totalBytes === 0) {
          continue
        }

        try {
          // 更新用户流量
          await subscriptionStore.updateTrafficUsed(userId, totalBytes)

          // 记录详细统计
          await subscriptionStore.recordUserStats(userId, {
            uploadBytes,
            downloadBytes
          })

          updateCount++

          logger.debug(`Traffic sync: User ${userId} +${this.formatBytes(totalBytes)} (↑${this.formatBytes(uploadBytes)} ↓${this.formatBytes(downloadBytes)})`)
        } catch (error) {
          // 用户可能不存在，忽略错误
          logger.debug(`Traffic sync: Failed to update user ${userId}: ${error.message}`)
        }
      }
    } catch (error) {
      logger.error('Traffic sync updateUserTraffic error:', error)
    }

    return updateCount
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      syncInterval: CONFIG.syncInterval,
      config: {
        hysteria2ApiUrl: CONFIG.hysteria2.apiUrl,
        clearStats: CONFIG.clearStats
      }
    }
  }

  /**
   * 手动触发同步
   */
  async manualSync() {
    logger.info('Traffic sync: Manual sync triggered')
    await this.syncTraffic()
    return { success: true, lastSyncTime: this.lastSyncTime }
  }
}

module.exports = new TrafficSyncService()
