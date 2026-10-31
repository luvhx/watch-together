# 一起看 · Watch Together

[![CI](https://github.com/luvhx/watch-together/actions/workflows/ci.yml/badge.svg)](https://github.com/luvhx/watch-together/actions/workflows/ci.yml)
[![Build and publish image](https://github.com/luvhx/watch-together/actions/workflows/docker.yml/badge.svg)](https://github.com/luvhx/watch-together/actions/workflows/docker.yml)


房主粘贴一条视频直链并播放，朋友打开房间链接后从**同一个地址**加载片源，并实时跟随房主的播放、暂停、拖动与缓冲状态。

一个进程、一条 WebSocket、无数据库。适合部署在自己的 NAS、VPS 或 Docker 主机上。

---

## 功能

- **直链播放**：服务器只保存视频 URL 和时间轴，不转存、不转码、不代理流量。
- **实时同步**：房主的播放、暂停、拖动、倍速、缓冲都会广播给房间内所有人。
- **服务器时间轴**：以「锚点 + 服务器时间」推算进度，网络抖动造成的漂移会自动校正。
- **房主准入**：创建房间时生成一次性房主凭证，只有持有凭证的浏览器能控制播放。
- **刷新不散场**：房主刷新/短暂断线后，房间暂停在原进度，回来后可以继续。
- **MP4 / WebM / HLS**：HLS 按需加载内置的 hls.js，Safari 使用原生 HLS。
- **外挂字幕**：读取浏览器 / HLS 内嵌字幕轨道，也可通过 URL 添加 WebVTT、SRT、ASS / SSA；ASS 支持常用字体、颜色、描边、阴影、对齐和定位样式。
- **MKV 内封字幕**：服务端使用 FFprobe / FFmpeg 扫描影片内封文字字幕，按需提取为 ASS；PGS 等图形字幕不支持。
- **更易读的界面**：整体上调小字号，聊天、侧栏、字幕菜单和播放器控制更适合长时间观看。
- **房间聊天与弹幕**：房间内置实时聊天室，新消息可同时以弹幕从视频画面上飘过；支持一键开关弹幕，聊天记录仍保留。
- **开箱即用**：无需账号、数据库、Redis、`.env` 或构建步骤；简洁深色界面，桌面与移动端自适应。

## 工作方式

```text
房主浏览器 ── WebSocket(控制) ──┐
                                │
访客 A 浏览器 ── WebSocket(同步) ── 一起看 Node 服务
                                │   ├─ 房间与播放锚点（内存）
访客 B 浏览器 ── WebSocket(同步) ──┘   └─ 静态前端 + API
       │
       └──── 直接向视频源请求 MP4 / HLS 分片（不经过服务器）
```

服务端保存的时间轴形如：

```text
position_at(T) = anchor_position + (T - anchor_at) / 1000 * rate
```

暂停或缓冲时时间轴冻结，开始播放时重新取锚点。每个客户端用 ping/pong 估算时钟偏差，再与本地 `video.currentTime` 比较；超过阈值才 seek，避免频繁抖动。

## Docker Compose 部署

镜像已发布到 GHCR，支持 `linux/amd64` 与 `linux/arm64`，无需配置环境变量；镜像内置 FFmpeg，可直接读取 MKV 内封字幕。

```bash
docker compose pull
docker compose up -d
```

打开 `http://服务器地址:8364`。修改端口只需编辑 [compose.yaml](compose.yaml) 的 `8364:8364`。

从源码构建：

```bash
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

常用命令：

```bash
docker compose logs -f --tail=100
docker compose restart
docker compose down
docker compose pull && docker compose up -d
```

## 本地开发

要求 Node.js 20.19+（推荐 24）。读取 MKV 内封字幕还需要本机安装 `ffmpeg` / `ffprobe`；Docker 镜像已内置。

```bash
npm ci
npm run dev
# http://localhost:8364
```

```bash
npm test        # 单元 / HTTP / WebSocket / 字幕 / 聊天测试
npm run check   # 所有 JS 语法检查
```

## 使用说明

1. 在首页粘贴视频直链，填写房间名和昵称，点击「创建房间」。
2. 进入房间后点击播放。房主的浏览器负责控制，其他浏览器自动跟随。
3. 点击「复制邀请链接」，把 `http://你的域名/r/房间号` 发给朋友。
4. 朋友打开链接、输入昵称，点击「同步播放」即可加入。
5. 在房间侧栏聊天室发消息；右上角「弹幕」开关控制消息是否从画面上飘过。
6. 需要字幕时点击播放器右下角的 **CC**：选择视频 / HLS 自带轨道，或粘贴字幕文件 URL 添加。

> 房主凭证保存在创建者浏览器的 `localStorage`。清理站点数据会失去房主身份，只能以访客加入。

## 聊天与弹幕

- **实时聊天**：所有房间成员都可以在房间聊天室发送消息，服务端通过同一条 WebSocket 广播。
- **加入即可看到历史**：新成员会收到最近 50 条聊天记录；服务端内存中最多保留 100 条。
- **弹幕**：新消息会以漂浮弹幕的形式经过视频画面，按轨道自动避让；关闭弹幕后聊天室消息仍然保留。
- **弹幕开关**：聊天室右上角的「弹幕」按钮，选择会保存在当前浏览器。
- **实时而非时间轴**：聊天和弹幕按到达时间即时显示，不绑定视频时间轴；新加入者不会重放历史弹幕。
- **限制**：单条消息最多 200 字；约 650ms 一条、每 30 秒最多 20 条，超出会收到提示。
- **内存存储**：聊天记录随房间存在，容器重启后清空。


## 字幕

- **内嵌轨道**：打开 CC 菜单后，会列出浏览器从片源中识别到的字幕轨道；HLS 流里的 `#EXT-X-MEDIA:TYPE=SUBTITLES` 轨道也会出现在「流内字幕轨道」中。
- **URL 添加**：粘贴 `.vtt`、`.srt`、`.ass` / `.ssa` 地址即可加载，可添加多条并随时切换或移除。
- **ASS 样式**：使用自定义叠加层渲染，支持常用样式：
  - 字体、字号、粗体、斜体、下划线、删除线
  - ASS 主色 / 描边色 / 背景色与透明度
  - 描边宽度、阴影、字距、缩放、旋转
  - `\an` 九宫格对齐、`\pos` / `\move` 定位、边距、`\N` 换行
  - `\c`、`\3c`、`\alpha` 等常用行内标签
- **限制**：复杂的 `\t` 动画、卡拉 OK 逐字效果、矢量绘图（`\p`）等高级 ASS 特性会被降级处理；字幕动画不会同步。
- **仅自己可见**：字幕轨道与开关只在当前播放器内生效，不改变其他观众的字幕。
- **跨域**：浏览器需要直接 `fetch` 字幕文件，字幕服务器必须允许 CORS；
- **编码**：自动识别 UTF-8 / UTF-16 BOM，并回退尝试 GB18030 / Big5。
- **MKV 内封字幕**：浏览器原生 `<video>` 无法读取 MKV 容器里的字幕轨。打开 CC 菜单时，服务器会用 FFprobe 扫描内封字幕并用 FFmpeg 按需转成 ASS；首次提取可能需要几秒到数十秒，之后会缓存。
- **仅支持文字字幕**：ASS / SSA / SRT / WebVTT / mov_text 等可以转换；PGS、DVD 等图形字幕会标记为不支持。
- **视频解码仍取决于浏览器**：提取字幕不会改变视频编码兼容性；MKV / HEVC 是否能播放由浏览器决定。
- **服务器访问**：读取内封字幕时服务器需要能访问影片 URL。默认允许局域网 / Tailscale 地址；始终阻止回环、链路本地和云 metadata 地址，并限制提取频率。公网部署可设 `ALLOW_PRIVATE_MEDIA=0`。这会消耗服务器带宽。
- **内置示例**：在 CC 菜单粘贴 `/subtitles/demo.ass` 或 `/subtitles/demo.vtt`，可以直接预览字幕与 ASS 样式。

## 直链要求

- 必须是**浏览器可直接打开的媒体地址**，而不是视频网站页面：
  - ✅ `https://cdn.example.com/movie.mp4`
  - ✅ `https://cdn.example.com/live/index.m3u8`
  - ❌ `https://www.bilibili.com/video/BV...`
  - ❌ `https://www.youtube.com/watch?v=...`
- 支持 MP4（推荐 H.264 + AAC）、WebM、Ogg，以及 HLS（`.m3u8`）。
- **HLS 需要视频源允许 CORS**（`Access-Control-Allow-Origin`），因为 hls.js 使用 `fetch/XHR` 拉取清单和分片；普通 `<video>` 直链通常不需要 CORS。
- **外挂字幕需要 CORS**：字幕文件由浏览器 `fetch`，与视频本身是否允许跨域无关。
- 通过 HTTPS 访问本应用时，视频地址也必须是 HTTPS，否则浏览器会拦截混合内容。
- 签名直链过期后需要重新创建房间；本应用不会刷新第三方签名。
- 服务器不会替客户端下载片源，所以视频源的带宽由观看者各自承担。

## 配置

默认零配置：端口 `8364`、房间 12 小时过期、单房间 20 人。需要调整时，在 [compose.yaml](compose.yaml) 的 service 下添加对应环境变量（如 `ROOM_TTL_HOURS`）。

内封字幕默认允许访问局域网 / Tailscale 媒体地址，适合自托管片库。如果实例直接暴露在公网，建议设置 `ALLOW_PRIVATE_MEDIA=0`，只允许公网地址；回环、链路本地和云 metadata 地址始终会被拒绝。

## 反向代理

WebSocket 需要升级头。Caddy 会自动处理：

```caddyfile
watch.example.com {
    reverse_proxy 127.0.0.1:8364
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name watch.example.com;

    location / {
        proxy_pass http://127.0.0.1:8364;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

如果需要记录真实客户端 IP，可在 compose.yaml 的服务中添加环境变量 `TRUST_PROXY=1`。

## 数据与扩展性

- 房间、播放进度、在线成员**全部保存在进程内存中**。重启容器会清空所有房间与进度。
- 没有数据库，因此不能直接横向扩容多个副本；多副本之间不会共享房间。
- 如果需要多副本，需要把房间状态迁移到 Redis 等共享存储，并用粘性会话或 pub/sub 广播。
- 默认房间 12 小时后过期；最后一人离开 2 小时后回收。
- 定时器使用服务器时钟，房主电脑时间不准不会影响访客。

## 安全设计

- 房主凭证是 32 字节随机值，服务端只保存 SHA-256 哈希；凭证通过 WebSocket `hello` 消息传输，不放进 URL，避免代理访问日志泄露。
- 房间号使用 8 位、去除易混字符的字母数字，约 1.1 万亿种组合。
- 播放控制只接受房主角色的消息，访客伪造 `host-state` 只会收到 `HOST_ONLY`。
- 所有用户输入通过 `textContent` 渲染；视频 URL 只允许 HTTP(S)，并拒绝带用户名密码的地址。
- 同一来源限制房间创建、查询与 WebSocket 握手频率；单房间人数和房间总数均有上限。
- 响应包含 CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`。
- 生产环境请务必配置 HTTPS：房主凭证保存在浏览器本地，并通过 WebSocket 传输。
- 内封字幕读取会由服务器访问影片地址。默认允许内网 HTTP(S) 媒体，以适配局域网 / Tailscale 片库；始终阻止回环、链路本地和云 metadata 地址。公网部署建议设 `ALLOW_PRIVATE_MEDIA=0`。

## HTTP / WebSocket 协议

### HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/rooms` | 创建房间：`{videoUrl,title?,hostName?}`，返回 `roomId`、`hostKey` 与房间信息 |
| `GET` | `/api/rooms/:id` | 读取公开房间信息（不含房主凭证） |
| `DELETE` | `/api/rooms/:id` | 房主关闭房间，`Authorization: Bearer <hostKey>` |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/rooms/:id/embedded-subtitles` | 扫描房间影片的内封字幕轨 |
| `GET` | `/api/rooms/:id/embedded-subtitles/:track` | 提取指定内封字幕为 ASS |
| `GET` | `/r/:id` | 邀请链接，302 到首页房间视图 |

### WebSocket `/ws?room=<roomId>`

客户端连接后先发送：

```json
{ "type": "hello", "name": "小林", "hostKey": "可选，仅房主提供" }
```

之后：

| 方向 | 类型 | 说明 |
| --- | --- | --- |
| 客户端 → 服务端 | `host-state` | 房主上报 `{position,playing,buffering,rate,duration,reason}` |
| 客户端 → 服务端 | `chat` | 发送房间消息 `{text}` |
| 客户端 → 服务端 | `request-sync` | 主动请求当前同步状态 |
| 客户端 → 服务端 | `ping` | 时钟校准 |
| 服务端 → 客户端 | `welcome` | 加入成功、自己的身份、房间状态、成员与聊天历史 |
| 服务端 → 客户端 | `sync` | 播放锚点、服务器时间与房间状态 |
| 服务端 → 客户端 | `chat` | 广播聊天消息 `{id,userId,name,role,text,at}` |
| 服务端 → 客户端 | `presence` | 成员变化 |
| 服务端 → 客户端 | `pong` | 返回 `t` 与 `serverTime` |
| 服务端 → 客户端 | `room-closed` | 房间关闭/过期 |

## 项目结构

```text
.
├── server/
│   ├── app.js          # 应用装配与优雅关闭
│   ├── config.js       # 环境变量
│   ├── embedded-subtitles.js # FFmpeg 内封字幕探测与提取
│   ├── http.js         # 静态资源、API、安全响应头
│   ├── realtime.js     # WebSocket 房间中枢
│   ├── rooms.js        # 房间与播放时间轴
│   ├── rate-limit.js   # 固定窗口限流
│   └── index.js        # 进程入口
├── public/             # 无构建步骤的前端
│   └── subtitles.js    # VTT / SRT / ASS 解析与样式提取
├── test/               # node:test 测试
├── .github/workflows/  # CI 与 GHCR 多架构镜像
├── Dockerfile
├── compose.yaml
└── compose.local.yaml
```

## 镜像发布 / Fork 后自行构建

本仓库已发布在 <https://github.com/luvhx/watch-together>，默认分支为 `main`。每次推送 `main` 都会触发 **Build and publish image**：

1. 工作流会自动构建 `linux/amd64` 与 `linux/arm64`。
2. 镜像推送到 `ghcr.io/luvhx/watch-together:latest`，同时生成 `sha-*` 标签。
3. 打版本标签会额外生成对应的语义化版本标签。
4. 本仓库的 Packages 已设为公开；如果你 fork 或改名，需要在 Packages 页面将新镜像设为 `Public`。

## 常见问题

**访客没有声音？**  
浏览器禁止带声音自动播放。加入时点击「同步播放」，这是一次用户手势，之后即可正常跟随。静音状态与音量是每个访客自己的设置。

**房主刷新后房间还在吗？**  
在，房间保留、进度暂停。房主重新打开同一链接会自动以房主身份进入。清理浏览器站点数据会丢失房主凭证。

**卡顿或进度偶尔跳一下？**  
同步以房主为基准，网络抖动时客户端会自动 seek 校正。HLS 首次加载较慢时可等待几秒，或换用 MP4。

**HLS 黑屏？**  
优先检查视频源的 CORS 响应头。hls.js 需要读取 `.m3u8` 与分片；普通 MP4 直链不走 CORS 请求。

**聊天室消息会同步到其他人的播放进度吗？**

不会。聊天与弹幕按到达时间实时显示；播放进度同步和聊天是两条独立通道。

**字幕菜单里没有轨道？**

普通 MP4 直链通常不携带可读取的内嵌字幕；请点击 CC 菜单，在「添加字幕文件 URL」中粘贴 VTT / SRT / ASS 地址。

**添加字幕提示跨域失败？**

字幕文件必须允许 CORS。也可以把字幕放到与本应用同域的静态目录（例如通过反向代理提供），再使用同域 URL。

**容器健康但页面打不开？**  
确认端口映射、云厂商安全组/防火墙，以及反向代理是否传递了 WebSocket `Upgrade` 头。

## License

MIT
