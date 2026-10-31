import { createServer } from 'node:http';

import { loadConfig } from './config.js';
import { CompatHlsService } from './compat-hls.js';
import { EmbeddedSubtitleService } from './embedded-subtitles.js';
import { createHttpHandler } from './http.js';
import { RoomHub } from './realtime.js';
import { RoomStore } from './rooms.js';

export function createApplication({
  config = loadConfig(),
  logger = console,
  publicDir,
  embeddedSubtitles,
  compatHls,
} = {}) {
  const store = new RoomStore({
    roomTtlMs: config.roomTtlMs,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    maxRooms: config.maxRooms,
  });
  const hub = new RoomHub({ store, config, logger });
  const subtitleService =
    embeddedSubtitles ??
    new EmbeddedSubtitleService({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      allowPrivateMedia: config.allowPrivateMedia,
      logger,
    });
  const compatService =
    compatHls ??
    new CompatHlsService({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      allowPrivateMedia: config.allowPrivateMedia,
      maxJobs: config.compatHlsMaxJobs,
      logger,
    });
  const handleRequest = createHttpHandler({
    store,
    hub,
    config,
    embeddedSubtitles: subtitleService,
    compatHls: compatService,
    ...(publicDir ? { publicDir } : {}),
  });

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error?.('[http] unhandled request error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  hub.attach(server);

  let closed = false;
  return {
    config,
    store,
    hub,
    server,
    embeddedSubtitles: subtitleService,
    compatHls: compatService,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      subtitleService.close?.();
      await compatService.close?.();
      hub.close();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 2_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections?.();
      });
    },
  };
}
