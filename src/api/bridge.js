/**
 * 桥接服务访问 + 配置存取
 *
 * 为什么需要桥接：
 *   微应用只能发 HTTP（Sun-Panel 后端代理），而 Minecraft 服务器列表查询
 *   是 TCP 上的自定义协议（Server List Ping）。所以中间要有一个
 *   把 HTTP 请求翻译成 SLP 查询的小服务，见项目里的 bridge/ 目录。
 */

/** 数据节点名称 */
export const NODE = 'mcserver';

/** 数据节点中使用的键 */
export const K = {
  /** 桥接服务基址，如 http://192.168.1.100:8848 */
  bridgeUrl: 'bridgeUrl',
  /** 每张卡片各自绑定的服务器：{ [widgetId]: 'host:port' } */
  servers: 'servers',
  /** 最近一次手动填写过的地址，作为新卡片默认值 */
  lastAddress: 'lastAddress',
  /** 自动刷新间隔（毫秒），0 表示关闭自动刷新 */
  refreshMs: 'refreshMs',
  /** 数据源：auto | public | bridge */
  source: 'source',
};

/**
 * 默认数据源
 *
 *   auto   : 智能选择（默认）
 *            内网地址 → 直接走桥接
 *            公网地址 → 先公共 API，失败自动降级到桥接
 *   public : 只走公共 API（mcstatus.io），免部署
 *   bridge : 只走本机桥接服务，支持局域网，数据自己掌控
 *
 * 为什么默认 auto：公共 API 是第三方在公网探测，
 * 遇到 FRP 映射、防火墙白名单、刚启动的服务器都可能探测失败，
 * 这种情况自动退回本地桥接，用户体验最好。
 */
export const DEFAULT_SOURCE = 'auto';

/**
 * 示例桥接地址
 *
 * 不写死任何具体 IP —— 之前写死 192.168.1.100 是开发机的地址，
 * 别人装了这个包根本用不了。
 * 现在改成运行时从当前访问地址推断，见 suggestBridgeUrl()。
 */
export const SAMPLE_BRIDGE = 'http://127.0.0.1:8848';

/**
 * 推断桥接服务地址
 *
 * 桥接服务通常和 Sun-Panel 部署在同一台机器上，
 * 所以拿浏览器地址栏里的 host 拼上 8848 端口，大概率就是对的：
 *   从 192.168.1.100 访问 → http://192.168.1.100:8848
 *   从 nas.lan 访问        → http://nas.lan:8848
 *   从 example.com 访问    → http://example.com:8848
 *
 * 猜错也没关系，配置页里可以手动改。
 */
export function suggestBridgeUrl() {
  try {
    const h = typeof window !== 'undefined' ? window.location?.hostname : '';
    if (h) {
      const host = h.includes(':') ? `[${h}]` : h;
      return `http://${host}:8848`;
    }
  } catch (e) {
    /* 忽略 */
  }
  return SAMPLE_BRIDGE;
}

/** 默认 MC 端口 */
export const DEFAULT_PORT = 25565;

/* ============================================================
 * 数据源
 *   bridge : 本项目的 bridge.py，支持局域网 + 公网
 *   public : 第三方公共 API（mcstatus.io），免部署，但只能查公网地址
 * ============================================================ */
export const SOURCES = [
  { key: 'auto', label: '自动（推荐：先公共 API，失败切桥接）' },
  { key: 'public', label: '公共 API（免部署，仅公网）' },
  { key: 'bridge', label: '桥接服务（支持局域网，最可靠）' },
];

/** 公共 API 基址 */
const PUBLIC_API = 'https://api.mcstatus.io/v2/status/java/';

/**
 * 判断是不是内网 / 本地地址
 * 这类地址第三方 API 在公网上访问不到
 */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().trim();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  // 单段主机名（如 DESKTOP-XXX），一定是局域网
  if (!h.includes('.') && !h.includes(':')) return true;
  return false;
}

/** 默认刷新间隔 */
export const DEFAULT_REFRESH_MS = 10000;

/** 可选的刷新间隔 */
export const REFRESH_OPTIONS = [
  { value: 10000, label: '10 秒' },
  { value: 30000, label: '30 秒' },
  { value: 60000, label: '1 分钟' },
  { value: 120000, label: '2 分钟' },
  { value: 300000, label: '5 分钟' },
  { value: 0, label: '关闭（只手动刷新）' },
];

/**
 * 解析用户输入的服务器地址
 *
 * 支持：1.2.3.4 / 1.2.3.4:25565 / mc.example.com / [::1]:25565
 *
 * 没写端口时 port 返回 null —— 交给桥接服务去做 SRV 记录解析，
 * 这样 mc.example.com 这种只配了 SRV 的服务器也能查（真实端口可能是 25570）。
 */
export function parseAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // IPv6 带方括号
  const v6 = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
  }

  // host:port（只按唯一的冒号切分；纯 IPv6 不含方括号时冒号多于一个，跳过）
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && raw.indexOf(':') === idx) {
    const port = Number(raw.slice(idx + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { host: raw.slice(0, idx), port };
    }
  }
  return { host: raw, port: null };
}

