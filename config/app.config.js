/**
 * 微应用配置文件 - Minecraft 服务器状态卡片
 */

/**
 * 解析网络白名单。
 *
 * 微应用本身只能发 HTTP，而 Minecraft 服务器列表查询是 TCP 协议，
 * 所以中间必须有一个 HTTP→SLP 的桥接服务（见 bridge/ 目录）。
 * 白名单要放行这个桥接服务的地址。
 *
 * 构建时可用环境变量覆盖：
 *   set MCS_BRIDGE=192.168.1.100,192.168.1.100:8848
 *   npm run pack
 */
function resolveNetworkDomains() {
  const raw = typeof process !== 'undefined' ? process.env?.MCS_BRIDGE : '';
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  /*
   * 默认放开所有域名。
   *
   * 为什么不写死具体 IP：
   *   桥接服务部署在用户自己的机器上，地址因人而异，
   *   写死任何 IP 都会让别的用户装上后直接不可用。
   *
   * 实际用到的地址由配置页运行时决定（见 suggestBridgeUrl()：
   * 默认按浏览器地址栏的 host + :8848 推断，用户还能手改）。
   *
   * 如果想收紧，构建时指定：
   *   set MCS_BRIDGE=192.168.1.50,192.168.1.50:8848
   *   npm run pack
   * 注意 Sun-Panel 精确匹配 host：带端口时 IP 和 IP:端口 两种都要列。
   */
  return ['*', '127.0.0.1', '127.0.0.1:8848', 'localhost:8848', 'api.mcstatus.io'];
}

export default {
  // =======================
  // 应用基础信息
  // =======================
  appJsonVersion: '1.1',
  author: 'cheering',
  microAppId: 'cheering-mcserver-status',
  version: '1.5.2',
  entry: 'main.js',
  icon: 'icon.png',
  debug: false,

  appInfo: {
    appName: '$t:APP_NAME',
    description: '$t:APP_DESCRIPTION',
    networkDescription: '$t:NETWORK_DESCRIPTION',
  },

  locales: {
    'zh-CN': 'zh-CN.json',
    'en-US': 'en-US.json',
  },

  defaultLocale: 'zh-CN',

  // =======================
  // 权限配置
  // =======================
  permissions: ['network', 'dataNode'],

  // =======================
  // 网络域名白名单（打包期静态声明）
  // 注意 host 带端口时，IP 和 IP:端口 两种写法都要列，
  // 否则会报 "No permission to access: http://<host>:<port>/status"
  // =======================
  networkDomains: resolveNetworkDomains(),

  // =======================
  // 数据节点配置
  // =======================
  dataNodes: {
    // 存放桥接服务地址、每张卡片各自绑定的 MC 服务器地址
    mcserver: {
      scope: 'user',
      isPublic: false,
    },
  },
};
