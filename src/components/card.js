import { SunPanelWidgetElement } from '@sun-panel/micro-app';
import { html, css } from 'lit';
import {
  loadConfig,
  serverForWidget,
  setWidgetServer,
  fetchStatus,
  parseAddress,
  formatAddress,
  motdToText,
  normalizeBridge,
  DEFAULT_BRIDGE,
} from '../api/bridge.js';
import { ensureFontFaces } from '../styles/fonts.js';

/** 自动刷新间隔兜底值（真正生效的值来自配置，默认 10 秒） */
const POLL_MS = 10000;

/**
 * Minecraft 服务器状态卡片
 *
 * 视觉参照 MC 多人游戏列表的服务器条目。
 *
 * 三档布局，按卡片尺寸切换：
 *   mini   (1x2)         图标 + 人数 + 信号
 *   medium (2x2)         图标 + 地址 + MOTD + 人数 + 信号
 *   full   (1xfull / 2x4) 图标 + 地址 + MOTD + 人数 + 信号 + 查询时间
 */
export class McCard extends SunPanelWidgetElement {
  static properties = {
    spCtx: { type: Object, attribute: false },
    status: { type: Object, state: true },
    loading: { type: Boolean, state: true },
    error: { type: String, state: true },
    editing: { type: Boolean, state: true },
    draft: { type: String, state: true },
    address: { type: String, state: true },
    updatedAt: { type: String, state: true },
    _size: { type: Object, state: true },
  };

  constructor() {
    super();
    this.status = null;
    this.loading = false;
    this.error = '';
    this.editing = false;
    this.draft = '';
    this.address = '';
    this.updatedAt = '';
    this._size = null;
    this._cfg = null;
    this._timerId = null;
    this._ro = null;
    this._busy = false;
  }

