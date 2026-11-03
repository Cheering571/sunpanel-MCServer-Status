#!/usr/bin/env python3
"""
Minecraft 服务器状态桥接服务

为什么需要它
------------
Sun-Panel 微应用只能发 HTTP 请求（由主应用后端代理），
而 Minecraft 服务器列表查询走的是 TCP 上的自定义协议
（Server List Ping / SLP）。

这个小服务把 HTTP 翻译成 SLP：

    GET /status?host=192.168.31.102&port=25565
    GET /health

只用 Python 标准库，单文件即可运行：

    python3 bridge.py --port 8848

可选参数：
    --host 0.0.0.0      监听地址
    --port 8848         监听端口
    --timeout 5         SLP 查询超时（秒）
    --cache 3           相同地址的结果缓存秒数
"""

import argparse
import json
import re
import select
import socket
import struct
import subprocess
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = '1.0.0'
DEFAULT_PORT = 25565

# VarInt 类型最大字节数
MAX_VARINT_BYTES = 5


# ---------------------------------------------------------------- VarInt
def pack_varint(n: int) -> bytes:
    """把整数编码成 Protocol VarInt"""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def pack_string(s: str) -> bytes:
    raw = s.encode('utf-8')
    return pack_varint(len(raw)) + raw


def read_varint(sock: socket.socket):
    """从 socket 读一个 VarInt，返回 (值, 剩余超时是否耗尽)"""
    num = 0
    for i in range(MAX_VARINT_BYTES):
        ch = sock.recv(1)
        if not ch:
            raise EOFError('连接被对端关闭')
        num |= (ch[0] & 0x7F) << (7 * i)
        if not (ch[0] & 0x80):
            return num
    raise ValueError('VarInt 过长')


# ---------------------------------------------------------------- SLP
def slp_query(host: str, port: int = DEFAULT_PORT, timeout: float = 5.0) -> dict:
    """
    执行一次 Server List Ping，返回服务器原始 JSON 与测得延迟
    """
    started = time.time()
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        sock.settimeout(timeout)

        # ---- Handshake：protocol=0、host、port、next=1(status)
        payload = (
            pack_varint(0x00)
            + pack_varint(0)
            + pack_string(host)
            + struct.pack('>H', port)
            + pack_varint(1)
        )
        sock.sendall(pack_varint(len(payload)) + payload)

        # ---- Status Request
        sock.sendall(pack_varint(1) + pack_varint(0x00))

        length = read_varint(sock)
        if length <= 0:
            raise ValueError('响应长度为 0')

        read_varint(sock)          # packet id 应为 0x00
        str_len = read_varint(sock)  # JSON 字符串字节长度

        buf = bytearray()
        while len(buf) < str_len:
            chunk = sock.recv(min(65536, str_len - len(buf)))
            if not chunk:
                raise EOFError('读取 JSON 时连接中断')
            buf.extend(chunk)

        latency_ms = int((time.time() - started) * 1000)
        data = json.loads(buf.decode('utf-8', errors='replace'))
        return {'raw': data, 'latency': latency_ms}
    finally:
        try:
            sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- MOTD
COLOR_CODE = re.compile(r'\u00a7[0-9a-fk-orx]', re.IGNORECASE)


def motd_to_text(desc) -> str:
    """
    MC 1.13+ 的 description 可能是：
      字符串 / {text, extra:[...]} / 数组
    这里统一摊平成纯文本，并去掉 § 颜色代码。
    """
    if desc is None:
        return ''
    if isinstance(desc, str):
        return COLOR_CODE.sub('', desc)
    if isinstance(desc, list):
        return ''.join(motd_to_text(x) for x in desc)
    if isinstance(desc, dict):
        out = ''
        if isinstance(desc.get('text'), str):
            out += desc['text']
        extra = desc.get('extra')
        if isinstance(extra, list):
            out += ''.join(motd_to_text(x) for x in extra)
        return COLOR_CODE.sub('', out)
    return ''


# ---------------------------------------------------------------- 缓存
class TTLCache:
    """极简 TTL 缓存，避免同一地址被并发重复 ping"""

    def __init__(self, ttl: float):
        self.ttl = ttl
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key):
        if self.ttl <= 0:
            return None
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            value, expire_at = item
            if time.time() > expire_at:
                self._data.pop(key, None)
                return None
            return value

    def set(self, key, value):
        if self.ttl <= 0:
            return
        with self._lock:
            self._data[key] = (value, time.time() + self.ttl)


cache = TTLCache(3.0)


# ---------------------------------------------------------------- 查询封装
# ---------------------------------------------------------------- SRV
IPV4_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')


def is_ip_literal(host: str) -> bool:
    """判断是不是直接写的 IP（IPv4 或 IPv6）"""
    if IPV4_RE.match(host):
        return True
    return ':' in host


