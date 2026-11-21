import path from "node:path";
import axios from "axios";
import { gzipSync } from "node:zlib";
import { randomBytes, createHash } from "node:crypto";
import argus from "./sign/argus.cjs";
import v5 from "./sign/v5.cjs";
import { fileURLToPath } from "node:url";
import { createDeviceStore } from "./device.mjs";

// 红果（番茄小说 App，aid=8662）官方播放取址。
//
// 2026-11-16 复核（对齐 jackotom/hongguo-drama 与 tsukiyo-zero/hongguoTV 的可用实现）：
//   0) 2026-11-20 起首选「V5 无正文 GET video_tab」（x-khronos/x-helios/x-medusa，不带 x-ss-stub/_rticket 之外的正文头），
//      这是目前唯一稳定返回 1080P/720P 全档位的通道；下面的 V5 POST 与旧 x-argus 链路只作兜底。
//   1) 旧链路必须带完整签名头（x-argus / x-ladon），且必须使用「平台匿名注册的一次性设备身份」；
//      server/sign/argus.cjs 与参考实现的 x-argus / x-ladon 逐字节一致（20 组 GET/POST 用例）。
//   2) 首选签名 GET /reading/bookapi/video_tab/multi_video_model/v1/；
//      仅当返回空正文时才补发一次签名 POST /novel/player/multi_video_model/v1/（旧链路）。
//   3) 同一设备身份第二次取址会被回 0 字节，所以每次取址重新注册（60 秒内复用，避免把注册接口打成风控）。
//   4) 空正文 = 风控/限流：全局冷却，冷却期内直接回落 360P 兼容通道，绝不重试轰炸。
// 紧急回退：HONGGUO_OFFICIAL_UNSIGNED=1 时改用旧的「无签名 + 注册身份」请求（仅在确认上游放开时使用）。
const MODEL_HOST = "https://api5-normal-sinfonlineb.fqnovel.com";
const MODEL_PATH = "/novel/player/multi_video_model/v1/";
const TAB_HOST = "https://api5-normal-sinfonlineb.fqnovel.com";
const TAB_PATH = "/reading/bookapi/video_tab/multi_video_model/v1/";

// ── V5 签名取址（2026-11-16 上游启用；旧 x-argus/x-ladon 已被判伪造，回 200 空正文）──
// 参考 jackotom/hongguo-drama 7.5 与 N3urda/hongguoTV / drpys：POST player/v1，
// 每发用 SM3 + x-helios/x-medusa/x-ss-stub 签名，设备档改用 PGT-AN10 / Android 12 / 7.4.3.32。
const PLAYER_HOST = "https://api5-normal-sinfonlineb.fqnovel.com";
const PLAYER_PATH = "/novel/player/multi_video_model/player/v1";
const V5_DEVICE = {
  aid: "8662",
  app_name: "novelread",
  version_code: "74332",
  version_name: "7.4.3.32",
  channel: "vivo_8662_64",
  device_platform: "android",
  device_type: "PGT-AN10",
  os_version: "12",
  update_version_code: "74332",
};
const V5_UA =
  "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)";
const signPlaybackV5 = v5.signPlaybackV5;

// 空响应后的全局冷却：这段时间内不再打上游，直接让调用方回落 360P 兼容通道。
const EMPTY_COOLDOWN = 90 * 1000;

