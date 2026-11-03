"""Minecraft Server List Ping 协议最小实现（验证用）"""
import json
import socket
import struct
import sys


def pack_varint(n: int) -> bytes:
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += struct.pack('B', b | 0x80)
        else:
            out += struct.pack('B', b)
            return out


def pack_string(s: str) -> bytes:
    b = s.encode('utf-8')
    return pack_varint(len(b)) + b


def read_varint(sock) -> int:
    num = 0
    for i in range(5):
        b = sock.recv(1)
        if not b:
            raise EOFError('socket closed while reading varint')
        num |= (b[0] & 0x7F) << (7 * i)
        if not (b[0] & 0x80):
            return num
    raise ValueError('varint too long')


def ping(host: str, port: int = 25565, timeout: float = 5.0) -> dict:
    s = socket.create_connection((host, port), timeout=timeout)
    try:
        # Handshake: proto=0, version=763(1.20.1 占位), host, port, next=1(status)
        payload = (
            pack_varint(0)
            + pack_varint(763)
            + pack_string(host)
            + struct.pack('>H', port)
            + pack_varint(1)
        )
        s.sendall(pack_varint(len(payload)) + payload)
        # Status Request
        s.sendall(pack_varint(1) + pack_varint(0))

        read_varint(s)          # 包长度
        read_varint(s)          # packet id (0x00)
        slen = read_varint(s)   # json 字符串长度

        data = b''
        while len(data) < slen:
            chunk = s.recv(slen - len(data))
            if not chunk:
                break
            data += chunk
        return json.loads(data.decode('utf-8'))
    finally:
        s.close()


if __name__ == '__main__':
    host = sys.argv[1] if len(sys.argv) > 1 else '192.168.1.100'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 25565
    try:
        r = ping(host, port)
        print('OK')
        print('version :', r.get('version'))
        print('players :', r.get('players'))
        desc = r.get('description')
        print('motd    :', json.dumps(desc, ensure_ascii=False)[:300])
        fav = r.get('favicon')
        print('favicon :', (fav[:48] + '...') if fav else '(none)')
    except Exception as e:
        print('FAIL:', type(e).__name__, e)
