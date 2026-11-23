# 官方 SDK v5 取址模块 —— 来源与许可

本目录（`server/sdk-playback/`）用于调用红果官方 App 的 SDK 通道取视频播放模型
（1080P/720P HEVC + CENC 内容密钥）。它不是本项目原创代码，而是以下 GPL-3.0 作品的派生副本：

- 上游参考：`waligoraamodio288-rgb/hongguo-desktop-releases` v1.0.104 的
  `hongguo-1.0.104-third-party-sources.zip`（third-party sources）。
- 直接来源：`jackotom/hongguo-drama` 8.1，commit `b20413b`，目录
  `scripts/sdk-playback/`（GPL-3.0）。该版本是 2026-11-23 实测仍能取得 1080P 的实现。
- 更早的来源链见 `SOURCE.md`：woshishiq1/drpys → 上述第三方源码包。

## 本项目的改动
1. `resolve_cli.py` 增加 Windows 的 `msvcrt` 文件锁兼容层（生产 Docker 仍用 `fcntl`）。
2. 只保留 resolve 所需的最小模块闭包（14 个 `phone_*.py` + `vendor/*` + `medusa_wire_tables.json`），
   删除账号、社交、收藏等无关代码。
3. 由 `server/sdk-playback.mjs` 以子进程方式调用，排队/超时/错误分类由 Node 侧负责；
   Python 侧不做网络以外的账号操作。

## 许可
本模块与项目整体一致，按 **GPL-3.0-only** 分发；完整许可文本见仓库根目录 `LICENSE`。
`phone_account/vendor/TTEncrypt.py` 为 MIT 许可的 TTEncrypt 依赖（文件头保留原声明）。
如需再分发，请保留本 NOTICE、SOURCE.md、仓库根的 THIRD-PARTY-NOTICES.md 与上游署名。

## 安全边界
- 只允许访问 `https://mssdk.zijieapi.com/sdi/get_token` 与
  `https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1`
  两个 HTTPS 端点（见 `phone_sdk_session_v5.py` 的 route 白名单）。
- 首次运行会从官方 APK CDN 按 Range 下载约 5.4MB 素材，校验 SHA-256 后缓存到 `DATA_DIR/sdk-cache`。
- 素材下载域名白名单：`*.ugapk.cn`、`*.jspcdn.cn`。