// 参考实现的设备基座（红果 7.1.3.32 / Redmi 25053RT47C 匿名档）。
// 注意：video_tab 用 73932 播放器版本、旧 POST 链路用 74332，两处版本不同，不能混用。
const BASE_DEVICE = {
  ac: "wifi",
  channel: "update_64",
  aid: "8662",
  app_name: "novelread",
  version_code: "71332",
  version_name: "7.1.3.32",
  device_platform: "android",
  os: "android",
  ssmix: "a",
  device_type: "25053RT47C",
  device_brand: "Redmi",
  language: "zh",
  os_api: "36",
  os_version: "16",
  manifest_version_code: "71332",
  resolution: "1280*2772",
  dpi: "520",
  update_version_code: "71332",
  host_abi: "arm64-v8a",
  dragon_device_type: "phone",
  pv_player: "71332",
  compliance_status: "0",
  need_personal_recommend: "1",
  player_so_load: "1",
  is_android_pad_screen: "0",
};
const VIDEO_TAB_DEVICE = {
  ...BASE_DEVICE,
  version_code: "73932",
  version_name: "7.3.9.32",
  manifest_version_code: "73932",
  update_version_code: "73932",
  pv_player: "73932",
};
const PLAYBACK_DEVICE = {
  ...BASE_DEVICE,
  version_code: "74332",
  version_name: "7.4.3.32",
  manifest_version_code: "74332",
  update_version_code: "74332",
  pv_player: "74332",
};

// UA 里的版本号必须与 device.version_code 同步（参考实现就是 replace 出来的）。
const VIDEO_UA_TEMPLATE =
  "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; " +
  "Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";

const UA = VIDEO_UA_TEMPLATE.replace("71332", "73932");
// 旧无签名兜底路径沿用的参数名（等价映射）。
const DEVICE_PARAMS = PLAYBACK_DEVICE;
const TAB_DEVICE_PARAMS = BASE_DEVICE;

const BIZ_PARAM = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

const MODEL_TTL = 10 * 60 * 1000; // 模型缓存 10 分钟（签名 URL 有效期约 6 小时）
const MODEL_FAIL_TTL = 10 * 1000; // 失败缓存 10 秒，避免反复打上游风控
const DEVICE_TTL = 6 * 60 * 60 * 1000;
const MODEL_TIMEOUT = 12000;

// 质量档位：按分辨率从高到低，前端清晰度菜单直接用。