/** 把 {host,port} 还原成显示用字符串（无端口 / 默认端口都省略） */
export function formatAddress(host, port) {
  if (!host) return '';
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  if (!port || String(port) === String(DEFAULT_PORT)) return h;
  return `${h}:${port}`;
}

/** 规范化桥接服务地址（去掉尾部斜杠，空值回退到推断值） */
export function normalizeBridge(url) {
  const v = String(url || '').trim() || suggestBridgeUrl();
  return v.replace(/\/+$/, '');
}

/**
 * 读取配置
 * @param {object} api this.spCtx.api
 */
export async function loadConfig(api) {
  try {
    const data = await api.dataNode.user.getByKeys(NODE, [
      K.bridgeUrl,
      K.servers,
      K.lastAddress,
      K.refreshMs,
    ]);

    let servers = data?.[K.servers] ?? {};
    if (typeof servers === 'string') {
      try {
        servers = JSON.parse(servers);
      } catch (e) {
        servers = {};
      }
    }
    if (!servers || typeof servers !== 'object') servers = {};

    const rawRefresh = Number(data?.[K.refreshMs]);
    const refreshMs = Number.isFinite(rawRefresh) && rawRefresh >= 0
      ? rawRefresh
      : DEFAULT_REFRESH_MS;

    // ---- 数据源 ----
    let source = data?.[K.source];
    let bridgeUrl = data?.[K.bridgeUrl];

    // 兼容旧配置：bridgeUrl 存过 'public' 表示走公共 API
    if (!source) {
      if (bridgeUrl === 'public') {
        source = 'public';
        bridgeUrl = '';
      } else if (bridgeUrl) {
        source = 'bridge';
      } else {
        source = DEFAULT_SOURCE;
      }
    }
    if (!SOURCES.some((o) => o.key === source)) source = DEFAULT_SOURCE;
    if (!bridgeUrl || bridgeUrl === 'public') bridgeUrl = suggestBridgeUrl();

    return {
      source,
      bridgeUrl,
      servers,
      lastAddress: data?.[K.lastAddress] || '',
      refreshMs,
    };
  } catch (e) {
    return {
      source: DEFAULT_SOURCE,
      bridgeUrl: suggestBridgeUrl(),
      servers: {},
      lastAddress: '',
      refreshMs: DEFAULT_REFRESH_MS,
    };
  }
}

/** 保存配置（只写传入的键） */
export async function saveConfig(api, patch) {
  const items = {};
  Object.keys(patch).forEach((k) => {
    if (patch[k] !== undefined) items[k] = patch[k];
  });
  if (!Object.keys(items).length) return;
  await api.dataNode.user.setByKeys(NODE, items);
}

/** 取某张卡片绑定的服务器地址字符串 */
export function serverForWidget(cfg, widgetId) {
  if (!widgetId) return '';
  const v = (cfg?.servers || {})[widgetId];
  return typeof v === 'string' ? v : '';
}

/** 保存某张卡片绑定的服务器地址 */
export async function setWidgetServer(api, widgetId, address) {
  if (!widgetId) return;
  const cfg = await loadConfig(api);
  const servers = { ...(cfg.servers || {}) };
  const addr = String(address || '').trim();
  if (addr) {
    servers[widgetId] = addr;
  } else {
    delete servers[widgetId];
  }
  await saveConfig(api, {
    [K.servers]: servers,
    [K.lastAddress]: addr,
  });
}

/**
 * 通过桥接服务查询服务器状态
 *
 * 平台 API 的正确写法（见 SDK 的 RequestOptions 类型）：
 *   api.network.request({ request: { targetUrl, method, headers, body } })
 * 注意字段是 targetUrl，不是 url；也不支持 timeout。
 * 写成 { url } 会被后端校验拦下，报
 *   "Field validation for 'TargetURL' failed on the 'required' tag"
 */
export async function fetchStatus(api, source, bridgeUrl, host, port) {
  const src = source || DEFAULT_SOURCE;
  const base = normalizeBridge(bridgeUrl);

  // 只走公共 API
  if (src === 'public') {
    return fetchFromPublicApi(api, host, port);
  }

  // 只走桥接
  if (src === 'bridge') {
    return fetchViaBridge(api, base, host, port);
  }

  // auto：内网地址第三方 API 进不来，直接走桥接
  if (isPrivateHost(host)) {
    return fetchViaBridge(api, base, host, port);
  }

  // auto：公网地址先试公共 API，失败再退回桥接
  try {
    return await fetchFromPublicApi(api, host, port);
  } catch (e1) {
    try {
      return await fetchViaBridge(api, base, host, port);
    } catch (e2) {
      throw new Error(
        `公共 API 和桥接服务都查不到 ${host}。` +
          `公共 API：${e1.message}；桥接服务：${e2.message}`
      );
    }
  }
}

