import { createApplication } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApplication({ config });

let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[watch-together] 收到 ${signal}，正在关闭...`);
  const forceTimer = setTimeout(() => {
    console.error('[watch-together] 关闭超时，强制退出');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  try {
    await app.close();
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (error) {
    console.error('[watch-together] 关闭失败', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

try {
  const address = await app.listen();
  const shownHost =
    config.host === '0.0.0.0' || config.host === '::'
      ? 'localhost'
      : config.host;
  console.log(
    `[watch-together] 已启动：http://${shownHost}:${address.port}  ` +
      `(房间 TTL ${Math.round(config.roomTtlMs / 3_600_000)}h，` +
      `上限 ${config.maxMembers} 人)`,
  );
} catch (error) {
  console.error('[watch-together] 启动失败', error);
  process.exit(1);
}