  connectedCallback() {
    super.connectedCallback();
    try {
      if (!this._ro && typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver((entries) => {
          for (const e of entries) {
            const cr = e.contentRect;
            const w = Math.round(cr.width);
            const h = Math.round(cr.height);
            if (!this._size || this._size.w !== w || this._size.h !== h) {
              this._size = { w, h };
            }
          }
        });
        this._ro.observe(this);
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  onInitialized() {
    this._bootstrap();
  }

  onWidgetInfoChanged() {
    this._bootstrap();
  }

  onDisconnected() {
    this._stopTimer();
    try {
      this._ro?.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    this._ro = null;
  }

  _widgetId() {
    const wi = this.spCtx?.widgetInfo;
    return wi?.widgetId || wi?.id || '';
  }

  /** 布局档位：由平台给的 gridSize 决定 */
  _tier() {
    const size = this.spCtx?.widgetInfo?.gridSize || '';
    if (size === '1x2') return 'mini';    // 只有图标 + 人数 + 信号
    if (size === '2x2') return 'square';  // 同上，图标更大
    return 'full'; // 1xfull / 2x4：带地址和 MOTD
  }

  /**
   * 让地址和 MOTD 在固定宽度内完整显示。
   *
   * 做法：先清空内联字号拿回 CSS 基准值，量出文本自然宽度 scrollWidth，
   * 超过容器宽度 clientWidth 就按比例缩小 font-size。
   * 比 text-overflow: ellipsis 更好的是——文字永远不被截断。
   */
  _fitText() {
    const root = this.renderRoot;
    if (!root) return;
    for (const cls of ['addr', 'motd']) {
      const el = root.querySelector('.' + cls);
      if (!el) continue;
      el.style.fontSize = '';
      const avail = el.clientWidth;
      if (!avail) continue;
      const need = el.scrollWidth;
      if (need > avail) {
        const base = parseFloat(getComputedStyle(el).fontSize) || 12;
        const next = Math.max(8, base * (avail / need) * 0.985);
        el.style.fontSize = next.toFixed(2) + 'px';
      }
    }
  }

  updated(changed) {
    try {
      super.updated?.(changed);
    } catch (e) {
      /* 忽略 */
    }
    if (
      changed.has('status') ||
      changed.has('address') ||
      changed.has('editing') ||
      changed.has('_size')
    ) {
      // 等布局稳定后再量，避免拿到旧宽度
      requestAnimationFrame(() => this._fitText());
    }
  }

  async _bootstrap() {
    const api = this.spCtx?.api;
    if (!api) return;
    ensureFontFaces(this.spCtx?.staticPath);
    // 像素字体异步加载，加载完字宽会变，需要重新适配一次
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.then(() => this._fitText()).catch(() => {});
    }
    try {
      this._cfg = await loadConfig(api);
      this.address = serverForWidget(this._cfg, this._widgetId());
      this.draft = this.address;
      if (this.address) {
        this.editing = false;
        await this._refresh();
      } else {
        this.editing = true;
        this.loading = false;
        this.requestUpdate();
      }
      this._startTimer();
    } catch (e) {
      this.error = e?.message || '初始化失败';
      this.loading = false;
      this.requestUpdate();
    }
  }

  /** 当前生效的刷新间隔（毫秒），0 表示关闭自动刷新 */
  _pollMs() {
    const v = Number(this._cfg?.refreshMs);
    if (Number.isFinite(v) && v >= 0) return v;
    return POLL_MS;
  }

  _startTimer() {
    this._stopTimer();
    const api = this.spCtx?.api;
    if (!api?.timer) return;
    const ms = this._pollMs();
    // 0 表示用户关掉了自动刷新，只保留手动点卡片刷新
    if (!ms) return;
    this._timerId = api.timer.setInterval(() => {
      if (this.address && !this.editing) this._refresh(true);
    }, ms);
  }

  _stopTimer() {
    if (this._timerId !== null && this._timerId !== undefined) {
      try {
        this.spCtx?.api?.timer?.clearInterval(this._timerId);
      } catch (e) {
        /* 忽略 */
      }
    }
    this._timerId = null;
  }

  /** 查询状态 */
  async _refresh(silent = false) {
    const api = this.spCtx?.api;
    if (!api || !this.address || this._busy) return;
    const parsed = parseAddress(this.address);
    if (!parsed) return;

    this._busy = true;
    if (!silent) {
      this.loading = true;
      this.error = '';
      this.requestUpdate();
    }
    try {
      const bridge = normalizeBridge(this._cfg?.bridgeUrl || DEFAULT_BRIDGE);
      const data = await fetchStatus(api, bridge, parsed.host, parsed.port);
      this.status = data;
      this.error = '';
      this.updatedAt = formatNow();
    } catch (e) {
      this.status = null;
      this.error = e?.message || '查询失败';
      this.updatedAt = formatNow();
    } finally {
      this.loading = false;
      this._busy = false;
      this.requestUpdate();
    }
  }

  /** 提交地址并查询 */
  async _submitAddress(ev) {
    if (ev) ev.stopPropagation();
    const api = this.spCtx?.api;
    const raw = String(this.draft || '').trim();
    if (!raw) return;
    const parsed = parseAddress(raw);
    if (!parsed) {
      this.error = '地址格式不正确';
      this.requestUpdate();
      return;
    }
    const normalized = formatAddress(parsed.host, parsed.port);
    this.address = normalized;
    this.editing = false;
    this.loading = true;
    this.requestUpdate();
    try {
      await setWidgetServer(api, this._widgetId(), normalized);
      this._cfg = await loadConfig(api);
      await this._refresh();
      this._startTimer();
    } catch (e) {
      this.error = e?.message || '保存失败';
      this.loading = false;
      this.requestUpdate();
    }
  }

  _startEdit(ev) {
    if (ev) ev.stopPropagation();
    this.draft = this.address;
    this.editing = true;
    this.requestUpdate();
  }

  _onDraftInput(e) {
    this.draft = e.target.value;
  }

  _onKeydown(e) {
    e.stopPropagation();
    if (e.key === 'Enter') this._submitAddress(e);
    if (e.key === 'Escape') {
      this.editing = false;
      this.requestUpdate();
    }
  }

  /** 延迟 → 信号格数 */
  _bars() {
    const st = this.status;
    if (!st) return 0;
    const lat = Number(st.latency);
    if (!Number.isFinite(lat)) return 5;
    if (lat < 60) return 5;
    if (lat < 120) return 4;
    if (lat < 250) return 3;
    if (lat < 500) return 2;
    return 1;
  }

  _playersText() {
    const p = this.status?.players;
    if (!p) return '0/0';
    const on = Number.isFinite(Number(p.online)) ? Number(p.online) : 0;
    const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 0;
    return `${on}/${max}`;
  }

  _motd() {
    return motdToText(this.status?.motd || this.status?.description || '');
  }

  _iconSrc() {
    const fav = this.status?.favicon;
    if (typeof fav === 'string' && fav.startsWith('data:image')) return fav;
    return '';
  }

  render() {
    const tier = this._tier();
    return html`
      <div class="wrap tier-${tier}">
        ${this.editing ? this._renderEditor(tier) : this._renderBody(tier)}
      </div>
    `;
  }

  /** 未配置时的地址输入态 */
  _renderEditor(tier) {
    // 只有 full 档有空间放标题和提示，其它档位只给输入框 + 按钮
    const withHint = tier === 'full';
    return html`
      <div class="editor" @click=${(e) => e.stopPropagation()}>
        ${withHint ? html`<div class="editor-label">Minecraft 服务器地址</div>` : ''}
        <div class="editor-row">
          <input
            class="addr-input"
            type="text"
            placeholder=${withHint ? 'play.example.com 或 192.168.1.10:25565' : '服务器地址'}
            .value=${this.draft}
            @input=${this._onDraftInput}
            @keydown=${this._onKeydown}
            @click=${(e) => e.stopPropagation()}
          />
          <button class="go" @click=${this._submitAddress}>查询</button>
        </div>
        ${withHint
          ? html`<div class="editor-hint">
              ${this.error
                ? html`<span class="err">${this.error}</span>`
                : '不写端口时自动查 SRV 记录，仍找不到则用 25565'}
            </div>`
          : ''}
      </div>
    `;
  }

  /** 已配置时的信息展示 */
  _renderBody(tier) {
    const st = this.status;
    const online = !!st;
    // 只有 full 档展示地址和 MOTD，mini / square 只给图标 + 人数 + 信号
    const showText = tier === 'full';
    const showTime = tier === 'full';

    return html`
      <div
        class="card ${online ? 'on' : 'off'} tier-${tier}"
        title=${this.error || this.address}
        @click=${this._startEdit}
      >
        <div class="icon-box">
          ${this._iconSrc()
            ? html`<img class="icon" src=${this._iconSrc()} alt="" />`
            : html`<div class="icon-fallback">?</div>`}
        </div>

        ${showText
          ? html`
              <div class="main">
                <div class="addr">${this.address}</div>
                <div class="motd">${this._motd() || (this.error ? this.error : '—')}</div>
              </div>
            `
          : ''}

        <div class="right ${showTime ? 'with-time' : ''}">
          <div class="players">
            <span class="pcount">${this._playersText()}</span>
            ${this._renderBars()}
          </div>
          ${showTime
            ? html`<div class="time">${this.updatedAt || (this.loading ? '查询中…' : '')}</div>`
            : ''}
        </div>
      </div>
    `;
  }

  _renderBars() {
    const n = this._bars();
    const online = !!this.status;
    return html`
      <span class="bars ${online ? '' : 'dead'}">
        ${[1, 2, 3, 4, 5].map(
          (i) => html`<i class="bar ${i <= n ? 'lit' : ''}" style="height:${30 + i * 14}%"></i>`
        )}
      </span>
    `;
  }

  static styles = [
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
        border-radius: 20px;
        font-family: 'MSLXMojangles', 'MSLXUnifont', Consolas, monospace;
        -webkit-font-smoothing: none;
        font-smooth: never;
        image-rendering: pixelated;
      }

      .wrap {
        height: 100%;
        width: 100%;
        box-sizing: border-box;
        border-radius: 20px;
        overflow: hidden;
        /* 深色底 + 极细噪点，接近 MC 服务器列表的暗色条目 */
        background-color: #161616;
        background-image: radial-gradient(
            circle at 50% 50%,
            rgba(255, 255, 255, 0.022) 0.5px,
            transparent 0.5px
          ),
          radial-gradient(circle at 0% 0%, rgba(255, 255, 255, 0.03) 0.5px, transparent 0.5px);
        background-size: 3px 3px, 4px 4px;
        color: #ffffff;
        display: flex;
        align-items: stretch;
      }

      /* 内边距按档位，宽卡片左右留白小一点避免空白过多 */
      .wrap.tier-mini {
        padding: 6px 8px;
      }
      .wrap.tier-square {
        padding: 12px;
      }
      .wrap.tier-full {
        padding: 8px 12px;
      }

      /* ================= 信息态 ================= */
      .card {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-width: 0;
        cursor: pointer;
      }

      .icon-box {
        flex: 0 0 auto;
        border-radius: 4px;
        overflow: hidden;
        background: #0d0d0d;
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .tier-mini .icon-box {
        width: 44px;
        height: 44px;
      }
      .tier-square .icon-box {
        width: 64px;
        height: 64px;
      }
      .tier-full .icon-box {
        width: 52px;
        height: 52px;
      }
      .icon {
        width: 100%;
        height: 100%;
        object-fit: cover;
        image-rendering: pixelated;
      }
      .icon-fallback {
        font-size: 20px;
        color: #3a3a3a;
      }
      .card.off .icon-box {
        filter: grayscale(1) brightness(0.6);
      }

      .main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 2px;
      }

      .addr {
        color: #ffffff;
        letter-spacing: 0.4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.8);
        line-height: 1.2;
      }
      /* full 档给足基准字号，溢出时由 _fitText() 按文本长度缩回去 */
      .tier-full .addr {
        font-size: 17px;
      }

      .motd {
        color: #b9b9b9;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.8);
      }
      .tier-full .motd {
        font-size: 12.5px;
      }

      /* 右侧：人数 + 信号（+ 时间） */
      .right {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        justify-content: center;
        gap: 3px;
      }
      .right.with-time {
        align-self: stretch;
        justify-content: space-between;
        padding: 1px 0;
      }

      .players {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .tier-mini .players {
        gap: 7px;
      }
      .pcount {
        color: #ffffff;
        letter-spacing: 0.3px;
        text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.8);
        font-size: 13px;
      }
      .tier-mini .pcount {
        font-size: 15px;
      }
      .tier-square .pcount {
        font-size: 19px;
      }
      .tier-full .pcount {
        font-size: 14px;
      }
      .card.off .pcount {
        color: #7a7a7a;
      }

      /* 信号条：5 根递增的柱子 */
      .bars {
        display: flex;
        align-items: flex-end;
        gap: 1px;
        height: 14px;
      }
      .tier-mini .bars {
        height: 16px;
      }
      .tier-square .bars {
        height: 20px;
      }
      .tier-square .bar {
        width: 4px;
      }
      .bar {
        display: block;
        width: 3px;
        background: rgba(255, 255, 255, 0.14);
        border-radius: 0;
      }
      .bar.lit {
        background: #4ade4a;
        box-shadow: 0 0 3px rgba(74, 222, 74, 0.55);
      }
      .bars.dead .bar {
        background: rgba(255, 255, 255, 0.1);
      }

      .time {
        font-size: 9.5px;
        color: #616161;
        letter-spacing: 0.2px;
        white-space: nowrap;
      }

      /* ================= 输入态 ================= */
      .editor {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 5px;
        width: 100%;
        min-width: 0;
      }
      .editor-label {
        font-size: 10px;
        color: #8f8f8f;
        letter-spacing: 0.3px;
      }
      .editor-row {
        display: flex;
        gap: 6px;
        min-width: 0;
      }
      .addr-input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        padding: 5px 8px;
        background: #0b0b0b;
        border: 2px solid #3a3a3a;
        border-radius: 0;
        color: #ffffff;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }
      .tier-mini .addr-input {
        padding: 4px 6px;
        font-size: 11px;
      }
      .addr-input::placeholder {
        color: #5a5a5a;
      }
      .addr-input:focus {
        border-color: #55ff55;
      }
      .go {
        flex: 0 0 auto;
        padding: 5px 10px;
        background: #6f6f6f;
        border: 2px solid #000000;
        box-shadow: inset -2px -2px 0 #373737, inset 2px 2px 0 #b9b9b9;
        color: #ffffff;
        font-family: inherit;
        font-size: 11px;
        cursor: pointer;
        text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.7);
      }
      .tier-mini .go {
        padding: 4px 8px;
        font-size: 10px;
      }
      .go:hover {
        background: #8b8b8b;
      }
      .go:active {
        box-shadow: inset 2px 2px 0 #373737, inset -2px -2px 0 #b9b9b9;
      }
      .editor-hint {
        font-size: 9.5px;
        color: #6a6a6a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .editor-hint .err {
        color: #ff7b7b;
      }
    `,
  ];
}

/** 当前时间，格式与参考图一致：2026-10-31 15:04:16 */
function formatNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
