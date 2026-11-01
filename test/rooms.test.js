import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRoomId,
  normalizeVideoUrl,
  RoomStore,
  ValidationError,
} from '../server/rooms.js';

function fixedStore() {
  let now = 1_700_000_000_000;
  let roomCounter = 0;
  const store = new RoomStore({
    now: () => now,
    idFactory: () => `abcd234${(roomCounter++ % 8) + 1}`,
    roomTtlMs: 12 * 60 * 60 * 1_000,
    emptyRoomTtlMs: 60 * 60 * 1_000,
    maxRooms: 3,
  });
  const created = store.create({
    videoUrl: 'https://cdn.example.com/a.mp4',
    title: '电影夜',
    hostName: '小林',
  });
  return {
    store,
    created,
    advance(seconds) {
      now += seconds * 1_000;
    },
    setNow(ms) {
      now = ms;
    },
  };
}

test('房间 ID 与直链会被规范化', () => {
  assert.equal(normalizeRoomId('ABCD2345'), 'abcd2345');
  assert.equal(normalizeRoomId('../etc/passwd'), null);
  assert.equal(
    normalizeVideoUrl(' https://cdn.example.com/a.mp4 '),
    'https://cdn.example.com/a.mp4',
  );
  assert.throws(() => normalizeVideoUrl('javascript:alert(1)'), ValidationError);
  assert.throws(() => normalizeVideoUrl('ftp://example.com/a.mp4'), ValidationError);
  assert.throws(
    () => normalizeVideoUrl('https://user:pass@example.com/a.mp4'),
    ValidationError,
  );
});

test('播放时间轴由服务器锚点推算，暂停后冻结', () => {
  const { store, created, advance } = fixedStore();
  const { room, hostKey } = created;

  assert.equal(store.verifyHost(room, hostKey), true);
  assert.equal(store.verifyHost(room, `${hostKey}x`), false);

  store.applyHostState(room, {
    position: 10,
    playing: true,
    rate: 1,
    duration: 100,
  });
  advance(5);
  assert.equal(store.positionAt(room), 15);
  advance(2);
  assert.equal(store.positionAt(room), 17);

  store.pause(room);
  advance(10);
  assert.equal(store.positionAt(room), 17);
  assert.equal(store.publicRoom(room).playback.playing, false);
});

test('缓冲时时间轴暂停，倍速会被限制在安全范围', () => {
  const { store, created, advance } = fixedStore();
  const { room } = created;
  store.applyHostState(room, {
    position: 5,
    playing: true,
    buffering: true,
    rate: 9,
    duration: 50,
  });
  advance(3);
  assert.equal(store.positionAt(room), 5);
  assert.equal(room.playback.rate, 4);

  store.applyHostState(room, {
    position: 5,
    playing: true,
    buffering: false,
    rate: 2,
    duration: 50,
  });
  advance(2);
  assert.equal(store.positionAt(room), 9);
});

test('播放位置会被限制在视频时长内', () => {
  const { store, created } = fixedStore();
  const { room } = created;
  store.applyHostState(room, {
    position: 999,
    playing: false,
    rate: 1,
    duration: 12,
  });
  assert.equal(store.positionAt(room), 12);
  store.applyHostState(room, { position: -10, duration: 12 });
  assert.equal(store.positionAt(room), 0);
});

test('空房间到期会被清理，有人时不会', () => {
  const { store, created, advance } = fixedStore();
  const { room } = created;
  store.join(room, { host: true });
  advance(30 * 60);
  assert.equal(store.cleanup().length, 0);
  store.leave(room, { host: true });
  advance(59 * 60);
  assert.equal(store.cleanup().length, 0);
  advance(2 * 60);
  const removed = store.cleanup();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, room.id);
  assert.equal(store.get(room.id), null);
});

test('房间容量上限会被执行', () => {
  const { store } = fixedStore();
  for (let index = 0; index < 2; index += 1) {
    store.create({
      videoUrl: 'https://cdn.example.com/a.mp4',
      title: `房间 ${index}`,
      hostName: '房主',
    });
  }
  assert.equal(store.size, 3);
  assert.throws(
    () =>
      store.create({
        videoUrl: 'https://cdn.example.com/b.mp4',
        title: '第四个',
        hostName: '房主',
      }),
    /房间数量已达上限/,
  );
});
