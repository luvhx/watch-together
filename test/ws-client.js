import { WebSocket } from 'ws';

/** 小型测试客户端：缓存早于断言到达的消息，避免时间竞态。 */
export class TestSocket {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closedPromise = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(
            new Error(`socket closed before message: ${code} ${reason}`),
          );
        }
        resolve(this.closed);
      });
    });
    this.ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open() {
    await this.opened;
    return this;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  next(match, timeoutMs = 3_000) {
    const predicate = typeof match === 'string'
      ? (message) => message.type === match
      : match;
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.messages.splice(index, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(
            `timed out waiting for message; queued=${JSON.stringify(this.messages)}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ match: predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close();
    }
    await this.closedPromise;
  }
}

export async function joinRoom(wsUrl, roomId, { hostKey, name } = {}) {
  const socket = await new TestSocket(
    `${wsUrl}/ws?room=${encodeURIComponent(roomId)}`,
  ).open();
  socket.send({ type: 'hello', name, ...(hostKey ? { hostKey } : {}) });
  const welcome = await socket.next('welcome');
  return { socket, welcome };
}
