# 常见问题

## 前端能打开但数据为空
请确认后端已启动，并且 `/sub/*` API 在同一域名/端口下可访问。

## 管理员接口返回 401/403
检查 `.env` 里的 `SUB_ADMIN_API_KEY`，并确认请求头带了正确的 Key。

## 数据库连接失败
使用 MySQL 时确认 `SUB_DB_CLIENT=mysql` 和 `MYSQL_*` 配置正确。
使用 PostgreSQL 时确认 `SUB_DB_CLIENT=postgres` 和 `POSTGRES_*` 或 `DATABASE_URL` 配置正确。

## Hysteria2 统计不可用
检查 `HY2_STATS_URL` 与 `HY2_STATS_SECRET`，或设置 `TRAFFIC_SYNC_ENABLED=false` 禁用。
