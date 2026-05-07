# FAQ

## The frontend loads but data is empty
Make sure the backend is running and `/sub/*` is reachable from the same host/port.

## Admin API returns 401/403
Check `SUB_ADMIN_API_KEY` in `.env` and ensure the request header is set.

## Database connection failed
For MySQL, verify `SUB_DB_CLIENT=mysql` and `MYSQL_*` values.
For PostgreSQL, verify `SUB_DB_CLIENT=postgres` and `POSTGRES_*` or `DATABASE_URL` values.

## Hysteria2 stats are unavailable
Check `HY2_STATS_URL` and `HY2_STATS_SECRET`, or disable with `TRAFFIC_SYNC_ENABLED=false`.
