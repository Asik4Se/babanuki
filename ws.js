// 依存パッケージなしの最小WebSocketサーバー実装（RFC 6455）
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

class WSConn extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.open = true;
    this.lastSeen = Date.now();
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.on('end', () => this._closed());
    if (head && head.length) this._onData(head);
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.destroy();
        len = b.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.destroy();
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.slice(off + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    if (op === 0x0) {
      if (!this.fragments) return;
      this.fragments.push(payload);
      if (fin) {
        const all = Buffer.concat(this.fragments);
        this.fragments = null;
        this.emit('message', all.toString('utf8'));
      }
    } else if (op === 0x1) {
      if (fin) this.emit('message', payload.toString('utf8'));
      else this.fragments = [payload];
    } else if (op === 0x8) {
      this._write(0x8, Buffer.alloc(0));
      this.destroy();
    } else if (op === 0x9) {
      this._write(0xA, payload);
    }
    // 0xA (pong) は lastSeen 更新のみ
  }

  _write(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 127;
      header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this.destroy(); }
  }

  send(str) { this._write(0x1, Buffer.from(str, 'utf8')); }
  ping() { this._write(0x9, Buffer.alloc(0)); }

  close() {
    this._write(0x8, Buffer.alloc(0));
    const s = this.socket;
    setTimeout(() => { try { s.destroy(); } catch (e) {} }, 300);
    this._closed();
  }

  destroy() {
    try { this.socket.destroy(); } catch (e) {}
    this._closed();
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

function handleUpgrade(req, socket, head, onConn) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  onConn(new WSConn(socket, head));
}

module.exports = { handleUpgrade };
