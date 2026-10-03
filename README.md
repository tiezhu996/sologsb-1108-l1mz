# 胶片冲洗参数库

面向黑白与彩色胶片冲洗者的本地参数管理工具。可以按乳剂批次登记胶片、记录显影液工作液寿命、编排冲洗配方，并把每次实冲温度、时间和样片结果沉淀为下一批次的修正依据。应用为纯前端单页应用，不需要后端服务或外部接口。

## Docker 一键启动

在项目根目录执行：

```bash
cp .env.example .env && docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 5 |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 本地数据 | Dexie 4 + IndexedDB |
| 容器 | Nginx Alpine + Docker Compose |

## 访问地址

浏览器打开：`http://localhost:21808`

如修改 `.env` 中的 `FRONTEND_PORT`，请使用修改后的端口。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

开发服务器默认地址为 `http://localhost:5173`。生产构建检查使用：

```bash
cd frontend
npm run build
```

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── README.md
└── frontend
    ├── Dockerfile
    ├── nginx.conf
    └── src
        ├── components/common   # 曲线、稀释、推拉标签与筛选组件
        ├── hooks               # 配方筛选与温度补偿
        ├── pages               # 五个业务页面
        ├── router              # 路由配置
        ├── stores              # 四类数据的 Pinia 状态与持久化动作
        ├── types               # 胶片、显影液、配方、冲洗记录模型
        └── utils               # Dexie 数据层、比例换算、JSON 导出
```

## 数据存储说明

- IndexedDB 数据库名：`gbfilmdev-db`
- Dexie 版本：`version(1)` 创建 `films`、`developers`、`recipes`、`runs` 四张表并建立常用查询索引。
- 迁移：
  - `version(2).upgrade(...)` 为已有记录回填 `schemaRev: 2`。
  - `version(3).upgrade(...)` 启用配方版本化与罐次生命周期：已有配方迁移为各自逻辑配方的初版（`recipeId = 原行 id`、`version: 1`、`status: 'published'`），已有实冲记录迁移为已完成罐次并绑定 `recipeVersion: 1`，同时回填胶片/显影液快照，历史数据不动。
- 首次打开数据库时通过 `populate` 写入丰富的胶片、显影液、配方（含一条待发布草稿）和实冲记录（等待/进行中/已完成三种状态）。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。

## 配方版本与冲洗排期规则

- **编辑留草稿**：修改配方只保存为草稿（每个配方至多一条），当前发布版本、进行中与历史罐次均不受影响。
- **发布换版**：发布草稿生成递增的新版本（新配方发布为 v1）。发布后等待开冲（`waiting`）的实冲改用新版本；进行中（`in_progress`）与已完成（`completed`）罐次继续按 `recipeVersion` 读取旧版。
- **物料变化重新确认**：新版本相对上一版更换了胶片批次（`filmId`）或显影液工作液（`developerId`）时，该配方下等待中的实冲清除确认状态；未重新确认不能开冲。仅温度/时间等参数变化时保留既有确认。等待罐次自身改胶片批次或显影液同样需要重新确认。
- **幂等发布**：每次发起发布生成 `publishToken`，发布动作整体包在单个 Dexie 事务内。发布失败时草稿与确认结果原样保留；用同一令牌重试不会重复生成版本。
- 逻辑校验脚本：`cd frontend && npm run test:versioning`（基于 fake-indexeddb，覆盖迁移、发布、确认与失败重试）。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，观察余量 |
| `/developers` | 显影液配制与余量 | 登记工作液、换算容量、查看剩余可冲卷数并标记报废 |
| `/recipes` | 配方表 | 编辑留草稿、按版本发布，查看版本历史，改温度即时重算时间 |
| `/runs` | 冲洗排期与结果评价 | 排入等待、物料确认、开冲/完成，按绑定版本追溯实冲依据 |

未匹配的路由会重定向到 `/`。