// 与 Python urllib.parse.quote / 官方客户端的编码保持一致（额外转义 !'()），
// 因为 x-argus 的 query hash 覆盖整串 query，编码方式必须与实际 URL 完全相同。
function encodeValue(value) {
  return encodeURIComponent(String(value == null ? "" : value)).replace(/[!'()]/g, (ch) =>
    "%" + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildQuery(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => encodeValue(key) + "=" + encodeValue(value))
    .join("&");
}

export function dataDir() {
  const fromEnv = process.env.DATA_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
}

// 纯函数：给定集号/身份/时间戳即可算出签名请求（导出以便 selftest 用金标向量对拍）。
export function signPlaybackRequest({ epId, identity, ts, ticket, randField, ladonRandom, legacy }) {
  // 未显式给出时生成随机源（生产路径），测试时传入固定值以便对拍。
  if (randField === undefined || randField === null) randField = randomBytes(4).readInt32LE(0);
  if (!ladonRandom) ladonRandom = randomBytes(4);
  else if (!Buffer.isBuffer(ladonRandom)) ladonRandom = Buffer.from(ladonRandom);
  const device = legacy ? PLAYBACK_DEVICE : VIDEO_TAB_DEVICE;
  const base = { ...device, device_id: identity.device_id, iid: identity.iid };
  if (identity.cdid) base.cdid = identity.cdid;
  const values = legacy
    ? {}
    : {
        video_id: String(epId),
        video_id_type: "0",
        device_level: "1",
        need_all_video_definition: "1",
        need_mp4_align: "0",
        use_os_player: "0",
        video_platform: "1024",
        source: "0",
        from_video_id: "",
      };
  const query = buildQuery({ ...base, ...values, ts: String(ts), _rticket: String(ticket) });
  const payload = JSON.stringify({
    biz_param: BIZ_PARAM,
    mixed_video_id_map: { 1004: [String(epId)] },
  });
  const body = legacy ? gzipSync(Buffer.from(payload, "utf8")) : null;
  // x-ss-stub 是「请求体（gzip 后字节）的 md5」，大写。
  const stub = body ? createHash("md5").update(body).digest("hex") : "";
  // ★ installId 必须传空串：带上 iid 时 x-argus 直接判伪造，上游回 200 空正文。
  const headers = {
    "User-Agent": VIDEO_UA_TEMPLATE.replace("71332", device.version_code),
    Accept: "application/json; charset=utf-8,application/x-protobuf",
    "x-ss-req-ticket": String(ts * 1000),
    "sdk-version": "2",
    "x-xs-from-web": "0",
    "passport-sdk-version": legacy ? "5051452" : "50561",
    "x-ss-dp": String(device.aid),
    "x-khronos": String(ts),
    "x-ladon": argus.Ladon.encrypt(ts, argus.PlayerSigner.LICENSE_ID, 8662, ladonRandom),
    "x-argus": argus.Argus.sign(
      query,
      stub,
      ts,
      8662,
      argus.PlayerSigner.LICENSE_ID,
      identity.device_id,
      "",
      randField
    ),
    "x-tt-dt": "",
    "x-tt-store-region": "cn",
    "x-tt-store-region-src": "did",
  };
  if (body) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    headers["Content-Encoding"] = "gzip";
    headers["x-ss-stub"] = stub;
  } else {
    headers["x-tt-request-tag"] = "t=0;n=0";
  }
  return {
    url: (legacy ? MODEL_HOST + MODEL_PATH : TAB_HOST + TAB_PATH) + "?" + query,
    method: legacy ? "post" : "get",
    body,
    headers,
  };
}

export function createOfficial({ register, deriveContentKey, devices } = {}) {
  if (typeof register !== "function" || typeof deriveContentKey !== "function")
    throw new Error("createOfficial 需要 register / deriveContentKey");

  const cache = new Map(); // epId -> { time, value } | { time, error }
  const CACHE_MAX = Math.max(16, Number(process.env.HONGGUO_MODEL_CACHE_MAX || 512) || 512);
  // 写入统一走这里：刷新插入顺序 + 超上限时淘汰最旧，避免长期运行内存单调增长。
  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      cache.delete(oldest);
    }
  }
  const inflight = new Map(); // epId -> Promise（同一集并发请求只打一次上游）
  // 设备身份（B3）：持久化 + 校验 + 节流轮换都交给 device.mjs，
  // 这里只负责「什么时候用旧身份、什么时候必须换」。
  // 身份仓库允许由调用方注入：搜索通道与播放通道必须共用同一份设备身份，
  // 否则两个通道各自注册、各自轮换，等于凭空多一倍设备 churn（更容易撞风控）。
  const store =
    devices ||
    createDeviceStore({
      file: path.join(dataDir(), "device.json"),
      envId: process.env.HONGGUO_DEVICE_ID,
      envIid: process.env.HONGGUO_INSTALL_ID,
      register,
    });

  const stats = { requests: 0, ok: 0, empty: 0, signed: 0, failed: 0, rotated: 0, lastError: "", lastErrorAt: 0, registered: 0, invalidated: 0 };
  // 空响应后的全局冷却截止时间（见 EMPTY_COOLDOWN）。
  let quietUntil = 0;
  // 播放取址用的「一次性设备身份」（含 cdid）。60 秒内复用，避免每发都注册把注册接口打成风控。
  let playIdentity = null;
  let playIdentityAt = 0;
  // 设备身份现状随 /api/metrics 一起暴露（source / 轮换次数 / 被节流次数），只含脱敏设备号。
  Object.defineProperty(stats, "device", {
    get: () => {
      const base = store.stats();
      const id = playIdentity && playIdentity.device_id ? String(playIdentity.device_id) : "";
      // 播放通道用一次性身份（register 直取），脱敏后暴露给 /api/metrics，便于确认「真的每次换新身份」。
      const masked = id ? (id.length <= 8 ? "***" : id.slice(0, 4) + "***" + id.slice(-3)) : "";
      return { ...base, playDevice: masked, playDeviceAt: playIdentityAt };
    },
    enumerable: true,
  });
  Object.defineProperty(stats, "cooldown", {
    get: () => ({ active: Date.now() < quietUntil, until: quietUntil }),
    enumerable: true,
  });

  function markError(error) {
    stats.failed += 1;
    stats.lastError = String((error && error.message) || error).slice(0, 300);
    stats.lastErrorAt = Date.now();
  }

  // 播放取址的身份：必须带 cdid（与注册 payload 同一份），且每次取址尽量用新身份。
  // register() 就是 vendor 的 registerPlaybackDevice（本地已改为返回 cdid）。
  // 60 秒内复用同一身份，避免每发都注册、把注册接口打成风控。
  async function getPlayIdentity(fresh = false) {
    if (!fresh && playIdentity && Date.now() - playIdentityAt < 60 * 1000) return playIdentity;
    let identity;
    const pinned = String(process.env.HONGGUO_DEVICE_ID || "").trim();
    if (pinned) {
      // store 里的身份是共享对象：浅拷贝后再补 cdid，避免把一次性 cdid 写回长期身份。
      identity = { ...(await store.get({ maxAgeMs: DEVICE_TTL })) };
      if (!identity.cdid)
        identity.cdid = randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    } else {
      identity = await register();
      stats.registered += 1;
    }
    playIdentity = identity;
    playIdentityAt = Date.now();
    return identity;
  }

  // 非签名兜底路径统一走持久化身份仓库（旧行为，只在 HONGGUO_OFFICIAL_UNSIGNED=1 时用）。
  async function getPlainIdentity(fresh = false) {
    const identity = fresh
      ? await store.refresh("fresh")
      : await store.get({ maxAgeMs: DEVICE_TTL });
    if (identity.source !== "env") stats.registered = store.stats().registers;
    return identity;
  }

  function parseModel(text, epId) {
    const root = JSON.parse(text);
    if (!root || typeof root !== "object") throw new Error("model 响应不是对象");
    const code = Number(root.code != null ? root.code : root.Code != null ? root.Code : 0);
    if (code !== 0) throw new Error("model 返回错误码 " + code);
    const data = root.data || {};
    // 只认本集条目：以前缺条目时静默回落到第一条，会把「第 30 集」播成「第 1 集」（review S7）。
    const entry = data[String(epId)];
    if (!entry || typeof entry !== "object") throw new Error("model 响应缺少本集条目");
    let model = entry.video_model;
    if (typeof model === "string") model = JSON.parse(model);
    if (!model || !Array.isArray(model.video_list) || !model.video_list.length)
      throw new Error("model 没有 video_list");
    return model;
  }

  // video_tab 的响应结构与 multi_video_model 不同：data.video_model_data[epId].video_model。
  function parseTabModel(text, epId) {
    const root = JSON.parse(text);
    if (!root || typeof root !== "object") throw new Error("video_tab 响应不是对象");
    const code = Number(root.code != null ? root.code : root.Code != null ? root.Code : 0);
    if (code !== 0) throw new Error("video_tab 返回错误码 " + code);
    const data = root.data || {};
    const rows = data.video_model_data || data;
    const entry = rows && typeof rows === "object" ? rows[String(epId)] : null;
    if (!entry || typeof entry !== "object") throw new Error("video_tab 响应缺少本集条目");
    let model = entry.video_model;
    if (typeof model === "string") model = JSON.parse(model);
    if (!model || !Array.isArray(model.video_list) || !model.video_list.length)
      throw new Error("video_tab 没有 video_list");
    return model;
  }

  // player/v1 的响应结构：data['1004'][epId].video_model（或 data.video_model_data[epId]）。
  function parsePlayerModel(text, epId) {
    const root = JSON.parse(text);
    if (!root || typeof root !== "object") throw new Error("player 响应不是对象");
    const code = Number(root.code != null ? root.code : root.Code != null ? root.Code : 0);
    if (code !== 0) throw new Error("player 返回错误码 " + code);
    const data = root.data || {};
    const rows = data["1004"] || data.video_model_data || data;
    const entry = rows && typeof rows === "object" ? rows[String(epId)] : null;
    if (!entry || typeof entry !== "object") throw new Error("player 响应缺少本集条目");
    let model = entry.video_model;
    if (typeof model === "string") model = JSON.parse(model);
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("player 没有 video_model");
    if (!Array.isArray(model.video_list) || !model.video_list.length) throw new Error("player 没有 video_list");
    return model;
  }

  // ── 签名请求（主路径）：query / header / body 与参考实现逐字段一致 ──────────────
  // legacy=false → 签名 GET video_tab（73932 播放器档）；legacy=true → 签名 POST multi_video_model（74332）。
  const signedRequest = (args) => signPlaybackRequest(args);


  // V5 签名取址：POST player/v1，body 为 gzip(payload)，签名头覆盖 query+body。
  async function v5Fetch({ epId, alternate = false, options = {} }) {
    const identity = await getPlayIdentity(Boolean(options.freshIdentity));
    const payload = JSON.stringify({
      biz_param: { ...BIZ_PARAM, disable_video_relate_book: false },
      mixed_video_id_map: { 1004: [String(epId)] },
      dr_scene: "player",
    });
    const body = gzipSync(Buffer.from(payload, "utf8"));
    const base = alternate ? PLAYER_HOST.replace("sinfonlineb.", "sinfonlinea.") : PLAYER_HOST;
    const signed = signPlaybackV5({
      base: base + PLAYER_PATH,
      values: {
        ...V5_DEVICE,
        iid: String(identity.iid),
        cdid: String(identity.cdid || ""),
        device_id: String(identity.device_id),
      },
      body,
      now: Date.now(),
    });
    stats.requests += 1;
    stats.signed += 1;
    const resp = await axios.request({
      url: signed.url,
      method: "post",
      headers: {
        ...signed.headers,
        "User-Agent": V5_UA,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
      },
      data: body,
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      transformRequest: [(data) => data],
      validateStatus: () => true,
    });
    const label = alternate ? "player(v5-alt)" : "player(v5)";
    if (resp.status === 403 || resp.status === 429) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error(label + " HTTP " + resp.status + "（风控）");
    }
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error(label + " HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error(label + " 空响应（上游限流）");
    }
    return parsePlayerModel(text, epId);
  }

  // V5 无正文 GET video_tab（2026-11-20 上游唯一可用通道，对齐 jackotom/hongguo-drama 7.7）。
  // 与 V5 POST 的区别：method=GET、body=null（正文摘要按空串算）、不发 x-ss-stub / x-ss-req-ticket、
  // 不发 Content-Type/Content-Encoding；query 里带 video_id 等 video_tab 专属字段，走 73932 播放器档。
  async function v5TabFetch({ epId, options = {}, host } = {}) {
    const identity = await getPlayIdentity(Boolean(options.freshIdentity));
    const base = host || (TAB_HOST + TAB_PATH);
    const signed = signPlaybackV5({
      base,
      values: {
        ...V5_DEVICE,
        iid: String(identity.iid),
        cdid: String(identity.cdid || ""),
        device_id: String(identity.device_id),
        video_id: String(epId),
        video_id_type: "0",
        device_level: "1",
        need_all_video_definition: "1",
        need_mp4_align: "0",
        use_os_player: "0",
        video_platform: "1024",
        source: "0",
        from_video_id: "",
      },
      body: null,
      now: Date.now(),
    });
    stats.requests += 1;
    stats.signed += 1;
    const resp = await axios.request({
      url: signed.url,
      method: "get",
      headers: { ...signed.headers, "User-Agent": UA, Accept: "application/json" },
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (resp.status === 403 || resp.status === 429) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error("video_tab(v5) HTTP " + resp.status + "（风控）");
    }
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error("video_tab(v5) HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error("video_tab(v5) 空响应（上游限流）");
    }
    return parseTabModel(text, epId);
  }

  async function signedFetch({ epId, legacy, options = {} }) {
    const identity = await getPlayIdentity(Boolean(options.freshIdentity));
    const ticket = typeof options.ticket === "number" ? options.ticket : Date.now();
    const ts = typeof options.ts === "number" ? options.ts : Math.floor(ticket / 1000);
    const req = signedRequest({
      epId,
      identity,
      ts,
      ticket,
      randField: options.randField,
      ladonRandom: options.ladonRandom,
      legacy,
    });
    if (legacy && options.freshIdentity) req.headers.Connection = "close";
    stats.requests += 1;
    stats.signed += 1;
    const resp = await axios.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      data: req.body || undefined,
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      // 已经是 gzip 字节，不要再让 axios 序列化/压缩一次。
      transformRequest: [(data) => data],
      validateStatus: () => true,
    });
    const label = legacy ? "model" : "video_tab";
    if (resp.status === 403 || resp.status === 429) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error(label + " HTTP " + resp.status + "（风控）");
    }
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error(label + " HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      // 空正文 = 出口 IP 已被限流。设全局冷却，避免把惩罚窗越拖越长。
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error(label + " 空响应（上游限流）");
    }
    return legacy ? parseModel(text, epId) : parseTabModel(text, epId);
  }

  // ── 无签名兜底（只由 HONGGUO_OFFICIAL_UNSIGNED=1 触发，保留旧行为）─────────────
  async function requestTabUnsigned(epId, options = {}) {
    const id = await getPlainIdentity(Boolean(options.freshIdentity));
    const ts = Math.floor(Date.now() / 1000);
    const query = buildQuery({
      ...TAB_DEVICE_PARAMS,
      device_id: id.device_id,
      iid: id.iid,
      video_id: String(epId),
      video_id_type: "0",
      device_level: "1",
      need_all_video_definition: "1",
      need_mp4_align: "0",
      use_os_player: "0",
      video_platform: "1024",
      source: "0",
      from_video_id: "",
      ts: String(ts),
      _rticket: String(ts * 1000),
    });
    stats.requests += 1;
    const resp = await axios.get(TAB_HOST + TAB_PATH + "?" + query, {
      headers: { "User-Agent": UA, Accept: "application/json; charset=utf-8,application/x-protobuf" },
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      validateStatus: () => true,
    });
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error("video_tab HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error("video_tab 空响应（上游限流）");
    }
    return parseTabModel(text, epId);
  }

  async function requestModelUnsigned(epId, options = {}) {
    const id = await getPlainIdentity(Boolean(options.freshIdentity));
    const ts = Math.floor(Date.now() / 1000);
    const query = buildQuery({ ...DEVICE_PARAMS, device_id: id.device_id, iid: id.iid, ts: String(ts), _rticket: String(ts * 1000) });
    const body = JSON.stringify({
      biz_param: BIZ_PARAM,
      mixed_video_id_map: { 1004: [String(epId)] },
    });
    stats.requests += 1;
    const resp = await axios.post(MODEL_HOST + MODEL_PATH + "?" + query, body, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json; charset=utf-8,application/x-protobuf",
        "Content-Type": "application/json; charset=UTF-8",
      },
      timeout: MODEL_TIMEOUT,
      responseType: "text",
      validateStatus: () => true,
    });
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    if (resp.status !== 200) throw new Error("model HTTP " + resp.status);
    if (!text.trim()) {
      stats.empty += 1;
      quietUntil = Date.now() + EMPTY_COOLDOWN;
      throw new Error("model 空响应（上游限流）");
    }
    return parseModel(text, epId);
  }

  // 三级降级：普通身份 → 补 cdid/openudid → 重新注册设备身份。
  // 并发合并：/api/play 和 /api/stream 常同时要同一集的 model，合并成一次上游请求，
  // 也避免「play 侧超时放弃、stream 侧又看到失败缓存」直接掉到 360P。
  async function fetchModel(epId, options = {}) {
    const key = String(epId);
    if (!options.force) {
      const cached = cache.get(key);
      if (cached) {
        if (cached.value && Date.now() - cached.time < MODEL_TTL) return cached.value;
        if (cached.error && Date.now() - cached.time < MODEL_FAIL_TTL) throw cached.error;
        cache.delete(key); // 已过期：顺手删掉，别把内存当垃圾场
      }
      const running = inflight.get(key);
      if (running) return running;
    }
    const task = runFetch(key, options);
    inflight.set(key, task);
    try {
      return await task;
    } finally {
      if (inflight.get(key) === task) inflight.delete(key);
    }
  }

  // 取址顺序（对齐参考实现）：签名 GET video_tab（一次性身份）→ 空正文时补一发签名 POST。
  // 每次取址最多 2 发；空正文/403/429 即全局冷却，宁可回落 360P，也不把 IP 打进惩罚窗。
  // 并发合并：/api/play 和 /api/stream 常同时要同一集的 model，合并成一次上游请求，
  // 也避免「play 侧超时放弃、stream 侧又看到失败缓存」直接掉到 360P。
  async function runFetch(key, options = {}) {
    if (Date.now() < quietUntil) throw new Error("官方通道冷却中（上次空响应，稍后自动恢复）");
    const unsigned = String(process.env.HONGGUO_OFFICIAL_UNSIGNED || "") === "1";
    let lastError = null;
    // 可重试判据：空正文 / 业务错误码 / 缺条目。网络错误、403/429 直接放弃，别白打上游。
    const retriable = /空响应|错误码|缺少条目|没有 video_model|video_list/;
    if (unsigned) {
      const attempts = [
        () => requestTabUnsigned(key),
        () => requestTabUnsigned(key, { freshIdentity: true }),
        () => requestModelUnsigned(key, { freshIdentity: true }),
      ];
      for (const attempt of attempts) {
        try {
          const model = await attempt();
          remember(key, { time: Date.now(), value: model });
          stats.ok += 1;
          return model;
        } catch (error) {
          lastError = error;
          if (Date.now() < quietUntil) break;
          if (!retriable.test(String((error && error.message) || error))) break;
        }
      }
    } else {
      // 主链路：V5 无正文 GET video_tab → V5 POST 主/备 host → 旧 video_tab → 旧 POST。
      // 2026-11-20 起上游对 V5 POST 与旧 x-argus 链路一律回 200 空正文，GET video_tab 才是可用通道。
      const chain = [
        () => v5TabFetch({ epId: key, options }),
        () => v5Fetch({ epId: key, options }),
        () => v5Fetch({ epId: key, alternate: true, options }),
        () => signedFetch({ epId: key, legacy: false, options: { ...options, freshIdentity: true } }),
        () => signedFetch({ epId: key, legacy: true, options: { ...options, freshIdentity: true } }),
      ];
      for (let idx = 0; idx < chain.length; idx += 1) {
        try {
          const model = await chain[idx]();
          quietUntil = 0; // 成功即解除冷却（上一发空正文可能只是单发失败）
          remember(key, { time: Date.now(), value: model });
          stats.ok += 1;
          return model;
        } catch (error) {
          lastError = error;
          const message = String((error && error.message) || error);
          if (/风控|HTTP 403|HTTP 429/.test(message)) break;
          if (!retriable.test(message)) break;
          if (Date.now() < quietUntil) break; // 一进入冷却就停，别继续换身份/接口把惩罚窗拖长
        }
      }
    }
    remember(key, { time: Date.now(), error: lastError });
    markError(lastError);
    throw lastError;
  }
  // 红果官方档位的编码：bytevc1 = H.265/HEVC，bytevc2 = H.266/VVC。
  // VVC 目前没有任何浏览器能解，必须单独标出来，否则会被误当成 HEVC 去试。
  function codecOf(raw) {
    const s = String(raw || "").toLowerCase();
    if (/bytevc2|vvc|h266/.test(s)) return "vvc";
    if (/bytevc1|hevc|hev|hvc|h265/.test(s)) return "hevc";
    if (/avc|h264/.test(s)) return "h264";
    return "unknown";
  }

  function tiersOf(model) {
    const list = Array.isArray(model.video_list) ? model.video_list : [];
    const tiers = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const meta = item.video_meta || {};
      const url = String(item.main_url || item.backup_url || "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const pixelHeight = Number(meta.vheight) || 0;
      const pixelWidth = Number(meta.vwidth) || 0;
      if (!pixelHeight) continue;
      const definition = String(meta.definition || "").trim().toLowerCase();
      // definition 是「1080p」这类档位名；vwidth/vheight 是竖屏像素（1080x1920）。
      // 菜单里按习惯用档位名（1080P/720P），像素尺寸单独保留。
      const matched = /^(\d{3,4})p$/.exec(definition);
      const nominal = matched ? Number(matched[1]) : pixelHeight;
      const key = nominal + "p";
      const spade = item.spade_a || (item.encrypt_info && item.encrypt_info.spade_a) || "";
      let contentKey = null;
      if (spade) {
        try {
          contentKey = deriveContentKey(spade);
        } catch {
          contentKey = null; // 派生失败说明该档不是 CENC，按明文处理
        }
      }
      const codec = codecOf(meta.codec_type);
      tiers.push({
        key,
        label: nominal + "P",
        height: nominal,
        width: pixelWidth,
        pixelWidth,
        pixelHeight,
        codec,
        bitrate: Number(meta.bitrate) || 0,
        size: Number(meta.size) || 0,
        url,
        contentKey,
      });
    }
    // 去重（同一 definition 只留码率最高的一条），按高度降序。
    const best = new Map();
    for (const tier of tiers) {
      const prev = best.get(tier.key);
      if (!prev || tier.bitrate > prev.bitrate) best.set(tier.key, tier);
    }
    return Array.from(best.values()).sort((a, b) => b.height - a.height);
  }

  function pickTier(tiers, quality) {
    if (!tiers.length) return null;
    const wanted = String(quality || "auto").toLowerCase();
    if (wanted === "compat") return null;
    if (wanted === "auto") {
      // 默认档优先给浏览器能解的（HEVC / H.264）；全是 VVC 时才退回最高档。
      return tiers.find((tier) => tier.codec !== "vvc") || tiers[0];
    }
    const exact = tiers.find((tier) => tier.key === wanted);
    if (exact) return exact;
    const height = Number(wanted.replace(/p$/, ""));
    if (Number.isFinite(height) && height > 0) {
      const lower = tiers.filter((tier) => tier.height <= height);
      if (lower.length) return lower[0]; // 已按高度降序，取不超过目标的最大档
      return tiers[tiers.length - 1]; // 目标高于全部可用档，退到最小档
    }
    return tiers[0];
  }

  return {
    stats,
    // 首块解密出来不是 MP4 时，说明这份播放模型（签名 URL + 内容密钥）已失效，
    // 清掉这一集的缓存，让下一次取址重新打上游（A3）。失败缓存同样清掉，
    // 否则 MODEL_FAIL_TTL 内的重取会直接命中上次的错误。
    invalidate(epId) {
      const key = String(epId);
      cache.delete(key);
      stats.invalidated += 1;
      return true;
    },
    // 运维：清空本模块的播放模型缓存（含失败缓存）。返回清掉的条目数，
    // 用于 /api/cache/clear 的回执，方便确认「清缓存」真的清到了东西。
    clearCache() {
      const size = cache.size;
      cache.clear();
      return size;
    },
    async info(epId) {
      const model = await fetchModel(epId);
      const tiers = tiersOf(model);
      return { tiers, expire: Number(model.url_expire) || 0, duration: Number(model.video_duration) || 0 };
    },
    // 返回可直接交给 vendor 的 prepareHeader/remoteRange/decryptPartial 的 stream 对象。
    async stream(epId, quality = "auto") {
      const model = await fetchModel(epId);
      const tiers = tiersOf(model);
      const tier = pickTier(tiers, quality);
      if (!tier) throw new Error("官方接口没有可用清晰度");
      return {
        tier,
        tiers,
        stream: {
          url: tier.url,
          key: tier.contentKey,
          codec: tier.codec,
          quality: tier.label,
          ua: UA,
          referer: "https://novel.snssdk.com/",
          channel: "official",
        },
      };
    },
  };
}