/**
 * 通过本地桥接服务查询
 *
 * 平台 API 的正确写法（见 SDK 的 RequestOptions 类型）：
 *   api.network.request({ request: { targetUrl, method, headers, body } })
 * 注意字段是 targetUrl，不是 url；也不支持 timeout。
 */
export async function fetchViaBridge(api, bridgeUrl, host, port) {
  const base = normalizeBridge(bridgeUrl);
  // 没给端口时不传 port 参数，让桥接服务去查 SRV 记录
  const qs = `host=${encodeURIComponent(host)}`;
  const targetUrl = port
    ? `${base}/status?${qs}&port=${encodeURIComponent(port)}`
    : `${base}/status?${qs}`;

  let res;
  try {
    res = await api.network.request({
      request: {
        targetUrl,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    });
  } catch (e) {
    throw new Error(`请求桥接服务失败（${base}）：${e?.message || e}`);
  }

  const payload = unwrapResponse(res);

  if (!payload || typeof payload !== 'object') {
    throw new Error('桥接服务返回内容无法解析');
  }
  if (payload.ok === false) {
    throw new Error(payload.error || '查询失败');
  }
  return payload;
}

/**
 * 通过公共 API（mcstatus.io）查询
 *
 * 免部署方案：不需要在本机跑任何服务。
 * 代价是第三方在公网上探测，查不到 192.168.x.x 这类内网地址。
 */
export async function fetchFromPublicApi(api, host, port) {
  if (isPrivateHost(host)) {
    throw new Error(
      `公共 API 查不到内网地址 ${host}：第三方在公网探测，进不了你的局域网。` +
        '如果要查局域网服务器，请部署桥接服务并切换数据源。'
    );
  }

  const target = port ? `${host}:${port}` : host;
  const targetUrl = PUBLIC_API + encodeURIComponent(target);

  let res;
  try {
    res = await api.network.request({
      request: {
        targetUrl,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    });
  } catch (e) {
    throw new Error(`请求公共 API 失败：${e?.message || e}`);
  }

  const d = unwrapResponse(res);
  if (!d || typeof d !== 'object') {
    throw new Error('公共 API 返回内容无法解析');
  }
  if (d.online === false) {
    throw new Error(
      '公共 API 探测不到该服务器（第三方在公网 ping 失败，'
      + '常见于 FRP 映射、防火墙白名单、刚启动的服务器）。'
      + '请到配置页把数据源改成「桥接服务」后重试。'
    );
  }

  const ver = d.version || {};
  const pl = d.players || {};
  const motd = d.motd || {};

  return {
    ok: true,
    host: d.host || host,
    port: d.port || port || DEFAULT_PORT,
    online: true,
    version: ver.name_clean || ver.name_raw || '',
    protocol: ver.protocol,
    players: {
      online: pl.online ?? 0,
      max: pl.max ?? 0,
      sample: (pl.list || []).map((p) => ({
        name: p.name_clean || p.name_raw || '',
      })),
    },
    motd: motd.raw ?? motd.clean ?? '',
    motdText: motd.clean ?? stripMinecraftCodes(motd.raw) ?? '',
    favicon: d.icon || '',
    // 公共 API 不给延迟，信号条按满格显示
    latency: 0,
    source: 'public-api',
    queriedAt: new Date().toISOString(),
  };
}

/**
 * 剥掉平台代理可能加的外壳
 *
 * 可能遇到：JSON 字符串 / { code, message, data } / { data } / 裸对象
 */
export function unwrapResponse(res) {
  let cur = res;

  if (typeof cur === 'string') {
    const text = cur.trim();
    try {
      cur = JSON.parse(text);
    } catch (e) {
      throw new Error(`桥接服务返回非 JSON 内容：${text.slice(0, 120)}`);
    }
  }

  for (let depth = 0; depth < 6; depth++) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return cur;

    if ('code' in cur) {
      const code = Number(cur.code);
      if (code !== 200) {
        throw new Error(cur.message || cur.msg || `平台返回 code=${cur.code}`);
      }
      cur = cur.data;
      continue;
    }
    if ('data' in cur) {
      cur = cur.data;
      continue;
    }
    return cur;
  }
  return cur;
}

/**
 * 把 MOTD 结构转成纯文本
 * MC 的 description 可能是字符串，也可能是 {text, extra:[...]} 结构
 */
export function motdToText(desc) {
  if (desc == null) return '';
  if (typeof desc === 'string') return stripMinecraftCodes(desc);
  if (Array.isArray(desc)) return desc.map(motdToText).join('');

  let out = '';
  if (typeof desc.text === 'string') out += desc.text;
  if (Array.isArray(desc.extra)) out += desc.extra.map(motdToText).join('');
  return stripMinecraftCodes(out);
}

/** 去掉 § 颜色代码 */
export function stripMinecraftCodes(s) {
  return String(s || '').replace(/\u00a7[0-9a-fk-orx]/gi, '');
}