def resolve_srv(host: str):
    """
    查 _minecraft._tcp.<host> 的 SRV 记录。

    很多公网服务器只配了 SRV（把 mc.example.com 指到 play.example.com:25570），
    A 记录并不指向真正开放的 MC 端口，直连默认 25565 必然失败。

    返回 {'target':..., 'port':...} 或 None
    """
    try:
        proc = subprocess.run(
            ['dig', '+short', 'SRV', f'_minecraft._tcp.{host}'],
            capture_output=True, text=True, timeout=4,
        )
        text = (proc.stdout or '').strip()
        if not text:
            return None
        # 形如：0 5 25565 play.example.com.
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 4:
                try:
                    port = int(parts[2])
                except ValueError:
                    continue
                target = parts[3].rstrip('.').strip()
                if target and 0 < port < 65536:
                    return {'target': target, 'port': port}
    except Exception:
        pass
    return None


def query_status(host: str, port: int, timeout: float, retry: int = 1,
                 allow_srv: bool = True) -> dict:
    key = f'{host}:{port}:{allow_srv}'
    hit = cache.get(key)
    if hit is not None:
        return hit

    # 只有「域名 + 默认端口」才尝试 SRV，IP 和显式端口不折腾
    srv_note = ''
    if allow_srv and port == DEFAULT_PORT and not is_ip_literal(host):
        srv = resolve_srv(host)
        if srv:
            srv_note = f'{host} → {srv["target"]}:{srv["port"]}（SRV）'
            host, port = srv['target'], srv['port']

    last_err = None
    raw = None
    latency = 0

    # FRP / 反向代理后面的服务器首次连接可能较慢，失败再试一次
    for attempt in range(max(1, retry + 1)):
        try:
            result = slp_query(host, port, timeout)
            raw = result['raw']
            latency = result['latency']
            last_err = None
            break
        except socket.gaierror as e:
            last_err = f'域名解析失败：{host}（{e}）'
            break  # 解析失败没必要重试
        except socket.timeout:
            last_err = f'连接超时：{host}:{port}'
        except ConnectionRefusedError:
            last_err = f'端口拒绝连接：{host}:{port}'
        except EOFError:
            last_err = f'对端提前断开，可能不是 Minecraft 服务：{host}:{port}'
        except json.JSONDecodeError:
            last_err = f'返回内容不是合法 JSON，可能不是 Minecraft 服务：{host}:{port}'
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'

    if last_err is not None:
        payload = {
            'ok': False,
            'host': host,
            'port': port,
            'online': False,
            'error': last_err,
            'srv': srv_note,
            'queriedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
        }
    else:
        raw = raw or {}
        players = raw.get('players') or {}
        version = raw.get('version') or {}
        desc = raw.get('description')
        payload = {
            'ok': True,
            'host': host,
            'port': port,
            'online': True,
            'version': version.get('name') or '',
            'protocol': version.get('protocol'),
            'players': {
                'online': players.get('online', 0),
                'max': players.get('max', 0),
                'sample': players.get('sample') or [],
            },
            'motd': desc,
            'motdText': motd_to_text(desc),
            'favicon': raw.get('favicon') or '',
            'latency': latency,
            'srv': srv_note,
            'queriedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
        }

    cache.set(key, payload)
    return payload


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = f'MCServerBridge/{VERSION}'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        # 默认会打到 stderr，改成简短格式
        print(f'[{datetime.now():%H:%M:%S}] {self.address_string()} {fmt % args}')

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        if path == '/health':
            self._send(200, {
                'ok': True,
                'version': VERSION,
                'service': 'mcserver-bridge',
            })
            return

        if path == '/status':
            qs = parse_qs(parsed.query)
            host = (qs.get('host') or [''])[0].strip()
            port_raw = (qs.get('port') or [str(DEFAULT_PORT)])[0].strip()

            if not host:
                self._send(400, {'ok': False, 'error': '缺少参数 host'})
                return
            try:
                port = int(port_raw)
                if not (0 < port < 65536):
                    raise ValueError
            except ValueError:
                self._send(400, {'ok': False, 'error': f'端口不合法: {port_raw}'})
                return

            payload = query_status(host, port, self.server.slp_timeout, self.server.slp_retry)
            self._send(200, payload)
            return

        self._send(404, {
            'ok': False,
            'error': '未知路径，可用：/health、/status?host=&port=',
        })


def main():
    ap = argparse.ArgumentParser(description='Minecraft Server List Ping 桥接服务')
    ap.add_argument('--host', default='0.0.0.0', help='监听地址')
    ap.add_argument('--port', type=int, default=8848, help='监听端口')
    ap.add_argument('--timeout', type=float, default=5.0, help='SLP 查询超时（秒）')
    ap.add_argument('--cache', type=float, default=3.0, help='结果缓存秒数，0 为关闭')
    ap.add_argument('--retry', type=int, default=1, help='失败重试次数')
    args = ap.parse_args()

    global cache
    cache = TTLCache(args.cache)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    httpd.slp_timeout = args.timeout
    httpd.slp_retry = max(0, args.retry)

    print(f'Minecraft 状态桥接服务 v{VERSION}')
    print(f'监听 http://{args.host}:{args.port}')
    print(f'  GET /health')
    print(f'  GET /status?host=<host>&port=<port>')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
