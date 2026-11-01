# 一起看 · Watch Together

一个自托管的同步放映厅。房主粘贴视频直链，朋友打开房间链接即可从同一片源开始，并实时跟随播放、暂停、拖动和倍速。

无需账号、数据库或 `.env`。

## 功能

- **实时同步**：播放、暂停、拖动、倍速和缓冲状态自动对齐。
- **直链播放**：支持 MP4、WebM、HLS；服务器只保存地址和时间轴。
- **字幕**：支持外挂 WebVTT / SRT / ASS / SSA，保留常用 ASS 样式。
- **MKV 内封字幕**：自动扫描内封文字字幕并按需提取；PGS 等图形字幕不支持。
- **iPad 兼容播放**：Safari 无法播放 MKV 时，可由服务器按需转封装为 HLS。
- **聊天与弹幕**：房间内置实时聊天室，新消息可作为弹幕飘过画面。
- **房主控制**：只有持有房主凭证的浏览器能控制播放；刷新或短暂断线后可继续。

## Docker Compose 部署

镜像：`ghcr.io/luvhx/watch-together:latest`，支持 `linux/amd64` / `linux/arm64`，已内置 FFmpeg。

```bash
docker compose pull
docker compose up -d
```

打开 `http://服务器地址:8364`。

修改端口请编辑 [compose.yaml](compose.yaml) 中的端口映射：

```yaml
ports:
  - "8364:8364"
```

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

## 本地运行

要求 Node.js 20.19+，以及 `ffmpeg` / `ffprobe`（用于 MKV 内封字幕和兼容播放）。

```bash
npm ci
npm start
# http://localhost:8364
```

## License

MIT
