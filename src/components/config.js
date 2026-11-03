import { SunPanelPageElement } from '@sun-panel/micro-app';
import { html, css } from 'lit';
import {
  loadConfig,
  saveConfig,
  normalizeBridge,
  unwrapResponse,
  DEFAULT_BRIDGE,
  DEFAULT_REFRESH_MS,
  REFRESH_OPTIONS,
  SOURCES,
  SAMPLE_BRIDGE,
  suggestBridgeUrl,
  K,
} from '../api/bridge.js';
import appConfig from '../../config/app.config.js';
import { ensureFontFaces } from '../styles/fonts.js';

/**
 * 卡片配置页
 *
 * 这里只配置「桥接服务地址」这一个全局项。
 * 具体每台卡片的服务器地址在卡片上直接输入，不用进这个页面。
 */
export class McCardConfig extends SunPanelPageElement {
  static properties = {
    spCtx: { type: Object, attribute: false },
    bridgeUrl: { type: String, state: true },
    refreshMs: { type: Number, state: true },
    connState: { type: String, state: true },
    connMsg: { type: String, state: true },
    saving: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.bridgeUrl = DEFAULT_BRIDGE;
    this.refreshMs = DEFAULT_REFRESH_MS;
    this._lastBridge = suggestBridgeUrl();
    this.connState = 'idle';
    this.connMsg = '';
    this.saving = false;
  }

  async onInitialized() {
    const api = this.spCtx?.api;
    ensureFontFaces(this.spCtx?.staticPath);
    try {
      const cfg = await loadConfig(api);
      this.bridgeUrl = cfg.bridgeUrl || DEFAULT_BRIDGE;
      if (this.bridgeUrl !== 'public') this._lastBridge = this.bridgeUrl;
      this.refreshMs = cfg.refreshMs ?? DEFAULT_REFRESH_MS;
    } catch (e) {
      /* 保留默认值 */
    }
    this.requestUpdate();
  }

  /** 当前数据源：bridge | public */
  getSource() {
    return this.bridgeUrl === 'public' ? 'public' : 'bridge';
  }

  _onSourceChange(e) {
    const v = e.target.value;
    this.bridgeUrl = v === 'public' ? 'public' : this._lastBridge || suggestBridgeUrl();
    this.connState = 'idle';
    this.connMsg = '';
    this.requestUpdate();
  }

  _onInput(e) {
    this.bridgeUrl = e.target.value;
    if (e.target.value !== 'public') this._lastBridge = e.target.value;
    this.connState = 'idle';
    this.connMsg = '';
  }

