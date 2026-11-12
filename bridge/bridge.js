function __foliaBridgeSource() {
		const http = require('http');
		const crypto = require('crypto');
		const fs = require('fs');
		const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
		const clients = new Set();
		// 快照：新客户端连入时立即重放当前状态（Folia 连上后不用等下次切歌才有数据）
		let lastTrack = null, lastLyric = null, lastProgressMs = null, lastPaused = null;
		function encodeFrame(buf) {
			const len = buf.length;
			if (len < 126) { const h = Buffer.alloc(2); h[0] = 0x81; h[1] = len; return Buffer.concat([h, buf]); }
			if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); return Buffer.concat([h, buf]); }
			const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return Buffer.concat([h, buf]);
		}
		function sendSocket(socket, event, data) {
			try { socket.write(encodeFrame(Buffer.from(JSON.stringify({ event, data }), 'utf8'))); } catch (e) { try { clients.delete(socket); } catch (_) {} }
		}
		function broadcast(event, data) {
			if (clients.size === 0) return;
			const frame = encodeFrame(Buffer.from(JSON.stringify({ event, data }), 'utf8'));
			for (const c of clients) { try { c.write(frame); } catch (e) { clients.delete(c); } }
		}
		const server = http.createServer((req, res) => {
			if (req.method === 'POST' && req.url === '/push') {
				let body = '';
				req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
				req.on('end', () => {
					try {
						const j = JSON.parse(body);
						if (j.event === 'Track') lastTrack = j.data;
						else if (j.event === 'Lyric') lastLyric = j.data;
						else if (j.event === 'PlayerProgress' && j.data) lastProgressMs = j.data.progress;
						else if (j.event === 'PlayerPauseState' && j.data) lastPaused = !!j.data.isPaused;
						broadcast(j.event, j.data);
						res.writeHead(200); res.end('ok');
					} catch (e) { res.writeHead(400); res.end('bad'); }
				});
				return;
			}
			if (req.url === '/health') { res.writeHead(200); res.end('folia-bridge ok, clients=' + clients.size); return; }
			res.writeHead(404); res.end();
		});
		server.on('upgrade', (req, socket) => {
			if (!req.url || req.url.indexOf('/api/ws/lyric') !== 0) { socket.destroy(); return; }
			const key = req.headers['sec-websocket-key'];
			if (!key) { socket.destroy(); return; }
			const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
			socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
			socket.setNoDelay(true);
			clients.add(socket);
			// 快照重放：Track → Lyric → 进度 → 播放态
			if (lastTrack) sendSocket(socket, 'Track', lastTrack);
			if (lastLyric) sendSocket(socket, 'Lyric', lastLyric);
			if (lastProgressMs !== null && lastProgressMs !== undefined) sendSocket(socket, 'PlayerProgress', { progress: lastProgressMs });
			if (lastPaused !== null && lastPaused !== undefined) sendSocket(socket, 'PlayerPauseState', { hasSong: true, isPaused: lastPaused, seekbarCurrentPosition: Math.round((lastProgressMs || 0)) });
			socket.on('close', () => clients.delete(socket));
			socket.on('error', () => clients.delete(socket));
			socket.on('data', () => {});
		});
		server.on('error', (e) => {
			if (e && e.code === 'EADDRINUSE') {
				// 旧桥还没退出：500ms 后重试监听（最多 ~15 次），不直接退
				let tries = 0;
				const retry = () => {
					if (tries++ > 30) return;
					setTimeout(() => {
						try { server.close(); } catch (_) {}
						server.listen(9863, '127.0.0.1');
					}, 500);
				};
				retry();
				return;
			}
			process.exit(0);
		});
		server.listen(9863, '127.0.0.1');
		try { fs.writeFileSync('C:\\betterncm\\folia-bridge\\bridge.pid', String(process.pid)); } catch (e) {}
	}
__foliaBridgeSource();
