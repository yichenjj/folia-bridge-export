/**
 * Folia Bridge — 纯桥接数据泵（零 UI 接管）
 *
 * 职责：播放状态 → HTTP POST → Node 桥(9863) → Folia Now Playing
 *  1. 播放状态接入：Load / End / PlayProgress / PlayState（3.x channel，2.x 兜底）
 *  2. Redux store 挖取：歌名 / 歌手 / 歌曲id / 封面
 *  3. yrc 逐字歌词拉取（NetEase + AMLLDB 兜底 + ttmlToYrc）
 *  4. 四事件推桥：Track / Lyric / PlayerProgress(250ms 节流) / PlayerPauseState
 *  5. ensureBridge：启动写盘 bridge.js 并 app.exec 拉起 Node
 * 与 RefinedNowPlayingNext 等插件共存：不做全屏界面 / HUD / canvas / FFT。
 */
(async () => {
	const TAG = "[folia-ncm]";
	const log = (...a) => console.log(TAG, ...a);
	const warn = (...a) => console.warn(TAG, ...a);

	// 更稳的 AsyncFunction（BetterNCM loader 同款方式执行 ui.js，绕开页面 CSP 对外链脚本的限制）
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

	// ---------------- electron 桥占位（防止 Folia 链路上的意外访问直接炸掉） ----------------
	try {
		if (typeof window.electron === "undefined") {
			window.electron = new Proxy(function () {}, {
				get: (_t, p) => {
					if (p === Symbol.toPrimitive || p === "then") return undefined;
					return (..._a) => {
						warn("electron stub 被调用:", String(p));
						return undefined;
					};
				},
				apply: () => undefined,
			});
		}
	} catch (e) { /* noop */ }

	// ---------------- 状态（仅桥接所需） ----------------
	const S = {
		ncm: (typeof APP_CONF !== "undefined" && APP_CONF && APP_CONF.appver) || "?",
		song: "—",
		artists: "",
		songId: "",
		coverUrl: null,
		duration: 0,
		progress: 0,
		playState: "—",
		yrc: "等一首歌",
	};

	// 播放时钟：base = 最近一次权威进度(秒)，at = 该进度对应的 Date.now()
	const clock = { base: 0, at: Date.now(), playing: false, duration: 0 };
	// audioId 持久化：页面热重载后歌曲不会重新 Load，没有它 seek 会静默失效
	let lastAudioId = (() => {
		try { return localStorage.getItem("folia_audio_id") || ""; } catch (e) { return ""; }
	})();
	let lastProgress = 0;
	let rafHandle = 0;
	let progressCount = 0;
	// 原始歌词缓存（供周期重推 Track/Lyric 用）
	let lastYrcRaw = null;
	let lastTlyricRaw = null;
	let lastLrcRaw = null;

	// ---------------- 通道注册（3.x channel.registerCall，2.x legacyNativeCmder 兜底） ----------------
	function reg(name, cb) {
		try {
			if (typeof channel !== "undefined" && channel && channel.registerCall) {
				channel.registerCall("audioplayer.on" + name, (...args) => {
					try { cb(...args); } catch (e) { warn(name, e); }
				});
				DIAG.regs[name] = "channel";
				return "channel";
			}
			if (typeof legacyNativeCmder !== "undefined" && legacyNativeCmder && legacyNativeCmder.appendRegisterCall) {
				legacyNativeCmder.appendRegisterCall(name, "audioplayer", (...args) => {
					try { cb(...args); } catch (e) { warn(name, e); }
				});
				DIAG.regs[name] = "legacy";
				return "legacy";
			}
		} catch (e) { warn("reg", name, e); DIAG.regs[name] = "error:" + (e && e.message); }
		return null;
	}

	// ---------------- Redux store 挖取（3.x） ----------------
	function digStore(root) {
		try {
			let r = root && root._reactRootContainer && root._reactRootContainer._internalRoot;
			if (!r && root) {
				const k = Object.keys(root).find((k) => k.indexOf("__reactContainer$") === 0);
				if (k) r = root[k];
			}
			if (!r || !r.current) return null;
			const n = r.current;
			return (n.child && n.child.child && n.child.child.memoizedProps && n.child.child.memoizedProps.store) || null;
		} catch (e) { return null; }
	}
	async function findStore() {
		for (let i = 0; i < 40; i++) {
			const store = digStore(document.getElementById("root"));
			if (store) return store;
			await new Promise((r) => setTimeout(r, 250));
		}
		return null;
	}

	let storeRef = null;
	let lastMetaKey = "";

	function updateSongFromStore() {
		if (!storeRef) return;
		try {
			const p = storeRef.getState().playing;
			if (!p) return;
			// 某些歌的 Load 回调 duration=0（流探测中）：从 store 兜底拿真实时长
			if (!clock.duration || clock.duration <= 0) {
				const d = (p.curTrack && p.curTrack.duration) || p.duration || 0;
				if (d > 0) {
					clock.duration = d > 10000 ? d / 1000 : d;
					S.duration = clock.duration;

				}
			}
			if (p.resourceName) S.song = p.resourceName;
			if (p.resourceArtists) S.artists = p.resourceArtists.map((a) => a.name).join(", ");
			const id = String(p.resourceTrackId || "").trim();
			const cover = p.resourceCoverUrl || null;
			S.coverUrl = cover;
			const key = id + "|" + S.song + "|" + (cover || "");
				if (key !== lastMetaKey) {
					lastMetaKey = key;
					if (id) S.songId = id;

					pushToBridge("Track", {
						author: (p.resourceArtists ? p.resourceArtists.map((a) => a.name).join(", ") : S.artists),
						title: S.song,
						album: "",
						cover: cover || "",
						duration: S.duration,
						id: id || S.songId || "ncm-unknown",
					});
					if (id && id !== S.songId + "|stale") fetchLyrics(id);
				}
		} catch (e) { warn("updateSong", e); }
	}

	// ---------------- yrc 逐字歌词 ----------------

	// AMLLDB TTML → { yrc, tlyric, romalrc }（api.amll.dev 按 ncmMusicId 查，Apple 风格逐字，社区维护）。
	// 每个 <p> 里：带 begin 的 <span> 是逐字文本；ttm:role="x-translation" 是整行中文翻译；
	// ttm:role="x-roman" 是整行罗马音。翻译/罗马音输出成 LRC 行（[mm:ss.xx]文本）喂 parseYRC 的
	// 对应参数。时间格式处理 MM:SS.mmm / HH:MM:SS.mmm / 1.2s / 1200ms。
	function ttmlToYrc(ttml) {
		try {
			const toMs = (t) => {
				if (!t) return -1;
				t = String(t).trim();
				let m = t.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
				if (m) return Math.round(((m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + +m[3]) * 1000);
				m = t.match(/^(\d+(?:\.\d+)?)s$/);
				if (m) return Math.round(+m[1] * 1000);
				m = t.match(/^(\d+)ms$/);
				if (m) return +m[1];
				m = t.match(/^(\d+(?:\.\d+)?)$/);
				if (m) return Math.round(+m[1] * 1000);
				return -1;
			};
			const lrcTime = (ms) => {
				const total = Math.max(0, Math.floor(ms / 10)); // 厘秒
				const cs = total % 100, sec = Math.floor(total / 100) % 60, min = Math.floor(total / 6000);
				return String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0") + "." + String(cs).padStart(2, "0");
			};
			const decode = (s) => s
				.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
			const yrcLines = [], tLines = [], rLines = [];
			const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
			let pm;
			while ((pm = pRe.exec(ttml)) !== null) {
				const attrs = pm[1];
				const start = toMs((attrs.match(/begin="([^"]*)"/) || [])[1]);
				const end = toMs((attrs.match(/end="([^"]*)"/) || [])[1]);
				if (start < 0) continue;
				const inner = pm[2];
				// 整行翻译 / 罗马音（无 begin 属性的 role span）
				const transMatch = inner.match(/<span\b[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/);
				const romaMatch = inner.match(/<span\b[^>]*ttm:role="x-roman"[^>]*>([\s\S]*?)<\/span>/);
				const transText = transMatch ? decode(transMatch[1]).trim() : "";
				const romaText = romaMatch ? decode(romaMatch[1]).trim() : "";
				if (transText) tLines.push("[" + lrcTime(start) + "]" + transText);
				if (romaText) rLines.push("[" + lrcTime(start) + "]" + romaText);
				// 逐字 span（有 begin 的才算词，翻译/罗马音 span 没有 begin 会被自然跳过）
				const spanRe = /<span\b[^>]*?begin="([^"]*)"[^>]*?(?:end="([^"]*)")?[^>]*>([\s\S]*?)<\/span>/g;
				let words = "";
				let sm;
				let any = false;
				while ((sm = spanRe.exec(inner)) !== null) {
					const ws = toMs(sm[1]);
					const we = toMs(sm[2]);
					const txt = decode(sm[3]).replace(/\s+/g, " ");
					if (!txt.trim()) continue;
					const wStart = ws >= 0 ? ws : start;
					const wDur = Math.max(1, (we >= 0 ? we : wStart + 300) - wStart);
					words += "(" + wStart + "," + wDur + ",0)" + txt;
					any = true;
				}
				if (!any) {
					// 无逐字 span 的行级 TTML：整行当一个词
					const stripped = decode(inner.replace(/<span\b[^>]*ttm:role="x-(?:translation|roman)"[^>]*>[\s\S]*?<\/span>/g, "")
						.replace(/<[^>]*>/g, "")).trim();
					if (!stripped) continue;
					words = "(" + start + "," + Math.max(200, (end >= 0 ? end : start + 3000) - start) + ",0)" + stripped;
				}
				const dur = Math.max(200, (end >= 0 ? end : start + 4000) - start);
				yrcLines.push("[" + start + "," + dur + "]" + words);
			}
			if (yrcLines.length === 0) return null;
			return {
				yrc: yrcLines.join("\n"),
				tlyric: tLines.length > 0 ? tLines.join("\n") : null,
				romalrc: rLines.length > 0 ? rLines.join("\n") : null,
			};
		} catch (e) {
			warn("ttmlToYrc", e);
			return null;
		}
	}

	// NetEase 的 lrc 有时会用 JSON 行承载（[00:00.00]{"t":0,"c":[{"tx":"作词: "}]}，也可能无时间戳裸 JSON），
	// 归一化成纯文本行，否则 Folia 会把 JSON 当歌词显示
	function normalizeNeteaseLrc(txt) {
		if (!txt) return txt;
		const jsonLineToText = (body) => {
			try {
				const j = JSON.parse(body);
				if (j && Array.isArray(j.c)) return j.c.map((x) => x.tx || "").join("");
			} catch (e) { /* 非 JSON 原样返回 null 标记 */ }
			return null;
		};
		return txt.split("\n").map((l) => {
			const trimmed = l.trim();
			if (trimmed.startsWith("{")) {
				const text = jsonLineToText(trimmed);
				return text === null ? l : text;
			}
			const m = l.match(/^(\[[^\]]*\])([\s\S]*)$/);
			if (!m) return l;
			const tag = m[1];
			const body = m[2].trim();
			if (!body.startsWith("{")) return l;
			const text = jsonLineToText(body);
			return text === null ? l : tag + text;
		}).join("\n");
	}

	async function fetchLyrics(id) {
		S.yrc = "拉取中…";

		try {
			const domain = (typeof APP_CONF !== "undefined" && APP_CONF && APP_CONF.domain) || "https://music.163.com";
			const res = await fetch(domain + "/api/song/lyric/v1?tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0&cp=false&id=" + id);
			const data = await res.json();
			let yrc = (data && data.yrc && data.yrc.lyric) || null;
			let fromAmll = false;
			// 兜底：网易云没有 yrc 时查 AMLLDB（社区逐字库，按网易云 id 索引，CORS 全开）
			if (!yrc) {
				try {
					S.yrc = "网易云无逐字，查 AMLLDB…";

					const r2 = await fetch("https://api.amll.dev/v1/lyrics/get?ncmMusicId=" + id);
					if (r2.ok) {
						const j2 = await r2.json();
						const ttml = j2 && j2.data && j2.data.lyrics;
						if (ttml) {
							const converted = ttmlToYrc(ttml);
							if (converted) {
								yrc = converted.yrc;
								// AMLLDB 的翻译/罗马音轨补网易云的空缺（日语歌的罗马音主要靠这个）
								if ((!data.tlyric || !data.tlyric.lyric) && converted.tlyric) data.tlyric = { lyric: converted.tlyric };
								if ((!data.romalrc || !data.romalrc.lyric) && converted.romalrc) data.romalrc = { lyric: converted.romalrc };
								fromAmll = true;
							}
						}
					}
				} catch (e2) { warn("amll 兜底", e2); }
			}
			// 翻译/罗马音在 AMLLDB 补数之后再提取
			const tlyric = (data && data.tlyric && data.tlyric.lyric) || null;
			const romalrc = (data && data.romalrc && data.romalrc.lyric) || null;
			// 原文行级歌词（NetEase data.lrc = 原文，勿与 tlyric 混淆——填错会让 Folia 满屏中文）
			const origLrc = normalizeNeteaseLrc((data && data.lrc && data.lrc.lyric) || null);
			lastYrcRaw = yrc;
			lastTlyricRaw = tlyric;
			lastLrcRaw = origLrc;

			// Folia 互通：歌词推给桥（source=netease → Folia 按 yrc 逐字管线解析；
			// 无逐字时 Folia 回退用 lrc 字段当主歌词——必须是原文，翻译只放 translatedLyric）
			pushToBridge("Lyric", {
				source: "netease",
				title: S.song,
				author: S.artists,
				duration: S.duration,
				hasLyric: !!(yrc || origLrc),
				hasTranslatedLyric: !!tlyric,
				hasKaraokeLyric: !!yrc,
				lrc: origLrc || "",
				translatedLyric: tlyric || "",
				hasKaraokeLyric: !!yrc,
				karaokeLyric: yrc || "",
			});
			if (!yrc) {
				S.yrc = "无逐字歌词（网易+AMLLDB均无）";
			} else {
				const lines = yrc.split("\n").filter((l) => /^\[\d+,\d+\]/.test(l));
				const first = (lines[0] || "")
					.replace(/\(\d+,\d+,\d+\)/g, "")
					.replace(/^\[\d+,\d+\]/, "")
					.trim();
				S.yrc = "✓ " + lines.length + "行 " + (first || "instrumental").slice(0, 20) + (fromAmll ? " [AMLLDB]" : "");
			}

		} catch (e) {
			S.yrc = "✗ 拉取失败 " + e.message;
		}

	}

	// ---------------- 播放状态通道 ----------------
	// 诊断计数器（写入 folia-bridge/diag.txt，定位推送链路问题用）
	const DIAG = { regs: {}, progressFires: 0, loadFires: 0, pushCalls: 0, pushErrors: 0, lastPushError: "", storeOk: false };
	setInterval(() => {
		try {
			DIAG.clock = { base: Math.round(clock.base * 10) / 10, playing: clock.playing, duration: clock.duration };
			DIAG.storeRef = !!storeRef;
			DIAG.lastProgress = Math.round(lastProgress * 10) / 10;
			betterncm.fs.writeFile("folia-bridge/diag.txt", JSON.stringify(DIAG, null, 2)).catch(() => {});
		} catch (e) { /* noop */ }
	}, 5000);

	reg("Load", (audioId, info) => {
		lastAudioId = audioId || "";
		try { if (lastAudioId) localStorage.setItem("folia_audio_id", lastAudioId); } catch (e) { /* noop */ }
		if (info && info.duration) {
			S.duration = info.duration;
			clock.duration = info.duration;
		}
		clock.base = 0;
		clock.at = Date.now();
		lastProgress = 0;
		log("Load", audioId, info && info.duration);

		setTimeout(updateSongFromStore, 300);

	});
	reg("End", () => { S.playState = "unloaded"; clock.playing = false; });
	reg("PlayProgress", (audioId, progress) => {
		// Windows 上该回调逐帧阻塞渲染线程：只更新时钟，不渲染（HUD 文本 1s 间隔足够）
		const delta = progress - lastProgress;
		if (Math.abs(progress - lastProgress) > 1 || progress <= 0.01) {
			lastProgress = progress;
			return;
		}
		lastProgress = progress;
		S.progress = progress;
		clock.base = progress;
		clock.at = Date.now();
		DIAG.progressFires++;
		// 页面重载会错过 PlayState 事件：进度单调递增即为播放中（自动恢复状态）
		if (delta > 0.001 && !clock.playing) {
			clock.playing = true;
			S.playState = "▶";

		}
		// Folia 互通：精确进度 250ms 节流推送
		if (Date.now() - lastBridgeProgressPushAt > 250) {
			lastBridgeProgressPushAt = Date.now();
			pushToBridge("PlayerProgress", { progress: Math.round(progress * 1000) });
		}
		progressCount++;
	});
	// ---------------- 进度真源 v2：网易云自己的歌词行号锚定（500ms 轮询 store） ----------------
	// store.playing.playingLyricLineNumber = 网易云歌词引擎算出的当前行（它在网易云内部持续更新，
	// 不受窗口遮挡影响）。行号 → 我们 yrc 行表的 startTime = 精确锚点；行内偏移由 Folia 自己的
	// 时钟外推补齐。playingState 观测：1=播放中。行号变化（含回退）都重新锚定。
	let lastAnchorLine = null;
	setInterval(() => {
		try {
			if (!storeRef) return;
			const p = storeRef.getState().playing;
			if (!p) return;
			const st = p.playingState;
			const wasPlaying = clock.playing;
			clock.playing = st === 1;
			if (wasPlaying !== clock.playing) {
				S.playState = clock.playing ? "▶" : "⏸";
				emit("state", { paused: !clock.playing, duration: clock.duration });
				pushToBridge("PlayerPauseState", {
					hasSong: true,
					isPaused: !clock.playing,
					seekbarCurrentPosition: Math.round(clock.base * 1000),
				});
			}
			const ln = p.playingLyricLineNumber;
			DIAG.ln = ln;
			if (typeof ln === "number" && ln >= 0 && lyricTrackIndex[ln] && ln !== lastAnchorLine) {
				lastAnchorLine = ln;
				clock.base = lyricTrackIndex[ln].startMs / 1000;
				clock.at = Date.now();
			}
		} catch (e) { /* noop */ }
	}, 500);

	reg("PlayState", (audioId, stateId) => {
		const st = String(stateId).split("|")[1];
		S.playState = st === "pause" ? "⏸" : st === "resume" ? "▶" : String(stateId);
		clock.playing = st === "resume";
		if (st === "pause") clock.base = S.progress, clock.at = Date.now();

		pushToBridge("PlayerPauseState", {
			hasSong: true,
			isPaused: !clock.playing,
			seekbarCurrentPosition: Math.round(clock.base * 1000),
		});

	});

	// Folia 互通：定时器推送。NCM 窗口被遮挡/最小化时 PlayProgress 逐帧回调会骤降
	// （CEF 停止渲染 → rAF 停摆），用外推时钟每秒主动推一次，保证 Folia 舞台进度平滑。
	// 注意：外推不设 0.6s 封顶——回调断流时（窗口被遮挡）若封顶，会把 Folia 每秒拽回
	// 冻结位置（抽搐的根源）；音频引擎真实前进，base+elapsed 就是真实进度。
	setInterval(() => {
		if (clock.duration <= 0 && clock.base <= 0.01) return;
		const t = clock.playing
			? Math.min(clock.base + (Date.now() - clock.at) / 1000, clock.duration || Infinity)
			: clock.base;
		pushToBridge("PlayerProgress", { progress: Math.round(t * 1000) });
	}, 1000);

	// Folia 互通：每 10s 全量快照重置（Track/Lyric/进度/播放态）——Folia 的舞台只在事件
	// 到达时发布状态，后进舞台/中途开舞台/状态漂移的客户端靠这个定时重置回归正确显示
	// （Folia 侧按内容去重，无变化不闪烁）。
	setInterval(() => {
		if (!S.songId && S.song === "—") return;
		const t = clock.playing
			? Math.min(clock.base + (Date.now() - clock.at) / 1000, clock.duration || Infinity)
			: clock.base;
		pushToBridge("Track", {
			author: S.artists,
			title: S.song,
			album: "",
			cover: S.coverUrl || "",
			duration: clock.duration || S.duration,
			id: S.songId,
		});
		if (lastYrcRaw || lastLrcRaw) {
			pushToBridge("Lyric", {
				source: "netease",
				title: S.song,
				author: S.artists,
				duration: clock.duration || S.duration,
				hasLyric: !!(lastYrcRaw || lastLrcRaw),
				hasTranslatedLyric: !!lastTlyricRaw,
				hasKaraokeLyric: !!lastYrcRaw,
				lrc: lastLrcRaw || "",
				translatedLyric: lastTlyricRaw || "",
				hasKaraokeLyric: !!lastYrcRaw,
				karaokeLyric: lastYrcRaw || "",
			});
		}
		pushToBridge("PlayerProgress", { progress: Math.round(t * 1000) });
		pushToBridge("PlayerPauseState", {
			hasSong: true,
			isPaused: !clock.playing,
			seekbarCurrentPosition: Math.round(t * 1000),
		});
	}, 10000);

	// ---------------- Folia 互通桥：Widdit 协议 WS 服务端（9863）+ Node 桥进程 ----------------
	// Folia 原生支持被外部播放器驱动（设置→启用 Now Playing，固定连 ws://localhost:9863/api/ws/lyric）。
	// 网易云页面开不了监听端口，所以桥本体是独立 Node 进程（系统已装 Node 26）；本插件把桥源码写到
	// 磁盘并用 app.exec 拉起（端口占用即自退，幂等），再把播放状态 HTTP POST 给它广播。

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

	const BRIDGE_PUSH_URL = "http://127.0.0.1:9863/push";
	let lastBridgeProgressPushAt = 0;
	async function pushToBridge(event, data) {
		DIAG.pushCalls++;
		try {
			await fetch(BRIDGE_PUSH_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event, data }),
			});
		} catch (e) {
			DIAG.pushErrors++;
			DIAG.lastPushError = String(e && e.message);
		}
	}

	async function ensureBridge() {
		try {
			await betterncm.fs.mkdir("folia-bridge").catch(() => {});
			await betterncm.fs.writeFile("folia-bridge/bridge.js", __foliaBridgeSource.toString() + "\n__foliaBridgeSource();\n");
			// 换桥代码后旧进程要退场：读 pid 文件杀掉旧桥（pid 不是 node 也无妨，taskkill 失败即忽略）
			let oldPid = "";
			try { oldPid = await (await betterncm.fs.readFile("folia-bridge/bridge.pid")).text(); } catch (e) { /* 无 pid 文件 */ }
			const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
			if (oldPid && /^\d+$/.test(oldPid.trim())) {
				betterncm.app.exec('taskkill /F /PID ' + oldPid.trim());
			}
			betterncm.app.exec('"' + nodeExe + '" "C:\\betterncm\\folia-bridge\\bridge.js"');
			log("folia-bridge 已拉起");
		} catch (e) { warn("bridge 启动", e); }
	}

	// ---------------- 主流程 ----------------
	log("Folia Bridge 启动，注入成功");
	ensureBridge();
	storeRef = await findStore();
	if (storeRef) {
		try { storeRef.subscribe(() => updateSongFromStore()); } catch (e) { warn("subscribe", e); }
		updateSongFromStore();
	} else {
		warn("store 未找到，3s 后重试");
		setTimeout(async () => {
			storeRef = await findStore();
			if (storeRef) {
				try { storeRef.subscribe(() => updateSongFromStore()); } catch (e) { warn("subscribe", e); }
				updateSongFromStore();
			}
		}, 3000);
	}
})();