  /** 测试桥接服务是否可达 */
  async testConnection() {
    const api = this.spCtx?.api;
    if (!api?.network) return;
    this.connState = 'testing';
    this.connMsg = '正在连接桥接服务…';
    this.requestUpdate();
    try {
      const base = normalizeBridge(this.bridgeUrl);
      // 字段名必须是 request.targetUrl（SDK 的 RequestOptions 定义）
      const res = await api.network.request({
        request: {
          targetUrl: `${base}/health`,
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
      });
      const data = unwrapResponse(res);
      const ver = data?.version ? ` v${data.version}` : '';
      this.connState = 'ok';
      this.connMsg = `桥接服务可用${ver}`;
    } catch (e) {
      this.connState = 'fail';
      this.connMsg = `连接失败：${e?.message || e}`;
    }
    this.requestUpdate();
  }

  async handleSave() {
    const api = this.spCtx?.api;
    this.saving = true;
    this.requestUpdate();
    try {
      await saveConfig(api, {
        [K.bridgeUrl]: normalizeBridge(this.bridgeUrl),
        [K.refreshMs]: this.refreshMs,
      });
      this.connState = 'ok';
      this.connMsg = '已保存 — 回到桌面卡片上填写服务器地址即可';
    } catch (e) {
      this.connState = 'fail';
      this.connMsg = `保存失败：${e?.message || e}`;
    } finally {
      this.saving = false;
      this.requestUpdate();
    }
  }

  /** 部署包的下载地址（打包进微应用资源） */
  getBridgeZipUrl() {
    const base = String(this.spCtx?.staticPath || '').replace(/\/+$/, '');
    return `${base}/bridge.zip`;
  }

  getVersionTag() {
    return `v${appConfig.version}`;
  }

  render() {
    const statusMap = {
      idle: { color: '#8c8c8c', icon: '○' },
      testing: { color: '#faad14', icon: '◌' },
      ok: { color: '#52c41a', icon: '●' },
      fail: { color: '#ff4d4f', icon: '●' },
    };
    const s = statusMap[this.connState] || statusMap.idle;

    return html`
      <div class="container">
        <div class="content">
          <h1>Minecraft 卡片配置 <span class="ver">${this.getVersionTag()}</span></h1>

          <section>
            <h2>数据源</h2>
            <p class="desc">
              微应用跑在浏览器里，<b>只能发 HTTP</b>；而 Minecraft 状态查询是 <b>TCP 协议</b>。
              所以中间需要一个"翻译"。两种选法：
            </p>
            <select class="input" .value=${this.getSource()} @change=${this._onSourceChange}>
              ${SOURCES.map(
                (o) => html`
                  <option value=${o.key} ?selected=${this.getSource() === o.key}>
                    ${o.label}
                  </option>
                `
              )}
            </select>

            ${this.getSource() === 'bridge'
              ? html`
                  <label style="margin-top:12px">桥接服务地址</label>
                  <input
                    class="input"
                    type="text"
                    .value=${this.bridgeUrl}
                    @input=${this._onInput}
                    placeholder="http://192.168.1.100:8848"
                  />
                  <div class="row">
                    <button
                      class="btn"
                      ?disabled=${this.connState === 'testing'}
                      @click=${this.testConnection}
                    >
                      测试连接
                    </button>
                    <button class="btn primary" ?disabled=${this.saving} @click=${this.handleSave}>
                      保存
                    </button>
                  </div>
                  <div class="status" style="color:${s.color}">
                    ${this.connMsg ? `${s.icon} ${this.connMsg}` : ''}
                  </div>
                `
              : html`
                  <p class="desc warn">
                    这是默认数据源，装完就能用。公共 API 由第三方（mcstatus.io）在公网探测，所以
                    <b>只能查询公网可达的服务器</b>。<br />
                    像 <code>192.168.1.10</code> 这种内网地址它进不来，
                    会直接报错 —— 要查局域网服务器请改用桥接服务。
                  </p>
                  <div class="row">
                    <button class="btn primary" ?disabled=${this.saving} @click=${this.handleSave}>
                      保存
                    </button>
                  </div>
                  ${this.connMsg
                    ? html`<div class="status" style="color:${s.color}">
                        ${s.icon} ${this.connMsg}
                      </div>`
                    : ''}
                `}
          </section>

          <section>
            <h2>部署桥接服务</h2>
            <p class="desc">
              只有需要查 <b>局域网服务器</b>（<code>192.168.x.x</code>）时才需要这个。
              它跑在你自己的电脑或 NAS 上，替微应用完成 TCP 协议查询。
              公网服务器用上面的「公共 API」就够了。
            </p>

            <div class="row">
              <a class="btn" href=${this.getBridgeZipUrl()} download="mcserver-bridge.zip">
                下载部署包（8 KB）
              </a>
            </div>

            <p class="desc" style="margin-top:14px">解压后按平台选一种启动：</p>
            <pre class="code"># Linux / NAS：自动注册 systemd 并开机自启
sudo bash bridge/install.sh

# Docker
cd bridge &amp;&amp; docker compose up -d

# Windows：生成无窗口后台启动器
cd bridge
powershell -ExecutionPolicy Bypass -File start.ps1</pre>

            <p class="desc">
              启动后回到上面把「数据源」切成「桥接服务」，
              地址填 <code>http://&lt;那台机器的IP&gt;:8848</code>，点「测试连接」确认。
            </p>
          </section>

          <section>
            <h2>自动刷新</h2>
            <p class="desc">
              卡片会按这个间隔自动重新查询在线人数和延迟。点击卡片本身可随时手动刷新。
            </p>
            <select
              class="input"
              .value=${String(this.refreshMs)}
              @change=${(e) => {
                this.refreshMs = Number(e.target.value);
                this.connState = 'idle';
                this.connMsg = '';
              }}
            >
              ${REFRESH_OPTIONS.map(
                (o) => html`
                  <option value=${String(o.value)} ?selected=${this.refreshMs === o.value}>
                    ${o.label}
                  </option>
                `
              )}
            </select>
            <div class="row">
              <button class="btn primary" ?disabled=${this.saving} @click=${this.handleSave}>
                保存
              </button>
            </div>
          </section>

          <section>
            <h2>怎么用</h2>
            <ol class="steps">
              <li>先确认桥接服务已启动（见下方命令）</li>
              <li>回到桌面，添加「Minecraft 服务器状态」卡片</li>
              <li>在卡片上直接输入服务器地址，例如 <code>192.168.1.100:25565</code></li>
              <li>卡片会显示图标、MOTD、在线人数和延迟信号</li>
            </ol>
            <pre class="code">python3 bridge/bridge.py --port 8848</pre>
          </section>
        </div>
      </div>
    `;
  }

  static styles = [
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }
      .container {
        height: 100%;
        overflow-y: auto;
        box-sizing: border-box;
        background: #1a1a1a;
        color: #e8e8e8;
        font-family: 'MSLXMojangles', 'MSLXUnifont', Consolas, monospace;
      }
      .content {
        max-width: 720px;
        margin: 0 auto;
        padding: 20px;
      }
      h1 {
        font-size: 18px;
        margin: 0 0 18px;
        color: #ffffff;
      }
      .ver {
        font-size: 11px;
        color: #55ff55;
        margin-left: 6px;
      }
      h2 {
        font-size: 13px;
        margin: 0 0 8px;
        color: #55ff55;
      }
      section {
        margin-bottom: 22px;
      }
      .desc {
        font-size: 11px;
        line-height: 1.7;
        color: #a0a0a0;
        margin: 0 0 12px;
      }
      label {
        display: block;
        font-size: 11px;
        color: #b0b0b0;
        margin-bottom: 5px;
      }
      .input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        background: #0b0b0b;
        border: 2px solid #3a3a3a;
        color: #ffffff;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }
      .input:focus {
        border-color: #55ff55;
      }
      .row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      .btn {
        padding: 7px 16px;
        background: #6f6f6f;
        border: 2px solid #000000;
        box-shadow: inset -2px -2px 0 #373737, inset 2px 2px 0 #b9b9b9;
        color: #ffffff;
        font-family: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .btn:hover {
        background: #8b8b8b;
      }
      .btn:active {
        box-shadow: inset 2px 2px 0 #373737, inset -2px -2px 0 #b9b9b9;
      }
      .btn:disabled {
        color: #9a9a9a;
        cursor: default;
      }
      .btn.primary {
        color: #ffff88;
      }
      .status {
        margin-top: 10px;
        font-size: 11px;
        line-height: 1.5;
      }
      .desc.warn {
        color: #ffbb55;
        background: rgba(255, 187, 85, 0.08);
        border-left: 2px solid #ffbb55;
        padding: 8px 10px;
      }
      .steps {
        margin: 0;
        padding-left: 18px;
        font-size: 11px;
        line-height: 1.9;
        color: #b0b0b0;
      }
      .code,
      code {
        background: #0b0b0b;
        color: #55ff55;
        padding: 1px 5px;
        font-family: 'MSLXUnifont', Consolas, monospace;
        font-size: 11px;
      }
      .code {
        display: block;
        padding: 10px;
        margin-top: 10px;
        overflow-x: auto;
      }
    `,
  ];
}
