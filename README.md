# folia-bridge

> **网易云 ⇄ Folia 互通桥** — 网易云音乐播歌（计入账号听歌时长），Folia 全屏渲染逐字歌词与全部视觉效果。
>
> 本仓库主插件为**纯桥接版**（零 UI 接管，与 RefinedNowPlayingNext 等播放器美化插件完全共存）；
> 含全屏 UI 的初代版本归档在 `archive/`。

```
网易云音乐（音频 + 听歌时长 + 你的全部插件）
    │  folia-bridge 插件（纯数据泵，零 UI）
    │    ├─ 播放状态：track 元素直读 + store（playingState/歌词行号）
    │    ├─ 曲目元数据：redux store（歌名/歌手/封面/时长）
    │    ├─ 逐字歌词：NetEase yrc → AMLLDB 兜底（含翻译/罗马音三轨）
    │    └─ 四事件推送：Track / Lyric / PlayerProgress(1s) / PlayerPauseState
    ▼
Node 桥（bridge.js，端口 9863）
    └─ 原生 RFC6455 WebSocket 服务端（Widdit now-playing 协议）
       ws://127.0.0.1:9863/api/ws/lyric · /push · /health
    ▼
Folia（设置 → 启用 Now Playing → 首页舞台入口）
    └─ 舞台全屏渲染：逐字点亮 + 翻译字幕 + 全部 Folia 原生视觉模式
```

## 安装

1. **网易云侧**：把 `plugin/folia-bridge/` 放入 `C:\betterncm\plugins_dev\`（需 BetterNCM v2 + 网易云 3.1.x），重启网易云
   - 桥进程自动拉起（需系统 Node.js；`folia-bridge/bridge.js` 写入 `C:\betterncm\folia-bridge\`）
2. **Folia 侧**：设置 → 「启用 Now Playing」→ 首页出现舞台入口
3. 网易云播歌 → 进 Folia 舞台 → 逐字歌词自动渲染（含翻译字幕）

## 特性

- **纯桥接**：不接管网易云任何 UI，与所有播放器美化插件共存
- **进度真源**：网易云窗口被遮挡/最小化时进度回调会骤降，本插件用外推时钟每秒主动推送 + 10s 全量快照重置，Folia 任何状态都能回归正确显示
- **歌词三轨**：yrc 逐字（NetEase）→ AMLLDB 兜底（含 x-roman 罗马音 / x-translation 翻译提取）
- **幂等自启**：桥进程端口占用自动退出；换桥代码自动重启（pid 文件机制）
- **省电**：无 shader、无 canvas、无常驻动画——桥接本身几乎零开销

## 目录

- `plugin/folia-bridge/` — 精简桥接插件（日常使用这个）
- `archive/folia-ncm/` — 初代全屏 UI 版（含 5 个歌词模式渲染 bundle）：在网易云内嵌整套 Folia 渲染器。**与 RefinedNowPlayingNext 等界面插件冲突**，且 Chromium 91 兼容层较重，故归档
- fume（浮名）模式在 Chromium 91 上坐标错位，已移除（详见 git 历史）

## 协议

本桥实现 **Widdit now-playing 协议**（Folia 原生支持的歌词显示 WS 协议，事件定义见 Folia 源码 `src/services/nowPlayingProvider.ts`）：

| 事件 | data |
|---|---|
| `Track` | `{ author, title, album, cover, duration(秒), id }` |
| `Lyric` | `{ source:'netease', title, author, duration, hasLyric, hasKaraokeLyric, karaokeLyric(=yrc原文), lrc, translatedLyric, hasTranslatedLyric }` |
| `PlayerProgress` | `{ progress(毫秒) }` |
| `PlayerPauseState` | `{ hasSong, isPaused, seekbarCurrentPosition(毫秒) }` |

新客户端连入时自动重放当前快照（Track → Lyric → 进度 → 播放态）。

## 许可

**AGPL-3.0**（见 `LICENSE`）——本项目的歌词渲染引擎与解析管线衍生自
[Folia](https://github.com/chthollyphile/folia-major)（chthollyphile，AGPL-3.0），
改造标记为 `BNCM PORT` 注释。第三方组件与歌词数据来源见 `CREDITS.md`。
