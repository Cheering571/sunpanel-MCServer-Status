#!/usr/bin/env bash
#
# Minecraft 状态桥接服务 —— Linux 一键安装脚本
#
# 用法：
#   sudo bash install.sh              # 默认端口 8848
#   sudo bash install.sh 9000         # 自定义端口
#   sudo bash install.sh --uninstall  # 卸载
#
# 做的事情：
#   1. 把 bridge.py 复制到 /opt/mcserver-bridge/
#   2. 注册 systemd 服务并开机自启
#   3. 检查依赖（python3 / dig）
#
set -euo pipefail

SERVICE_NAME="mcserver-bridge"
INSTALL_DIR="/opt/mcserver-bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "==> 停止并移除服务"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  echo "已卸载"
  exit 0
fi

PORT="${1:-8848}"

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash install.sh" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 python3，请先安装：apt install -y python3" >&2
  exit 1
fi

# dig 用于 SRV 解析，缺失只影响公网域名，不阻断安装
if ! command -v dig >/dev/null 2>&1; then
  echo "提示：未找到 dig，公网域名的 SRV 记录将无法解析"
  echo "      安装方法：apt install -y dnsutils  或  apk add bind-tools"
fi

echo "==> 安装到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/bridge.py" "$INSTALL_DIR/bridge.py"

echo "==> 写入 systemd 服务"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Minecraft Server List Ping Bridge
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/bridge.py --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 1

if systemctl is-active --quiet "$SERVICE_NAME"; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo ""
  echo "✅ 安装完成，服务已在 ${PORT} 端口监听"
  echo ""
  echo "   微应用配置页的「服务地址」填："
  echo "     http://${IP:-127.0.0.1}:${PORT}"
  echo ""
  echo "   自检：curl http://127.0.0.1:${PORT}/health"
else
  echo "❌ 服务启动失败，查看日志：journalctl -u ${SERVICE_NAME} -n 50" >&2
  exit 1
fi
