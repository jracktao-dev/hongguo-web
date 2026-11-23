# 第三方组件与来源声明

本项目整体以 **GPL-3.0-only** 分发（见 [LICENSE](LICENSE)）。以下组件来自第三方，按原许可使用并保留署名。

## 1. server/vendor/hongguo.cjs

- 来源：`woshishiq1/drpys` 的 `spider/js/红果果[短].js`（GPL-3.0）。
- 本项目对其做了适配性修改（导出封装、Node 侧注入等），详见同目录 `LICENSE.drpys` / `LICENSE.template-tv` / `NOTICE.md`。
- 许可：GPL-3.0-only。

## 2. server/sdk-playback/

- 来源链：`woshishiq1/drpys` → `waligoraamodio288-rgb/hongguo-desktop-releases` v1.0.104 third-party sources → `jackotom/hongguo-drama` 8.1（commit `b20413b`）的 `scripts/sdk-playback/`。
- 本项目改动：增加 Windows 文件锁兼容、裁剪为最小取址闭包、由 Node 子进程调度；详见 `server/sdk-playback/NOTICE.md` 与 `SOURCE.md`。
- 其中 `phone_account/vendor/TTEncrypt.py` 为 MIT 许可的 TTEncrypt 实现，文件头保留原声明。
- 许可：GPL-3.0-only（TTEncrypt.py 除外，MIT）。

## 3. 前端依赖

- `web/vendor/hls.light.min.js`：hls.js 1.5.x（Apache-2.0），文件头保留原版权声明。
