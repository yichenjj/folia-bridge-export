/**
 * Folia NCPlayer — BetterNCM 侧加载器 + 数据泵（纯 JS，热重载友好）
 *
 * 职责（宿主侧全部 NCM API 都在这里，渲染 bundle 永远不碰网易云内部接口）：
 *  1. 播放状态接入：Load / End / PlayProgress / PlayState / Volume / AudioData（3.x channel，2.x 兜底）
 *  2. Redux store 挖取：歌名 / 歌手 / 歌曲id / 封面
 *  3. yrc 逐字歌词拉取（含翻译/罗马音）
 *  4. 对外暴露 window.__foliaPump（src/bncm/pump.ts 定义契约）
 *  5. eval 同目录 ui.js（Folia 渲染 bundle，由 dev/bncm/postbuild.mjs 生成）
 *  6. HUD：阶段0 调试面板保留，数据泵状态一目了然
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

	// ---------------- 状态 ----------------
	const S = {
		bncm: "?",
		ncm: (typeof APP_CONF !== "undefined" && APP_CONF && APP_CONF.appver) || "?",
		store: false,
		song: "—",
		artists: "",
		songId: "",
		coverUrl: null,
		duration: 0,
		progress: 0,
		playState: "—",
		progressHz: 0,
		audioData: 0,
		yrc: "等一首歌",
		ui: "未加载",
		visible: false,
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

	// ---------------- 真实频谱 FFT（radix-2，1024 点，Hann 窗） ----------------
	// onAudioData 送来 Int16 交错 PCM @48kHz；分频段照 Folia usePlaybackVisualizerBridge 的范围
	const FFT_SIZE = 1024;
	const fftReal = new Float32Array(FFT_SIZE);
	const fftImag = new Float32Array(FFT_SIZE);
	const fftWindow = new Float32Array(FFT_SIZE);
	for (let i = 0; i < FFT_SIZE; i++) fftWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
	const fftOut = new Uint8Array(FFT_SIZE / 2);
	const audio = {
		power: 24,
		bands: { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0 },
		spectrum: fftOut,
		live: false,
	};

	function computeFFT(pcm) {
		const n = FFT_SIZE;
		const ch = pcm.length >= 2 * n ? 2 : 1;
		const off = pcm.length - n * ch;
		if (off < 0) return;
		for (let i = 0; i < n; i++) {
			const s = ch === 2 ? (pcm[off + i * 2] + pcm[off + i * 2 + 1]) / 2 : pcm[off + i];
			fftReal[i] = (s / 32768) * fftWindow[i];
			fftImag[i] = 0;
		}
		for (let i = 1, j = 0; i < n; i++) {
			let bit = n >> 1;
			for (; j & bit; bit >>= 1) j ^= bit;
			j ^= bit;
			if (i < j) {
				const tr = fftReal[i]; fftReal[i] = fftReal[j]; fftReal[j] = tr;
				const ti = fftImag[i]; fftImag[i] = fftImag[j]; fftImag[j] = ti;
			}
		}
		for (let len = 2; len <= n; len <<= 1) {
			const ang = (-2 * Math.PI) / len;
			const wr = Math.cos(ang), wi = Math.sin(ang);
			const half = len >> 1;
			for (let i = 0; i < n; i += len) {
				let cr = 1, ci = 0;
				for (let k = 0; k < half; k++) {
					const ur = fftReal[i + k], ui = fftImag[i + k];
					const vr = fftReal[i + k + half] * cr - fftImag[i + k + half] * ci;
					const vi = fftReal[i + k + half] * ci + fftImag[i + k + half] * cr;
					fftReal[i + k] = ur + vr; fftImag[i + k] = ui + vi;
					fftReal[i + k + half] = ur - vr; fftImag[i + k + half] = ui - vi;
					const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
				}
			}
		}
		for (let i = 0; i < n / 2; i++) {
			const m = Math.sqrt(fftReal[i] * fftReal[i] + fftImag[i] * fftImag[i]) / (n / 4);
			fftOut[i] = Math.min(255, m * 255);
		}
		// 频段能量（bin 宽 ≈46.9Hz @48kHz）：20-150/150-400/400-1200/1000-3500/3500-12000 Hz
		const bandAvg = (loHz, hiHz) => {
			const lo = Math.max(0, Math.floor(loHz / 46.9));
			const hi = Math.min(FFT_SIZE / 2 - 1, Math.ceil(hiHz / 46.9));
			let sum = 0;
			for (let i = lo; i <= hi; i++) sum += fftOut[i];
			return Math.min(1, Math.pow(sum / (hi - lo + 1) / 255, 0.8));
		};
		audio.bands.bass = bandAvg(20, 150);
		audio.bands.lowMid = bandAvg(150, 400);
		audio.bands.mid = bandAvg(400, 1200);
		audio.bands.vocal = bandAvg(1000, 3500);
		audio.bands.treble = bandAvg(3500, 12000);
		let total = 0;
		for (let i = 0; i < FFT_SIZE / 2; i++) total += fftOut[i];
		audio.power = Math.min(255, (total / (FFT_SIZE / 2)) * 3);
		audio.live = true;
	}

	// ---------------- 事件总线 ----------------
	const listeners = new Map();
	function emit(name, payload) {
		const set = listeners.get(name);
		if (!set) return;
		set.forEach((cb) => {
			try { cb(payload); } catch (e) { warn("listener error", name, e); }
		});
	}
	function subscribe(name, cb) {
		if (!listeners.has(name)) listeners.set(name, new Set());
		listeners.get(name).add(cb);
		return () => listeners.get(name) && listeners.get(name).delete(cb);
	}

	// ---------------- pump（渲染 bundle 的唯一数据入口） ----------------
	const pump = {
		version: 1,
		meta: null,
		lyrics: null,
		mode: "classic",
		on: subscribe,
		getClock: () => ({ base: clock.base, at: clock.at, playing: clock.playing, duration: clock.duration }),
		getAudio: () => audio,
		setMode(m) { pump.mode = String(m || "classic"); render(); },
		cycleMode() {
			const order = ["classic", "cadenza", "partita", "tilt", "still"];
			const idx = order.indexOf(pump.mode);
			pump.mode = order[(idx + 1) % order.length];
			emit("mode", pump.mode);
			render();
			return pump.mode;
		},
		seek(sec) {
			try {
				const adapter = typeof legacyNativeCmder !== "undefined" &&
					legacyNativeCmder && legacyNativeCmder._envAdapter && legacyNativeCmder._envAdapter.callAdapter;
				if (!adapter || !lastAudioId) { warn("seek 不可用（无 audioId）"); S.hudmsg = "✗ seek 不可用（无 audioId，切一次歌即可恢复）"; render(); return; }
				const target = Math.max(0, sec);
				const cmd = lastAudioId + "|seek|" + Math.random().toString(36).slice(2, 8);
				legacyNativeCmder._envAdapter.callAdapter("audioplayer.seek", () => {}, [lastAudioId, cmd, target]);
				clock.base = target;
				clock.at = Date.now();
				lastProgress = target;
			} catch (e) { warn("seek", e); }
		},
		togglePlayPause() {
			const b = document.querySelector("#btn_pc_minibar_play");
			if (b) b.click();
			else warn("播放按钮不存在");
		},
		prevNext(dir) {
			try {
				// AMLL v3 在 3.x 上验证过的底部控制条选择器，.btnc-* 为 2.x 兜底
				const sels = dir < 0
					? ["footer > * > * > .middle > *:nth-child(1) > button:nth-child(2)", ".btnc-prv"]
					: ["footer > * > * > .middle > *:nth-child(1) > button:nth-child(4)", ".btnc-nxt"];
				for (const s of sels) {
					const b = document.querySelector(s);
					if (b) { b.click(); return; }
				}
				warn(dir < 0 ? "上一首按钮未找到" : "下一首按钮未找到");
			} catch (e) { warn("prevNext", e); }
		},
		show() { pump.setVisible(true); },
		hide() { pump.setVisible(false); },
		toggleVisible() { pump.setVisible(!S.visible); },
		isVisible: () => S.visible,
		setVisible(v) {
			if (S.visible === v) return;
			S.visible = v;
			// 界面打开时自动接通频谱通道，收起时释放（省 CPU）
			if (v) enableFFT(); else disableFFT();
			emit("visible", v);
		},
	};
	window.__foliaPump = pump;

	// ---------------- HUD（可拖拽 / 可最小化 / 幽灵淡出 / 可弹出独立窗口） ----------------
	const BTN =
		"background:#233043;color:#cfe3ff;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;font:12px Consolas,monospace";
	let bodyEl = null;
	let hudEl = null;
	let poppedWin = null;
	let ghostTimer = 0;
	let ghosted = false;

	const loadPos = () => {
		try { return JSON.parse(localStorage.getItem("folia_hud_pos") || "null"); } catch (e) { return null; }
	};
	const savePos = (p) => { try { localStorage.setItem("folia_hud_pos", JSON.stringify(p)); } catch (e) { /* noop */ } };

	function applyHudPosition() {
		if (!hudEl) return;
		const saved = loadPos();
		const w = hudEl.offsetWidth || 560;
		if (saved && isFinite(saved.left) && isFinite(saved.top)) {
			hudEl.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, saved.left)) + "px";
			hudEl.style.top = Math.max(4, Math.min(window.innerHeight - 40, saved.top)) + "px";
		} else {
			// 默认右下角：离网易云左侧栏和顶部搜索都远
			hudEl.style.left = Math.max(4, window.innerWidth - w - 14) + "px";
			hudEl.style.top = Math.max(4, window.innerHeight - 250) + "px";
		}
		hudEl.style.right = "auto";
	}

	let drawerOn = false;
	let snapRight = true;

	function setMinimized(min) {
		try { localStorage.setItem("folia_hud_min", min ? "1" : "0"); } catch (e) { /* noop */ }
		if (!hudEl) return;
		const body = hudEl.querySelector("#folia-ncm-hud-body");
		const row = hudEl.querySelector("#folia-ncm-hud-actions");
		if (body) body.style.display = min ? "none" : "";
		if (row) row.style.display = min ? "none" : "";
		const minBtn = hudEl.querySelector('[data-act="min"]');
		if (minBtn) minBtn.textContent = min ? "展开" : "缩小";
		hudEl.style.transition = "transform 240ms ease, opacity 240ms ease";
		if (min) {
			// 贴边抽屉：缩向最近的屏幕边，只留把手；悬停滑出，几乎不挡 UI
			drawerOn = true;
			const r = hudEl.getBoundingClientRect();
			snapRight = (r.left + r.width / 2) >= window.innerWidth / 2;
			applyDrawer();
		} else {
			drawerOn = false;
			hudEl.style.transform = "";
			hudEl.style.opacity = "1";
		}
	}
	function applyDrawer() {
		if (!drawerOn || !hudEl) return;
		hudEl.style.transform = snapRight ? "translateX(calc(100% - 70px))" : "translateX(calc(-100% + 70px))";
		hudEl.style.opacity = "0.55";
	}
	function drawerOpen() {
		if (drawerOn && hudEl) { hudEl.style.transform = "translateX(0)"; hudEl.style.opacity = "1"; }
	}

	function setGhost(on) {
		ghosted = on;
		if (!hudEl) return;
		hudEl.style.opacity = on ? "0.14" : "1";
		hudEl.style.pointerEvents = on ? "none" : "auto";
	}
	function wakeHud() {
		if (ghosted) setGhost(false);
		clearTimeout(ghostTimer);
		// 弹出成独立窗口或已收成抽屉时不淡出（都不构成遮挡）
		if (!poppedWin && !drawerOn) {
			ghostTimer = setTimeout(() => setGhost(true), 6000);
		}
	}

	function popOut() {
		try {
			const w = window.open("about:blank", "folia-hud", "popup=1,width=620,height=380");
			if (!w) { S.hudmsg = "✗ 弹窗被网易云拦截，用「缩小」或拖到角落代替"; render(); return; }
			popWin = w;
			const doc = w.document;
			doc.title = "Folia HUD";
			doc.body.style.cssText = "margin:0;padding:10px;background:#0a0c10;";
			const hudNode = hudEl;
			hudNode.style.position = "static";
			hudNode.style.left = "auto";
			hudNode.style.top = "auto";
			hudNode.style.width = "100%";
			hudNode.style.maxWidth = "none";
			doc.body.appendChild(hudNode);
			setGhost(false);
			S.hudmsg = "✓ 已弹出独立窗口；关闭该窗口会自动停靠回页面";
			render();
			w.addEventListener("beforeunload", () => {
				// 弹窗销毁会连带销毁搬过去的 DOM——在宿主里重建一份
				popWin = null;
				hudEl = null; bodyEl = null;
				buildHud();
				S.hudmsg = "✓ 已停靠回页面";
				render();
			});
		} catch (e) {
			S.hudmsg = "✗ 弹出失败 " + (e && e.message);
			render();
			try { hudEl && document.body.appendChild(hudEl); } catch (_) { /* noop */ }
		}
	}

	function buildHud() {
		const hud = document.createElement("div");
		hud.id = "folia-ncm-hud";
		hud.style.cssText =
			"position:fixed;z-index:2147483001;background:rgba(10,12,16,.85);color:#cfe3ff;font:12px/1.6 Consolas,Menlo,monospace;padding:10px 12px;border-radius:10px;max-width:560px;pointer-events:auto;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.4)";
		hud.innerHTML =
			'<div data-drag="1" title="双击切换诊断行" style="font-weight:bold;color:#8fd3ff;margin-bottom:4px;cursor:move;display:flex;justify-content:space-between;gap:8px">' +
			'<span>Folia NCPlayer · 数据泵</span>' +
			'<span style="display:flex;gap:6px">' +
			'<button data-act="pop" style="' + BTN + '">弹出窗口</button>' +
			'<button data-act="min" style="' + BTN + '">缩小</button>' +
			"</span></div>" +
			'<div id="folia-ncm-hud-body" style="user-select:text">初始化…</div>' +
			'<div id="folia-ncm-hud-actions" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
			'<button data-act="open" style="' + BTN + '">打开Folia界面</button>' +
			'<button data-act="mode" style="' + BTN + '">切换模式</button>' +
			'<button data-act="seek30" style="' + BTN + '">跳到30s</button>' +
			'<button data-act="browser" style="' + BTN + '">浏览器窗口</button>' +
			'<button data-act="bg" style="' + BTN + '">省电背景</button>' +
			'<button data-act="fft" style="' + BTN + '">开频谱</button>' +
			'<button data-act="close" style="' + BTN + '">关闭HUD</button>' +
			"</div>";
		document.body.appendChild(hud);
		hudEl = hud;
		bodyEl = hud.querySelector("#folia-ncm-hud-body");
		applyHudPosition();
		try { if (localStorage.getItem("folia_hud_min") === "1") setMinimized(true); } catch (e) { /* noop */ }
		wakeHud();

		// 拖拽（按住标题栏）
		hud.querySelector("[data-drag]").addEventListener("mousedown", (e) => {
			if (e.target.closest("[data-act]")) return;
			const rect = hud.getBoundingClientRect();
			const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
			const move = (ev) => {
				hud.style.left = Math.max(4, Math.min(window.innerWidth - 80, ev.clientX - offX)) + "px";
				hud.style.top = Math.max(4, Math.min(window.innerHeight - 30, ev.clientY - offY)) + "px";
				hud.style.right = "auto";
			};
			const up = () => {
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", up);
				savePos({ left: parseInt(hud.style.left, 10), top: parseInt(hud.style.top, 10) });
			};
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", up);
			e.preventDefault();
		});

		// 幽灵模式唤醒：鼠标靠近或任意按键
		document.addEventListener("mousemove", (e) => {
			if (!ghosted || !hudEl || poppedWin) return;
			const r = hudEl.getBoundingClientRect();
			if (e.clientX >= r.left - 30 && e.clientX <= r.right + 30 && e.clientY >= r.top - 30 && e.clientY <= r.bottom + 30) {
				wakeHud();
			}
		});
		document.addEventListener("keydown", () => wakeHud());
		// 抽屉悬停滑出
		hud.addEventListener("mouseenter", () => drawerOn && drawerOpen());
		hud.addEventListener("mouseleave", () => drawerOn && applyDrawer());
		// 双击标题：按需开关诊断行（measure 深遍历有开销，默认关）
		hud.querySelector("[data-drag]").addEventListener("dblclick", () => {
			S.measureOn = !S.measureOn;
			render();
		});

		hud.addEventListener("click", (e) => {
			const btn = e.target.closest("[data-act]");
			if (!btn) return;
			const act = btn.dataset.act;
			if (act === "open") pump.toggleVisible();
			else if (act === "mode") pump.cycleMode();
			else if (act === "seek30") pump.seek(30);
			else if (act === "browser") openBrowserHud();
			else if (act === "bg") {
				try {
					const next = localStorage.getItem("folia_bg") === "none" ? "latent" : "none";
					localStorage.setItem("folia_bg", next);
					S.hudmsg = "背景已切换为 " + (next === "none" ? "省电(纯色)" : "shader渐变") + "，刷新页面生效";
					render();
					setTimeout(() => location.reload(), 900);
				} catch (e) { warn("bg", e); }
			}
			else if (act === "fft") enableFFT();
			else if (act === "pop") popOut();
			else if (act === "min") setMinimized(hud.querySelector("#folia-ncm-hud-body").style.display !== "none");
			else if (act === "close") { hud.remove(); hudEl = null; bodyEl = null; }
		});
	}

	const fmt = (s) => {
		if (!isFinite(s) || s < 0) return "--:--";
		const m = Math.floor(s / 60), sec = Math.floor(s % 60);
		return m + ":" + String(sec).padStart(2, "0");
	};
	function esc(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
	}
	function measure() {
		try {
			const h = document.getElementById("folia-ncm-root");
			if (!h || !h.shadowRoot) return "";
			const hr = h.getBoundingClientRect();
			let line = "host " + Math.round(hr.width) + "x" + Math.round(hr.height);
			// 深挖：querySelectorAll 穿不透嵌套 shadow root，递归下钻找 canvas
			const found = [];
			let count = 0;
			const walk = (root, depth) => {
				if (depth > 6) return;
				for (const el of root.querySelectorAll("*")) {
					count++;
					if (el.tagName === "CANVAS" && found.length < 3) found.push(el);
					if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
				}
			};
			walk(h.shadowRoot, 0);
			line += " · 元素" + count + "个";
			const rects = found.map((el) => {
				const r = el.getBoundingClientRect();
				return "cv " + Math.round(r.width) + "x" + Math.round(r.height) + "@" + Math.round(r.top) + " px" + el.width + "x" + el.height;
			});
			line += " · canvas:" + (rects.length ? rects.join(" | ") : "0个(未挂载)");
			return line.slice(0, 700);
		} catch (e) { return "measure err " + (e && e.message); }
	}

	function render() {
		if (!bodyEl) return;
		const ok = (b) => (b ? "✓" : "✗");
		bodyEl.innerHTML =
			"BetterNCM " + S.bncm + " · NCM " + S.ncm + "<br>" +
			"歌曲: " + esc(S.song) + " - " + esc(S.artists) + " (id=" + esc(S.songId) + ") 封面 " + ok(!!S.coverUrl) + "<br>" +
			"时长 " + fmt(S.duration) + " · 进度 " + fmt(clock.base) + " · " + S.playState +
			" · 进度回调 " + S.progressHz + "Hz<br>" +
			"yrc: " + esc(S.yrc) + " · AudioData 包: " + S.audioData + (audio.live ? " · 频谱✓ p" + Math.round(audio.power) : "") + "<br>" +
			"UI: " + esc(S.ui) + " · 界面: " + (S.visible ? "打开" : "收起") + " · 模式: " + esc(pump.mode) + " (M键切换)<br>" +
			(S.hudmsg ? '<span style="color:#9fe3b8">' + esc(S.hudmsg) + "</span><br>" : "") +
			(S.visible && S.measureOn ? "<br>" + esc(measure()) : "");
	}

	function enableFFT() {
		try {
			if (typeof channel !== "undefined" && channel && channel.call) {
				channel.call("audioplayer.enableAudioData", () => {}, [1]);
				log("enableAudioData 已发送");
			} else warn("channel.call 不可用");
		} catch (e) { warn("fft", e); }
	}

	function disableFFT() {
		try {
			if (typeof channel !== "undefined" && channel && channel.call) {
				channel.call("audioplayer.enableAudioData", () => {}, [0]);
				audio.live = false;
			}
		} catch (e) { warn("fft off", e); }
	}

	// ---------------- 通道注册（3.x channel.registerCall，2.x legacyNativeCmder 兜底） ----------------
	function reg(name, cb) {
		try {
			if (typeof channel !== "undefined" && channel && channel.registerCall) {
				channel.registerCall("audioplayer.on" + name, (...args) => {
					try { cb(...args); } catch (e) { warn(name, e); }
				});
				return "channel";
			}
			if (typeof legacyNativeCmder !== "undefined" && legacyNativeCmder && legacyNativeCmder.appendRegisterCall) {
				legacyNativeCmder.appendRegisterCall(name, "audioplayer", (...args) => {
					try { cb(...args); } catch (e) { warn(name, e); }
				});
				return "legacy";
			}
		} catch (e) { warn("reg", name, e); }
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
					emit("state", { paused: !clock.playing, duration: clock.duration });
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
					pump.meta = {
						id: id || S.songId || "ncm-unknown",
						name: S.song,
						artists: p.resourceArtists ? p.resourceArtists.map((a) => a.name) : [],
						coverUrl: cover,
					};
					emit("song", pump.meta);
					pushToBridge("Track", {
						author: pump.meta.artists.join(", "),
						title: pump.meta.name,
						album: "",
						cover: cover || "",
						duration: S.duration,
						id: pump.meta.id,
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

	async function fetchLyrics(id) {
		S.yrc = "拉取中…";
		render();
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
					render();
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
			pump.lyrics = { yrc, tlyric, romalrc };
			emit("lyrics", pump.lyrics);
			// Folia 互通：歌词推给桥（source=netease → Folia 按 yrc 逐字管线解析）
			pushToBridge("Lyric", {
				source: "netease",
				title: S.song,
				author: S.artists,
				duration: S.duration,
				hasLyric: !!yrc,
				hasTranslatedLyric: !!tlyric,
				hasKaraokeLyric: !!yrc,
				lrc: tlyric || "",
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
			indexLyricTracks(yrc, tlyric);
		} catch (e) {
			S.yrc = "✗ 拉取失败 " + e.message;
		}
		render();
	}

	// ---------------- 独立浏览器 HUD（state.js 数据泵 → 本地服务挂载 → 系统浏览器） ----------------
	let lyricTrackIndex = []; // {startMs, text, trans}
	function indexLyricTracks(yrc, tlyric) {
		lyricTrackIndex = [];
		if (!yrc) return;
		const strip = (s) => s.replace(/\(\d+,\d+,\d+\)/g, "").trim();
		const lrcToMs = (t) => {
			const m = t.match(/^\[(\d+):(\d+)(?:\.(\d+))?\]$/);
			if (!m) return -1;
			return (+m[1] * 60 + +m[2]) * 1000 + (m[3] ? +String("0." + m[3]) * 1000 : 0);
		};
		const transMap = new Map();
		if (tlyric) {
			for (const l of tlyric.split("\n")) {
				const m = l.match(/^\[(\d+:\d+(?:\.\d+)?)\](.*)$/);
				if (m) transMap.set(lrcToMs("[" + m[1] + "]"), m[2].trim());
			}
		}
		for (const l of yrc.split("\n")) {
			const m = l.match(/^\[(\d+),(\d+)\](.*)/);
			if (!m) continue;
			const startMs = +m[1];
			lyricTrackIndex.push({ startMs, text: strip(m[3]), trans: transMap.get(startMs) || "" });
		}
		lyricTrackIndex.sort((a, b) => a.startMs - b.startMs);
	}
	function currentLyricLine() {
		const t = clock.base * 1000;
		let cur = null;
		for (const item of lyricTrackIndex) {
			if (item.startMs <= t) cur = item;
			else break;
		}
		return cur;
	}

	// ---------------- 播放状态通道 ----------------
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
		emit("state", { paused: !clock.playing, duration: clock.duration });
		setTimeout(updateSongFromStore, 300);
		render();
	});
	reg("End", () => { S.playState = "unloaded"; clock.playing = false; emit("state", { paused: true, duration: clock.duration }); render(); });
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
		// 页面重载会错过 PlayState 事件：进度单调递增即为播放中（自动恢复状态）
		if (delta > 0.001 && !clock.playing) {
			clock.playing = true;
			S.playState = "▶";
			emit("state", { paused: false, duration: clock.duration });
		}
		// Folia 互通：精确进度 250ms 节流推送
		if (Date.now() - lastBridgeProgressPushAt > 250) {
			lastBridgeProgressPushAt = Date.now();
			pushToBridge("PlayerProgress", { progress: Math.round(progress * 1000) });
		}
		progressCount++;
	});
	reg("PlayState", (audioId, stateId) => {
		const st = String(stateId).split("|")[1];
		S.playState = st === "pause" ? "⏸" : st === "resume" ? "▶" : String(stateId);
		clock.playing = st === "resume";
		if (st === "pause") clock.base = S.progress, clock.at = Date.now();
		emit("state", { paused: !clock.playing, duration: clock.duration });
		pushToBridge("PlayerPauseState", {
			hasSong: true,
			isPaused: !clock.playing,
			seekbarCurrentPosition: Math.round(clock.base * 1000),
		});
		render();
	});
	reg("Volume", () => {});
	reg("AudioData", (d) => {
		S.audioData++;
		// 界面收起时不算 FFT（省 CPU；包计数保留供诊断）
		if (S.visible && d && d.data) {
			try { computeFFT(new Int16Array(d.data)); } catch (e) { warn("fft compute", e); }
		}
		if (S.audioData % 50 === 0) render();
	});

	// ---------------- ui.js 加载（postbuild 产物，eval 注入绕开 CSP 外链限制） ----------------
	async function loadUi() {
		try {
			const basePath = (typeof plugin !== "undefined" && plugin && plugin.pluginPath)
				? plugin.pluginPath
				: "plugins_dev/folia-ncm";
			const blob = await betterncm.fs.readFile(basePath + "/ui.js");
			const code = await blob.text();
			if (!code || code.length < 500) throw new Error("ui.js 缺失或过小（先跑 postbuild）");
			S.ui = "加载中…";
			render();
			await new AsyncFunction("plugin", code).call(null, plugin);
			S.ui = "✓ 已挂载";
		} catch (e) {
			S.ui = "✗ " + (e && e.message ? e.message.slice(0, 60) : "失败");
			warn("ui.js 加载失败", e);
		}
		render();
	}

	// ---------------- 入口触发：点播放页唱片打开全屏界面，ESC 退出 ----------------
	document.addEventListener("click", (e) => {
		try {
			const t = e.target && e.target.closest && e.target.closest(".miniVinylWrapper");
			if (t) pump.show();
		} catch (err) { /* noop */ }
	}, true);
	document.addEventListener("keydown", (e) => {
		if (e && e.key === "Escape" && S.visible) pump.hide();
	});

	// ---------------- Folia 互通桥：Widdit 协议 WS 服务端（9863）+ Node 桥进程 ----------------
	// Folia 原生支持被外部播放器驱动（设置→启用 Now Playing，固定连 ws://localhost:9863/api/ws/lyric）。
	// 网易云页面开不了监听端口，所以桥本体是独立 Node 进程（系统已装 Node 26）；本插件把桥源码写到
	// 磁盘并用 app.exec 拉起（端口占用即自退，幂等），再把播放状态 HTTP POST 给它广播。

	function __foliaBridgeSource() {
		const http = require('http');
		const crypto = require('crypto');
		const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
		const clients = new Set();
		function encodeFrame(buf) {
			const len = buf.length;
			if (len < 126) { const h = Buffer.alloc(2); h[0] = 0x81; h[1] = len; return Buffer.concat([h, buf]); }
			if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); return Buffer.concat([h, buf]); }
			const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return Buffer.concat([h, buf]);
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
			socket.on('close', () => clients.delete(socket));
			socket.on('error', () => clients.delete(socket));
			socket.on('data', () => {});
		});
		server.on('error', (e) => { if (e && e.code === 'EADDRINUSE') process.exit(0); });
		server.listen(9863, '127.0.0.1');
	}

	const BRIDGE_PUSH_URL = "http://127.0.0.1:9863/push";
	let lastBridgeProgressPushAt = 0;
	async function pushToBridge(event, data) {
		try {
			await fetch(BRIDGE_PUSH_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event, data }),
			});
		} catch (e) { /* 桥未启动时静默 */ }
	}

	async function ensureBridge() {
		try {
			await betterncm.fs.mkdir("folia-bridge").catch(() => {});
			await betterncm.fs.writeFile("folia-bridge/bridge.js", __foliaBridgeSource.toString() + "\n__foliaBridgeSource();\n");
			const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
			betterncm.app.exec('"' + nodeExe + '" "C:\\betterncm\\folia-bridge\\bridge.js"');
			log("folia-bridge 已拉起");
		} catch (e) { warn("bridge 启动", e); }
	}

	// ---------------- 独立浏览器 HUD：state.js 挂载到 BetterNCM 本地服务 → 系统浏览器查看 ----------------
	let browserHudReady = false;
	let viewerUrl = "";

	function buildViewerHtml(stateUrl) {
		return '<!doctype html><html><head><meta charset="utf-8"><title>Folia HUD</title><style>' +
			"body{margin:0;background:#0a0c10;color:#cfe3ff;font:14px/1.7 Consolas,Menlo,monospace;padding:28px;min-height:100vh}" +
			".song{font-size:26px;font-weight:bold;color:#fff}.artist{color:#8fa3c8;margin:2px 0 18px}" +
			".clock{font-size:18px;margin-bottom:6px}.bar{height:5px;background:#1d2735;border-radius:3px;margin:10px 0 20px}" +
			".fill{height:5px;background:#8fd3ff;border-radius:3px}.line{font-size:20px;color:#fff;margin-top:26px;min-height:30px}" +
			".trans{font-size:15px;color:#9fb4d8;min-height:22px}.meta{font-size:12px;color:#5b6b85;margin-top:26px}" +
			".pill{display:inline-block;background:#16202e;border-radius:6px;padding:2px 10px;margin-right:8px}" +
			"</style></head><body>" +
			'<div class="song" id="song">—</div><div class="artist" id="artist"></div>' +
			'<div class="clock" id="clock">--:-- / --:--</div><div class="bar"><div class="fill" id="fill" style="width:0%"></div></div>' +
			'<div><span class="pill" id="state">—</span><span class="pill" id="mode">—</span><span class="pill" id="hz"></span></div>' +
			'<div class="line" id="line"></div><div class="trans" id="trans"></div>' +
			'<div class="meta">Folia NCPlayer 独立窗口 · 关闭此页面不影响网易云 · 数据每 500ms 刷新</div>' +
			"<script>" +
			"var BASE=" + JSON.stringify(stateUrl) + ";" +
			"function fmt(s){if(!isFinite(s)||s<0)return'--:--';var m=Math.floor(s/60),x=Math.floor(s%60);return m+':'+String(x).padStart(2,'0')}" +
			"function refresh(){var sc=document.createElement('script');sc.src=BASE+'?t='+Date.now();" +
			"sc.onload=function(){var st=window.__foliaState||{};" +
			"document.getElementById('song').textContent=st.song||'—';" +
			"document.getElementById('artist').textContent=st.artists||'';" +
			"document.getElementById('clock').textContent=fmt(st.progress)+' / '+fmt(st.duration);" +
			"document.getElementById('fill').style.width=(st.duration>0?Math.min(100,st.progress/st.duration*100):0)+'%';" +
			"document.getElementById('state').textContent=(st.paused?'⏸ 暂停':'▶ 播放中');" +
			"document.getElementById('mode').textContent='样式: '+(st.mode||'');' ';" +
			"document.getElementById('hz').textContent='yrc '+(st.yrcStatus||'');' ';" +
			"document.getElementById('line').textContent=st.line||'';" +
			"document.getElementById('trans').textContent=st.trans||''};" +
			"document.head.appendChild(sc);setTimeout(function(){sc.remove()},4000)}" +
			"refresh();setInterval(refresh,600);" +
			"<\/script></body></html>";
	}

	async function setupBrowserHud() {
		try {
			await betterncm.fs.mkdir("folia-hud").catch(() => {});
			const stateUrl = await betterncm.fs.mountFile("folia-hud/state.js");
			await betterncm.fs.writeFile("folia-hud/viewer.html", buildViewerHtml(stateUrl));
			const viewerMounted = await betterncm.fs.mountFile("folia-hud/viewer.html");
			browserHudReady = true;
			viewerUrl = viewerMounted || stateUrl.replace("state.js", "viewer.html");
			await betterncm.fs.writeFile("folia-hud/urls.txt", "state=" + stateUrl + "\nviewer=" + viewerUrl + "\ntime=" + new Date().toISOString() + "\n");
			log("浏览器HUD挂载:", viewerUrl);
			S.browser = viewerUrl;
			setInterval(writeBrowserState, 1000);
			writeBrowserState();
		} catch (e) { warn("browser hud setup", e); }
	}

	async function writeBrowserState() {
		if (!browserHudReady) return;
		try {
			const line = currentLyricLine();
			const payload = {
				t: Date.now(),
				song: S.song, artists: S.artists,
				progress: Math.round(clock.base * 10) / 10,
				duration: Math.round(clock.duration),
				paused: !clock.playing,
				mode: pump.mode,
				line: line ? line.text : "",
				trans: line ? (line.trans || "") : "",
				yrcStatus: S.yrc,
			};
			await betterncm.fs.writeFile("folia-hud/state.js", "window.__foliaState=" + JSON.stringify(payload) + ";");
		} catch (e) { /* 静默：500ms 高频任务不打扰 */ }
	}

	function openBrowserHud() {
		try {
			if (!viewerUrl) { S.hudmsg = "✗ 浏览器 HUD 未就绪"; render(); return; }
			if (typeof betterncm.ncm === "object" && betterncm.ncm && betterncm.ncm.openUrl) {
				betterncm.ncm.openUrl(viewerUrl);
			} else if (typeof betterncm.app === "object" && betterncm.app && betterncm.app.exec) {
				betterncm.app.exec('cmd /c start "" "' + viewerUrl + '"');
			} else {
				S.hudmsg = "✗ 没有可用的打开方式，手动访问 folia-hud/urls.txt 里的地址"; render(); return;
			}
			S.hudmsg = "✓ 已在系统浏览器打开独立窗口";
			render();
		} catch (e) { S.hudmsg = "✗ " + (e && e.message); render(); }
	}

	// ---------------- 主流程 ----------------
	log("启动，注入成功");
	buildHud();
	render();

	try { S.bncm = await betterncm.app.getBetterNCMVersion(); } catch (e) { warn("bncm ver", e); }

	storeRef = await findStore();
	if (storeRef) {
		S.store = true;
		try { storeRef.subscribe(() => updateSongFromStore()); } catch (e) { warn("subscribe", e); }
		updateSongFromStore();
	}

	setInterval(() => {
		S.progressHz = progressCount;
		progressCount = 0;
		render();
	}, 1000);

	setupBrowserHud();
	ensureBridge();
	await loadUi();
})();

// bump10 1794045637

// bump11 1794045744
