import { createApplication } from '../server/app.js';
import { loadConfig } from '../server/config.js';

export const quietLogger = {
  log() {},
  warn() {},
  error() {},
};

export async function startTestApp(overrides = {}) {
  const config = {
    ...loadConfig({}),
    syncIntervalMs: 5_000,
    hostTimeoutMs: 1_000,
    createLimitPer10Min: 1_000,
    wsLimitPerMin: 1_000,
    ...overrides,
  };
  const app = createApplication({ config, logger: quietLogger });
  await app.listen(0, '127.0.0.1');
  const { port } = app.server.address();
  return {
    ...app,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
}

export async function createRoom(baseUrl, overrides = {}) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl: 'https://cdn.example.com/movie.mp4',
      title: '周五电影夜',
      hostName: '小林',
      ...overrides,
    }),
  });
  const payload = await response.json();
  return { response, payload };
}
