# 红果短剧 · 网页版

<p align="center">
  <a href="https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml"><img alt="docker" src="https://github.com/kid941005/hongguo-web/actions/workflows/docker.yml/badge.svg"></a>
  <a href="https://github.com/kid941005/hongguo-web/releases"><img alt="release" src="https://img.shields.io/github/v/release/kid941005/hongguo-web"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0--only-blue"></a>
  <a href="https://github.com/kid941005/hongguo-web/pkgs/container/hongguo-web"><img alt="ghcr" src="https://img.shields.io/badge/ghcr.io-hongguo--web-blue"></a>
</p>

<p align="center">
  <img src="docs/screenshots/home.png" alt="红果短剧网页版首页" width="88%">
</p>

<p align="center"><b>把红果短剧搬进浏览器。</b>一个 Docker 容器，自带内置源，也兼容糖葫芦（THLRedGuo / CatPaw）格式的 JS 源。</p>

> 仅供个人学习与自用。内容版权归各平台所有，请勿用于商业分发。

## 目录

- [为什么是它](#为什么是它)
- [功能](#功能)
- [截图](#截图)
- [快速开始](#快速开始)
- [部署方式](#部署方式)
- [配置](#配置)
- [使用指南](#使用指南)
- [自定义 JS 源](#自定义-js-源)
- [HTTP API](#http-api)
- [架构与目录](#架构与目录)
- [安全说明](#安全说明)
- [已知限制](#已知限制)
- [版本说明](#版本说明)
- [开发与自测](#开发与自测)
- [许可与致谢](#许可与致谢)

## 为什么是它

红果的网页端并不好直接看：官方播放接口要签名、视频是 CENC 加密、清晰度还分成 HEVC / VVC / H.264 几套编码。这个项目把这些麻烦都留在服务端：

- **浏览器只和本服务通信**：签名取址、CENC 解密、Range 转发、HLS 重写、VVC 转码都在容器里完成。
- **一个地址看全部**：首页、分类、搜索、推荐、猜你喜欢、详情、选集、播放、账号、历史、收藏、追更，一套 UI 全包。
- **不锁死在一个源**：内置红果之外，可以导入任意符合糖葫芦格式的单文件 JS 源，支持多源聚合搜索与播放失败自动换源。
- **自托管、可加固**：SQLite 存个人数据，命名卷持久化；容器默认非 root、只读根文件系统、丢弃全部 capability。

## 功能

| 模块 | 能力 |
| --- | --- |
| 内置红果源 | 服务端 V5 签名取址（SM3 + x-helios / x-medusa / x-ss-stub）+ CENC 分块解密 + Range 转发；1080P HEVC、720P VVC 服务端转码、360P H.264 兼容档，按浏览器解码能力自动选档；系列剧支持官方季表切换 |
| JS 源 | 单文件 spider，独立 worker 线程沙箱；网页内导入 / 自检 / 删除 / 自动更新；多源聚合搜索与播放失败换源 |
| 检索与发现 | 首页分类、分类分页、搜索、推荐页（四榜单真实评分合并）、猜你喜欢（协同过滤 + 相似题材 + 热门兜底）、无限滚动 |
| 播放 | HLS 多码率切档、当前分辨率徽标、倍速循环、全屏、下一集预取、跨集自动连播、播放失败诊断、替代源 |
| 个人数据 | 账号登录、观看历史 / 续播、收藏、追剧提醒、倍速偏好，跨设备同步（SQLite） |
| 界面 | 深色 / 浅色 / 跟随设备三档主题、响应式、移动端菜单抽屉、PWA |
| 运维 | /health、/api/metrics、/api/alerts、缓存清理、访问日志、Webhook 告警、离线自测 |
| 质量 | server/selftest.mjs 离线自测（182 断言），CI 构建镜像前先跑 |

## 截图

| 首页 | 推荐 |
| --- | --- |
| ![首页](docs/screenshots/home.png) | ![推荐](docs/screenshots/recommend.png) |

| 全屏播放 | 手机端 |
| --- | --- |
| ![全屏](docs/screenshots/fullscreen.png) | ![手机端](docs/screenshots/mobile.png) |

## 快速开始

### 前置条件

- Docker Engine 20.10+ 或 Docker Desktop（需要 docker compose v2）
- 能访问 ghcr.io。镜像已设为 Public，直接拉取无需登录；拉取慢时可先 docker login ghcr.io

### 三步启动

```bash
git clone https://github.com/kid941005/hongguo-web.git
cd hongguo-web
docker compose up -d
```

首次启动会拉取镜像并创建：

- 容器：hongguo-web
- 命名卷：hongguo-data（账号、历史、收藏、导入的源都在这里）

浏览器打开 <http://localhost:8787>。

### 确认部署成功

```bash
docker compose ps                       # STATUS 列应显示 healthy
docker compose logs -f                  # 实时日志，Ctrl+C 退出
curl -s http://localhost:8787/health
```

正常返回：

```json
{"service":"hongguo-web","ok":true,"version":"0.14.12","active":"hongguo","sources":7,"accounts":true,"tokenRequired":false}
```

启动后还可以跑仓库自带的冒烟脚本：

```bash
BASE=http://127.0.0.1:8787 node server/scripts/smoke.mjs
```

### 升级与卸载

```bash
docker compose pull && docker compose up -d   # 有新镜像时重建，数据保留
docker compose down                           # 停止并删除容器，数据卷保留
docker compose down -v                        # 连数据卷一起删（账号/历史/源全部丢失）
```

## 部署方式

### 用现成镜像（推荐）

仓库根目录的 [compose.yaml](compose.yaml) 默认使用 ghcr.io/kid941005/hongguo-web:latest。改端口、加口令、调并发都在这个文件里，改完 docker compose up -d 生效。

### 不克隆代码

任意空目录新建 compose.yaml：

```yaml
services:
  hongguo-web:
    image: ghcr.io/kid941005/hongguo-web:latest
    ports: ["8787:8787"]
    environment:
      TOKEN: ""                      # 需要访问口令就填
    volumes: ["hongguo-data:/app/data"]
    restart: unless-stopped
volumes:
  hongguo-data:
```

然后 docker compose up -d。

### 从源码构建

把 compose.yaml 里的 image: 注释掉、取消 build: . 的注释，然后：

```bash
docker compose up -d --build
```

完全不用 compose 时：

```bash
docker build -t hongguo-web .
docker run -d --name hongguo-web \
  -p 8787:8787 \
  -e PORT=8787 -e HOST=0.0.0.0 \
  -e DATA_DIR=/app/data -e SOURCES_DIR=/app/sources/builtin \
  -e TZ=Asia/Shanghai -e TOKEN= \
  -e MAX_STREAMS=6 -e ALLOW_PRIVATE_MEDIA=0 -e ALLOW_PRIVATE_FETCH=0 \
  -v hongguo-data:/app/data \
  --restart unless-stopped \
  --read-only --tmpfs /tmp --security-opt no-new-privileges --cap-drop ALL \
  hongguo-web
```

想固定版本就把镜像换成 ghcr.io/kid941005/hongguo-web:0.14.11。

### 镜像与标签

| 触发 | 标签 |
| --- | --- |
| push main | :edge |
| 打 v* 标签 | :版本号 与 :latest |
| 手动 workflow_dispatch | :edge |

镜像为 linux/amd64 + linux/arm64 多架构；构建前会先跑离线自测。构建记录见 Actions，镜像在 GitHub Packages。

## 配置

所有变量都可以写在 [compose.yaml](compose.yaml) 的 environment 里，也可以用同名环境变量覆盖。改完 docker compose up -d。

### 常用配置

| 需求 | 做法 |
| --- | --- |
| 换宿主机端口 | ports 改成 "9000:8787"（左=宿主机，右=容器） |
| 连容器端口一起换 | environment.PORT 与 ports 右边改成同一个值 |
| 加访问口令 | environment.TOKEN 填口令。浏览器里会直接弹出「需要访问口令」输入框（也可以 `http://<host>:8787/?at=<口令>` 打开），填一次记住，之后自动给接口和媒体地址带上 at= |
| 放大并发播放 | environment.MAX_STREAMS: "12" |
| 允许代理内网媒体 | environment.ALLOW_PRIVATE_MEDIA: "1"（默认拒绝，防 SSRF） |
| 改时区 | environment.TZ: "Asia/Shanghai" |
| 固定版本 | image 改成 ghcr.io/kid941005/hongguo-web:0.14.11 |

### 基础

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PORT | 8787 | 容器内监听端口 |
| HOST | 0.0.0.0 | 监听地址 |
| DATA_DIR | /app/data | 配置、用户源、缓存、账号库（hongguo.db）目录；必须可写并挂持久卷 |
| SOURCES_DIR | /app/sources/builtin | 内置源目录，镜像自带 |
| TOKEN | 空 | 设置后所有 /api/* 需带 `Authorization: Bearer <TOKEN>` 或 `?at=<TOKEN>`（`?token=` 兼容旧链接）；未设置时管理写接口与 /api/metrics 只接受内网来源 |

### 播放与转码

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| MAX_STREAMS | 6 | 内置红果解密流最大并发数 |
| ALLOW_PRIVATE_MEDIA | 空 | 1 时允许 /api/media、/api/hls 代理内网地址（默认拒绝，防 SSRF） |
| ALLOW_PRIVATE_FETCH | 空 | 1 时允许 JS 源 fetch 与按 URL 导入源访问内网地址（默认拒绝，防 SSRF） |
| TRUST_PROXY | 空 | 1 时按 X-Forwarded-For 第一跳识别客户端 IP；只在可信反向代理后开启，否则可被伪造 |
| HONGGUO_DEVICE_ID | 空 | 钉死红果播放通道的匿名设备号（10–20 位纯数字）；不设时首次注册后存 DATA_DIR/device.json 长期复用 |
| HONGGUO_INSTALL_ID | 空 | 配合 HONGGUO_DEVICE_ID 的 install id（10–20 位纯数字） |
| HONGGUO_OFFICIAL_UNSIGNED | 空 | 1 时改用旧的「无签名 + 注册身份」取址请求；仅在上游确已关闭签名校验时使用 |
| HONGGUO_MODEL_CACHE_MAX | 512 | 官方播放模型缓存条目上限（最小 16） |
| FFMPEG_PATH | ffmpeg | 服务端转码用的 ffmpeg；官方镜像已装 7.1+，裸机需自行安装 |
| TRANSCODE_MAX_INPUT_BYTES | 100663296 | 单集转码输入上限（默认 96 MB） |
| TRANSCODE_MAX_CONCURRENT | 2 | 同时进行的转码任务上限，超出返回 503 BUSY |
| TRANSCODE_READ_TIMEOUT_MS | 60000 | 单次读取上游的停滞超时（毫秒） |
| TRANSCODE_JOB_TIMEOUT_MS | 600000 | 单个转码任务硬超时（毫秒，最小 60000） |
| HLS_TC_TTL_MS | 1800000 | 转码产物保留时长（默认 30 分钟），到期清理 |

### JS 源沙箱

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| SOURCE_WORKER_MAX_OLD_MB | 64 | 每个源线程 V8 老生代上限（MB，最小 32） |
| SOURCE_WORKER_MAX_YOUNG_MB | 16 | V8 新生代上限（MB，最小 8） |
| SOURCE_WORKER_STACK_MB | 4 | 栈上限（MB，最小 2） |
| SOURCE_AUTO_UPDATE | 1 | 启动后自动检查 JS 源上游更新；0 关闭（内置源不参与） |
| SOURCE_UPDATE_INTERVAL_HOURS | 6 | 自动检查间隔（小时，最小 1） |
| SOURCE_UPDATE_START_DELAY_SECONDS | 15 | 启动后首次检查延迟（秒） |

### 播放通道监控

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PLAYBACK_MONITOR | 1 | 定时探针检测内置红果通道；0 关闭（/api/alerts 返回 enabled:false） |
| PLAYBACK_MONITOR_INTERVAL_MINUTES | 10 | 探针间隔（分钟，最小 1）；会真实取一集首块并校验 ftyp |
| PLAYBACK_ALERT_THRESHOLD | 3 | 连续失败多少次判定不可用并告警（最小 1） |
| ALERT_WEBHOOK_URL | 空 | 状态翻转时 POST JSON，可接钉钉/飞书/Slack 或自建收集端 |

## 使用指南

### 浏览、搜索与发现

- **顶栏**：桌面端为「外观 / 账号 / 历史 / 源」四组下拉；手机端收进右上角「☰ 菜单」抽屉，点一下展开全部分组。
- **首页 / 分类**：首页给分类与推荐，分类页分页浏览；首页、分类、搜索、推荐页都支持无限滚动，底部保留「加载更多」兜底。
- **推荐页**：把内置红果四个榜单（热播 / 真人 / 漫剧 / AI）按真实评分合并排序，卡片显示评分。
- **猜你喜欢**：基于观看历史的三路信号合并排序——协同过滤、相似题材、热门兜底；登录后跨设备一致，未登录只用本机历史做种子。
- **搜索**：红果内置源按「官网索引 → App 签名通道 → 首页推荐池」三级降级；官网索引每页 10 条，支持翻页；关键词超过 30 字按前 30 字检索。
- **多源聚合搜索**：源下拉框选「🔎 全部源（聚合搜索）」后搜索，所有可用源并发查询、谁先返回先展示，卡片带源名徽标；顶部提示条显示已返回源数、总条数与各源失败原因。模板与示例源不参与聚合。

### 播放与清晰度

- **选集**：点卡片 → 详情页选集；多线路先选线路。支持 HLS（m3u8）与 MP4 直链；flv 能识别但没有播放器。
- **多季**：内置红果系列剧在详情页显示「季」选择条，观看进度按季独立记录。
- **清晰度**：控制条常显当前解码分辨率徽标。点「清晰度」可查看档位；HLS master 多码率源支持自动 / 各档切换并尽量保持播放位置；单码率 HLS 与 MP4 直链只显示「该源仅此一种清晰度」，不伪造选项。
- **倍速**：0.5×–2× 首尾循环（点 1.0× 前进，逗号键反向），刷新和换集保持。
- **全屏**：按钮 / 双击画面 / F。
- **下一集预取**：接近结尾时后台预取下一集首段，点「下一集」更快。
- **跨集自动连播**：默认开启，可点「连播 开 / 连播 关」关闭；关闭后播完停在当前集并落盘进度。播放器会区分「假结束」与真片尾，假结束自动恢复当前集且每集只恢复一次。
- **播放失败排查**：浮层会区分「内容源暂时不可用 / 设备不支持 VVC / 解不了这一档画面 / 地址可用但播放异常」，并给出重试、切 360P 兼容或换源的对应操作。

### 账号与多设备同步

- **账号可选**：顶栏「账号」→ 登录 / 注册（用户名 3–20 位中英文数字下划线，密码 6–64 位）。不登录也能正常看剧。
- **观看历史 / 续播**：进度每 5 秒、暂停、关闭播放器时落盘（上限 100 条）；详情页显示续播条，已看过的集变暗。
- **收藏 / 追剧**：详情页可收藏、追更；追更定时检查集数变化，有新集时显示角标。
- **多设备同步**：历史、收藏、追更、倍速偏好存服务端 SQLite；本地历史与服务端按时间戳取新合并，旧进度不会覆盖新进度。

### 源管理

- **切换源**：顶栏「源」→「目前数据源」。
- **管理面板**：查看版本 / 类型 / 是否使用中，一键启用；「自检」做连通性检查（Shift 点击对内置红果真实取流校验首块 ftyp）；展开最近日志；删除导入源（内置源不可删）。
- **自动更新**：有上游地址的源显示开关；底部「检查源更新」可立即检查全部；更新失败保留旧版本并记录原因。
- **导入源**：「源」→「＋ 新增」，粘贴 HTTPS 源地址或直接粘贴 JS 源码；导入后先跑一次 home 自检，失败不保存。

### PWA 与快捷键

Chrome / Edge 地址栏会出现「安装」；手机浏览器「添加到主屏幕」后以独立窗口运行。Service Worker 需要安全上下文（https:// 或 http://localhost），局域网纯 HTTP 可用但没有离线缓存。

| 按键 | 作用 |
| --- | --- |
| 空格 / K | 播放 / 暂停 |
| ← / → | 后退 / 前进 5 秒 |
| ↑ / ↓ | 音量 ±10% |
| M | 静音切换 |
| F | 全屏 / 退出全屏 |
| , / . | 减速 / 加速（0.5×–2× 循环） |
| N | 下一集 |

快捷键在播放器打开时生效；焦点在输入框里时不拦截。

### 深链

```text
/?rec=1                                  推荐页
/?foryou=1                               猜你喜欢
/?source=qimao                           指定源
/?source=__all&q=总裁                    聚合搜索
/?source=qimao&id=5207                   剧集详情
/?source=qimao&id=5207&ep=0              直接播放第 1 集（从 0 计数）
```

## 自定义 JS 源

源是单个 .js 文件，声明一个全局 spider 对象。每个源在独立的 worker_threads 线程里运行（默认 64 MB 内存上限），只通过消息通道获得 fetch，拿不到 require / process / 文件系统等 Node API。

```js
var spider = {
  id: "my_source",                 // 唯一 id
  name: "我的源",                   // 显示名
  version: "1.0.0",                // 可选；给了就必须是 x.y.z
  updateUrl: "https://example.com/my_source.js", // 可选；HTTPS 上游地址

  home: function (filter, isFirst) {
    return {
      class: [{ type_id: "1", type_name: "全部" }],
      list: []                     // 可省略，服务端会用第一个分类兜底
    };
  },

  category: function (tid, page, filter, extend) {
    const list = [{
      vod_id: "id1",
      vod_name: "剧名",
      vod_pic: "https://…",
      vod_remarks: "更新至10集"
    }];
    const hasMore = list.length > 0;
    return { page: page, pagecount: hasMore ? page + 1 : page, hasMore: hasMore, list: list };
  },

  detail: function (id) {
    return {
      list: [{
        vod_id: id,
        vod_name: "剧名",
        vod_tag: "都市/甜宠",       // 可选，多个用 / 分隔
        vod_play_from: "线路A",     // 多个用 $$$
        vod_play_url: "第1集$ep1#第2集$ep2" // 集用 #，集名与集 ID 用 $
      }]
    };
  },

  search: function (wd, quick, page) {
    const list = [];
    const hasMore = false;
    return { page: page, pagecount: hasMore ? page + 1 : page, hasMore: hasMore, list: list };
  },

  play: function (flag, id, flags) {
    return "https://example.com/stream.m3u8"; // 或 { url, header }
  }
};
```

要点：

- 有网可用 await fetch(url, { headers, timeoutMs })；html.parse(...) 可用（支持 tag、.class、#id、tag.class、空格后代选择器）。
- updateUrl 必须是 HTTPS 且返回同一个 id 的源；更新前会跑一次 home + 首条详情自检，失败保留旧版本。按 URL 导入时即使 meta 没写 updateUrl，也会用导入地址作为上游。
- play 必须返回可直连的 m3u8 / mp4；flv 能识别但没有播放器。返回 parse: 1（需要 webview 嗅探）本服务不支持，会报「需要 webview 嗅探解析」。
- 分页建议返回 pagecount: hasMore ? page + 1 : page，并明确 hasMore；写死 page + 1 会让前端无限翻页。
- 除核心方法外还可选实现 feed / rankings / recommendations / rankingBoards / seriesSeasons / danmaku 等；目前对 JS 源只调用核心方法，内置红果的季表由服务端自行实现。
- 不得 import / require，不得访问 Node 内置模块或文件系统。

## HTTP API

所有错误统一返回 { error, code }。个人数据接口需登录并带 X-Auth-Token；应用级 TOKEN 支持 Authorization: Bearer 或 ?at=。

### 基础与运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 健康检查（含 accounts 是否启用账号系统） |
| GET | /api/metrics | 运行指标：uptime、RSS、取流尝试/失败/空响应、熔断、去重、通道计数、转码任务、官方设备状态 |
| GET | /api/alerts | 通道监控快照：status（ok / degraded / down / unknown）、失败次数、最近告警 |
| POST | /api/alerts/check | 立即跑一次通道探针 |
| POST | /api/cache/clear | 一键清缓存：首页 SWR、推荐池、vendor 缓存与官方播放模型缓存 |

### 认证与个人数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/auth/register | 注册：{ username, password } → { token, user } |
| POST | /api/auth/login | 登录：同上 |
| POST | /api/auth/logout | 注销当前令牌 |
| GET | /api/auth/me | 当前用户 |
| GET/PUT/DELETE | /api/me/history | 云端观看历史：列表 / 上报一条 / 清空 |
| DELETE | /api/me/history/:source/:id | 删除一条历史 |
| GET/POST | /api/me/favorites | 收藏列表 / 新增 |
| DELETE | /api/me/favorites/:source/:id | 取消收藏 |
| GET/POST | /api/me/follows | 追剧列表 / 新增 |
| DELETE | /api/me/follows/:source/:id | 取消追剧 |
| GET | /api/me/follows/updates?force=1 | 检查追更（默认 10 分钟节流） |
| GET/PUT | /api/me/prefs | 个人偏好（播放倍速） |

### 源管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/sources | 源列表 + 当前启用源 |
| POST | /api/sources/import | 导入源：{ url } 或 { code } |
| POST | /api/sources/active | 切换启用源：{ id } |
| GET | /api/sources/:id/log | 源最近运行日志 |
| GET | /api/sources/:id/health | 源健康检查；?deep=1 时内置红果走 home→detail→stream 真实取流 |
| DELETE | /api/sources/:id | 删除用户源（内置源不可删） |
| POST | /api/sources/check-updates | 立即检查所有可自动更新的 JS 源 |
| POST | /api/sources/:id/check-update | 立即检查单个源更新 |
| POST | /api/sources/:id/auto-update | 开关单个源自动更新：{ enabled: true } |

### 内容与播放

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/home?source=&page= | 首页（classes + items），带 SWR 语义（stale / age） |
| GET | /api/recommend?page= | 推荐页：四榜单按真实评分合并排序 |
| POST | /api/for-you | 猜你喜欢：{ seeds?, refresh? }；登录用户用云端历史做种子 |
| GET | /api/category?source=&tid=&page= | 分类列表 |
| GET | /api/search?source=&q=&page= | 搜索；source=__all（或 all=1）为多源聚合 |
| GET | /api/detail?source=&id= | 详情（标签、线路、剧集；内置红果系列剧带 seasons） |
| GET | /api/play?source=&flag=&id= | 取播放地址（{ type, url }；内置红果带 quality） |
| GET | /api/play/fallback?source=&id=&index= | 播放失败时的替代源，最多 3 个候选 |
| GET | /api/media?u=&r=&at= | 媒体透传（支持 Range，r 为 Referer） |
| GET | /api/hls?u=&r=&at= | HLS 清单重写（分片走 /api/media；重写出的子清单/分片地址自动带上同一 at，浏览器无需另加请求头） |
| GET/HEAD | /api/stream/:epId?q=&at=&vvc= | 内置红果分集流（服务端解密 + Range）；q 支持 auto / 1080p / 720p / 540p / 480p / 360p / compat |
| GET | /api/tc/:epId/:q/index.m3u8 | 内置红果 VVC 档的服务端 HLS 转码清单 |
| GET | /api/tc/:epId/:q/:file | 转码清单里的 init.mp4 / seg_NNNNN.m4s（支持 Range） |

### 错误码

常见 code：BAD_INPUT / BAD_JSON / BAD_URL（400）、UNAUTHORIZED / TOKEN_REQUIRED（401，后者=站点访问口令未填或不对）、PROTECTED（403）、NOT_FOUND（404）、USER_EXISTS（409）、CODEC_UNSUPPORTED（415）、RATE_LIMITED（429）、BUSY / UPSTREAM_COOLDOWN / UPSTREAM_EMPTY（503）、TIMEOUT（504），其余上游问题 502。凡「过一会儿再来」的码都带 Retry-After。

访问日志：每个 /api/* 请求与失败的静态请求写一条 {"event":"access",method,path,status,ms}；静态资源 200 不记，避免刷屏。

## 架构与目录

```text
hongguo-web/
├─ Dockerfile / compose.yaml / .dockerignore
├─ LICENSE
├─ .github/workflows/docker.yml     # GHCR 构建：main→:edge，tag→:版本+:latest
├─ docs/                            # research.md + screenshots/
├─ server/
│  ├─ index.mjs                     # 入口：装配 provider + 源管理 + 目录 + HTTP + 监控
│  ├─ provider.mjs                  # 内置红果取流编排 + 熔断
│  ├─ official.mjs                  # V5 签名取址、设备身份、档位解析
│  ├─ vendor/hongguo.cjs            # 红果解析核心（drpys 派生，GPL）
│  ├─ breaker.mjs                   # 上游熔断状态机
│  ├─ device.mjs                    # 设备身份持久化与轮换
│  ├─ catalog.mjs                   # 内置源与 JS 源归一成同一套 API
│  ├─ media.mjs                     # /api/media 透传 + /api/hls 重写
│  ├─ stream.mjs                    # /api/stream 解密流（Range、并发、去重）
│  ├─ transcode.mjs                 # VVC → H.264 转码核心
│  ├─ hls-tc.mjs                    # VVC 档 HLS 转码任务
│  ├─ monitor.mjs                   # 播放通道探针与告警
│  ├─ recommend.mjs                 # 推荐 / 猜你喜欢排序
│  ├─ db.mjs / users.mjs            # SQLite 与用户数据
│  ├─ http.mjs                      # 路由、鉴权、访问日志
│  ├─ selftest.mjs                  # 离线自测（182 断言）
│  └─ sources/                      # JS 源运行时、沙箱、管理
├─ sources/builtin/                 # qimao / xifan / xingya / niuniu / template / maccms
└─ web/                             # 前端静态页 + hls.js + PWA
```

技术栈：前端原生 JS + hls.js；后端 Node.js ESM；数据 SQLite（node:sqlite）；容器 node:22-trixie-slim + ffmpeg 7.1。

## 安全说明

- **访问口令**：公网部署务必设置 TOKEN。设了之后页面会弹「需要访问口令」输入框（PWA 从桌面图标打开也能填），也可用 `?at=<TOKEN>` 打开；填一次记住，之后接口与媒体地址自动带参。入口在「账号 → 🔑 口令」，可改可清。未设置 TOKEN 时，源导入/删除/更新/自检/日志、清缓存、告警检查等管理写接口只接受内网来源；「切换当前源」是普通操作，不受此限制（顶栏下拉框人人可点）。
- **反向代理**：只有确认前面是可信代理时才设 TRUST_PROXY=1，否则 X-Forwarded-For 可被伪造。
- **SSRF**：默认禁止代理内网媒体、禁止 JS 源访问内网；确有需要再分别打开 ALLOW_PRIVATE_MEDIA / ALLOW_PRIVATE_FETCH。
- **JS 源沙箱**：每源独立 worker_threads，有内存与超时限制，拿不到 Node API；但源代码仍由你导入，请只安装可信来源。
- **容器加固**：官方 compose 默认 read_only、tmpfs /tmp、cap_drop ALL、no-new-privileges、非 root 运行。

## 已知限制

- **内置红果搜索**：主通道是官网搜索 JSON 接口；失败才降级首页推荐池检索（fallback:true、结果不全）。
- **需要 webview 嗅探的源（parse: 1）不可用**：本服务没有浏览器内核。
- **同时播放上限**：内置红果解密流默认 6 路并发（MAX_STREAMS 可调）；同一集同一档位多人同时点开只取址一次。
- **红果档位与编码**：1080P 是 HEVC（需设备/浏览器支持），360P 是 H.264；官方 360P–720P 中间档是 H.266/VVC，浏览器没有解码器，只有服务端装了 ffmpeg 7.1+ 才转成 H.264 HLS。转码约 12× 实时（单核），并发多了会排队。
- **红果加密格式**：只支持 CENC（AES-128-CTR）、每样本 8 字节 IV、无 subsample、moov 前置的非分片 MP4；上游若改格式会返回 CENC_UNSUPPORTED，而不是花屏。
- **官方取址会被限流**：按匿名设备身份 + 出口 IP 双重限流，空正文 / 403 / 429 会进入冷却并回落 360P；这是有意为之，避免把 IP 打进惩罚窗。
- **替代源依赖同名剧**：按标题相似度跨源匹配；红果独播剧、译名差异大的剧通常找不到候选。
- **账号数据库**：DATA_DIR/hongguo.db；必须挂持久卷，备份直接拷这个文件（建议先停容器）。
- **PWA**：Service Worker 只在 https:// 或 http://localhost 启用；局域网纯 HTTP 可用但没有离线缓存、不能安装。
- **清晰度取决于源**：只有提供 master playlist 的 HLS 源才有档位可切；单码率 HLS 与 MP4 直链只有一项。
- **推荐页首次加载慢**：需要抓四个榜单共 20 页（约 10 秒），结果缓存 10 分钟。
- **聚合搜索耗时**：各源并发、先回先展示；单源上限 12 秒（内置红果 30 秒），超时只丢该源并在提示条注明。
- **JS 源沙箱**：默认 64 MB 内存上限；死循环/超时/内存超限自动终止该源线程，下次调用自动重启。
- **源自动更新**：只对 HTTPS 上游的用户 JS 源生效；内置源随镜像升级，不参与自动更新。

## 版本说明

最新发布见 [Releases](https://github.com/kid941005/hongguo-web/releases)。main 对应 :edge；正式版本打 v* 标签并同时推 :版本号 与 :latest。

- **v0.14.12**：修复播放加载提示误报。原来起播 8 秒没出画面就弹「播放加载超时（8 秒未响应），可能是当前数据源受限」，冷启动转码或 NAS 上行较慢时（720P 服务端转码首块常见 8–15 秒）会把「慢」误判成「坏」。现在分两级：8 秒还没数据只在底部提示「网络较慢，正在加载，请稍候…」，HLS/服务端转码 25 秒、直连 15 秒仍收不到任何数据才弹错误横幅；期间只要拿到元数据或缓冲数据就自动撤销监测。同时修复换集/切清晰度/深链自动起播时 `play()` 被新 load 取代抛出的 `AbortError` 被当成「播放失败」弹出的误报。
- **v0.14.11**：新增「访问口令门」：设了 TOKEN 的实例打开页面先弹口令输入框（首页不再刷成一屏 401），口令填对即记住并自动重载；登录/注册被口令拦住时提示「本站需要访问口令」并引导填写；菜单「账号 → 🔑 口令」可随时重填或清除。服务端 `/health` 增 `tokenRequired` 字段，口令失败改用独立业务码 `TOKEN_REQUIRED`（仍是 401），前端据此区分「站点要口令」与「账号登录态失效」。本机 8787 容器已升级到该版本（`docker compose up -d` 后 `/health` 报 `0.14.11`，冒烟 7/7 通过）。
- **v0.14.10**：`/api/sources/active` 不再按管理写拦截：切换当前源属于普通操作（不执行脚本），未设 TOKEN 的公网反代部署下前端切源不再 403；源导入/删除/更新/自检/日志仍只对内网开放。
- **v0.14.9**：全项目审计修复：设 TOKEN 时 JS 源 HLS 子清单/分片请求 401、`HEAD /api/media` 上游连接悬挂、`/api/play` 响应泄漏源侧 headers 与上游直链、写接口非对象 body 报 500、追更失败无退避与集数抖动误报、JS 源 URL 垫片不保真、历史封面不走代理、历史弹窗文案、Service Worker 缓存 `/health`、`engines` 版本与重复 CSS。
- **v0.14.8**：PWA 版本探测：窗口回到前台或重新获得焦点时比对 `/health` 与服务端版本，发现新版本自动整页刷新，常驻 PWA 不再停留在旧界面。
- **v0.14.7**：手机播放器工具条重排：4 列网格换行，取消横向滚动，关闭/下一集始终可见；≤420px 小字号，≤340px 三列且关闭独占一行；手机端清晰度按钮去掉括号说明。
- **v0.14.6**：倍速按钮改为首尾循环，2× 后可回到 0.5× 并继续到 1×；未知倍速归一到 1×。
- **v0.14.5**：手机端顶栏收进「菜单」抽屉，顶栏高度 166→138px；抽屉内分组直出、42px 大按钮，≤370px 两列。
- **v0.14.4**：全项目审计修复：转码看门狗与任务硬超时、内置源防覆盖、无 TOKEN + 反代鉴权加固、官方取址冷却与缓存上限、设备身份持久化等。
- **v0.14.3**：红果官方取址改用 V5 签名（SM3 + x-helios / x-medusa / x-ss-stub），恢复 720P 转码 / 1080P HEVC 档位。
- **v0.14.2**：带签名的 video_tab 取址 + 平台匿名一次性设备身份。
- **v0.14.1**：镜像换 node:22-trixie-slim + ffmpeg 7.1，新增 VVC → H.264 服务端转码。

## 开发与自测

改密钥派生、分块解密、播放签名这类「改一行就可能让所有播放失效」的代码前后，先跑离线自测（不联网、不读 data/）：

```bash
docker run --rm -v "$PWD":/w -w /w node:22-trixie-slim sh -c \
  "corepack enable && pnpm --prefix server install --prod --frozen-lockfile && node server/selftest.mjs"
```

本机有 Node 22.13+ 时也可以（node:sqlite 在 22.5–22.12 仍需 --experimental-sqlite）：

```bash
pnpm --prefix server install --prod --frozen-lockfile
node server/selftest.mjs
```

黄金向量钉住的是「当前已验证行为」：上游 vendor 换算法时它会失败，这是预期——先人工确认新算法，再更新向量。

发布冒烟：

```bash
BASE=http://127.0.0.1:8787 node server/scripts/smoke.mjs
```

## 许可与致谢

- 本项目代码：[GPL-3.0-only](LICENSE)。
- server/vendor/hongguo.cjs 派生自 [drpys](https://github.com/drpys) 的实现，遵循 GPL；详见 server/vendor/LICENSE.drpys、LICENSE.template-tv、NOTICE.md。
- 上游调研与可行性验证过程见 [docs/research.md](docs/research.md)。
- 感谢糖葫芦（THLRedGuo / CatPaw）的 JS 源格式，以及所有上游开源实现。
