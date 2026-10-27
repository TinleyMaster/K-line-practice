# 部署说明

前提：应用与 PostgreSQL 在同一台机器（或同内网），Node.js ≥ 20.19。

---

## 1. 拉代码与配置

```bash
cd /opt
git clone <repo> kline-practice
cd kline-practice

npm ci                 # 安装 server + web 全部依赖
cp .env.example .env   # 真实 DATABASE_URL 填这里（不要提交）
```

`.env` 关键项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | `postgresql://user:pass@127.0.0.1:5432/crypto?sslmode=require` |
| `PORT` / `HOST` | 默认 8787 / 0.0.0.0 |
| `SOURCE_SCHEMA` / `SOURCE_TABLE` | 原库 K 线表，默认 `biz` / `asset_klines` |
| `PRACTICE_SCHEMA` | 本项目写入 schema，默认 `practice` |
| `AUTO_INIT_DB` | 生产建议 `false`，改用 `db:init` 手动建表 |
| `AUTO_MIGRATE` | 启动时自动跑增量迁移，默认 `true`。补列是纯增量全幂等，**老库升级必须开** |

### SSL 说明（踩坑点）

pg ≥ 8.23 会把连接串里的 `sslmode=require` 当作 `verify-full`，遇到自签证书直接报
`DEPTH_ZERO_SELF_SIGNED_CERT`。本项目已在 `server/src/db.js` 内部把
`require` / `prefer` / `verify-ca` 自动翻译为 pg 专用的 `no-verify`（仍走 TLS 加密，只是不校验证书链）。

若要严格校验证书：连接串改用 `sslmode=verify-full` 并配置 `sslrootcert`，
或设置 `DB_SSLMODE_OVERRIDE=verify-full`。

---

## 2. 建表、种子、物化

```bash
npm run db:init        # 建 practice schema 的 9 张表 + 跑迁移（幂等）
npm run db:seed        # 练习白名单（按近30天成交额取前60）+ 5 套开仓设置
npm run db:materialize # 物化 1h K 线到 practice.klines
```

`db:materialize` 是幂等增量：

```bash
# 全量物化白名单（并发 6）
npm run db:materialize -- 6
# 只物化前 10 个（试水）
npm run db:materialize -- 6 10
```

物化后 `practice.klines` 约 200 万行 / 300MB 级别，读取 < 50ms。

---

## 2.1 升级已有部署（v1~v5 → v6）

```bash
cd /opt/kline-practice
git pull
npm ci
npm run db:migrate     # 补 v6 的列（幂等，跑完自检 9 个关键列）
npm run build          # 重新构建前端（v6 改了前端）
sudo systemctl restart kline-practice
```

**为什么 `db:migrate` 不能省**：
`db:init` 里的 `CREATE TABLE IF NOT EXISTS` 对**已存在的表是 no-op** ——
老库的 `trades` 表不会自动多出 13 个新列（开仓设置扩展字段），
`sessions` / `journal_entries` 也不会自动多出 `user_id`。
漏跑迁移的症状：登录/注册 500、`trades` 落库报 `column "entry_mode" does not exist`。

> `AUTO_MIGRATE=true`（默认）时，服务启动也会自动跑一遍迁移 —— 相当于双保险。
> 生产若显式关掉它，就**必须**手动跑 `npm run db:migrate`。
> `db:init` 里也已内置 `migrateV6`，所以 `npm run db:init` 同样能覆盖。

---

## 3. 构建与启动

```bash
npm run build          # 构建前端到 web/dist
./deploy/start.sh      # 或 npm start
```

单进程同时提供 API 与静态页面，监听 `PORT`（默认 8787）。

---

## 4. 守护进程（systemd）

```bash
sudo cp deploy/kline-practice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kline-practice
sudo systemctl status kline-practice
journalctl -u kline-practice -f
```

> `WorkingDirectory` / `ExecStart` 里的路径按实际部署位置改。

---

## 5. 反向代理（Nginx，可选）

```nginx
server {
    listen 80;
    server_name kline.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # K 线 JSON 较大，放宽缓冲
        proxy_buffering off;
        client_max_body_size 4m;
    }
}
```

---

## 6. 日常运维

| 需求 | 命令 |
|---|---|
| 更新 K 线（增量补最新） | `npm run db:materialize -- 6` |
| 查看内存缓存 | `curl http://127.0.0.1:8787/api/klines/_cache/stats` |
| 清缓存 | `curl -X DELETE http://127.0.0.1:8787/api/klines/_cache/BTCUSDT` |
| 健康检查 | `curl http://127.0.0.1:8787/api/health` |
| 增删练习标的 | 直接改 `practice.symbols` 表，或用 `PATCH /api/symbols/:symbol` |

---

## 7. 数据安全红线

- `biz.asset_klines` **只读**。本项目代码中没有任何针对该表的 INSERT/UPDATE/DELETE/DDL。
- 所有写入落 `practice` schema。
- 本项目**不会**在原表上建索引（会改变原项目存储与执行计划）。
- `DATABASE_URL` 含明文口令，只放 `.env`（已 gitignore），不要写进代码、文档或提交记录。
