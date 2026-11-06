'use strict';

const path = require('path');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT) || 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

function once(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件 ${event} 超时`));
    }, timeout);
    function handler(data) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    }
    socket.on(event, handler);
  });
}

function waitForState(socket, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', onState);
      reject(new Error('等待满足条件的 state 超时'));
    }, timeout);
    function onState(snapshot) {
      let matched = false;
      try {
        matched = predicate(snapshot);
      } catch (err) {
        matched = false;
      }
      if (!matched) return;
      clearTimeout(timer);
      socket.off('state', onState);
      resolve(snapshot);
    }
    socket.on('state', onState);
  });
}

async function post(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(BASE + pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function get(pathname, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(BASE + pathname, { headers });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function waitForServer(timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/leaderboard`);
      if (response.ok) return;
    } catch (err) {
      /* 服务器尚未就绪 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('服务器启动超时');
}

function findSnake(snapshot, id) {
  return snapshot.snakes.find((snake) => snake.id === id);
}

/* ---------------- 游戏规则单元测试 ---------------- */

function testGameLogic() {
  const { SnakeGame, WORLD_WIDTH, WORLD_HEIGHT } = require('../src/game');

  const game = new SnakeGame();
  game.addPlayer('wall', '撞墙测试');
  const wallSnake = game.snakes.get('wall');
  wallSnake.body = [
    { x: 0, y: 3 },
    { x: 1, y: 3 },
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
  ];
  wallSnake.dir = { x: -1, y: 0 };
  wallSnake.pendingDirs = [];
  game.update();
  assert.equal(wallSnake.alive, false, '撞到边界应当死亡');
  assert.equal(game.deaths[0].reason, 'wall', '死亡原因应为撞墙');
  ok('撞墙判定与死亡原因');

  assert.equal(game.respawn('wall'), false, '冷却期内不应复活');
  wallSnake.respawnAt = Date.now() - 1;
  assert.equal(game.respawn('wall'), true, '冷却结束后应能复活');
  assert.equal(wallSnake.alive, true, '复活后存活');
  assert.equal(wallSnake.score, 0, '复活后分数重置');
  ok('死亡冷却与重生');

  const eating = new SnakeGame();
  eating.addPlayer('eat', '进食测试');
  const eater = eating.snakes.get('eat');
  const head = eater.body[0];
  const target = { x: head.x + 1, y: head.y };
  eating.foods.set(`${target.x},${target.y}`, { x: target.x, y: target.y, type: 'normal' });
  const beforeScore = eater.score;
  const beforeLength = eater.body.length;
  eating.update();
  assert.equal(eater.alive, true, '前进方向没有障碍，应存活');
  assert.equal(eater.score, beforeScore + 10, '吃到普通食物应 +10 分');
  assert.equal(eater.body.length, beforeLength + 1, '吃到食物应增加长度');
  ok('吃食物加分与增长');

  const head2head = new SnakeGame();
  head2head.addPlayer('a', '玩家A');
  head2head.addPlayer('b', '玩家B');
  const snakeA = head2head.snakes.get('a');
  const snakeB = head2head.snakes.get('b');
  snakeA.body = [
    { x: 5, y: 10 },
    { x: 4, y: 10 },
    { x: 3, y: 10 },
    { x: 2, y: 10 },
    { x: 1, y: 10 },
  ];
  snakeA.dir = { x: 1, y: 0 };
  snakeA.pendingDirs = [];
  snakeB.body = [
    { x: 7, y: 10 },
    { x: 8, y: 10 },
    { x: 9, y: 10 },
    { x: 10, y: 10 },
    { x: 11, y: 10 },
  ];
  snakeB.dir = { x: -1, y: 0 };
  snakeB.pendingDirs = [];
  head2head.update();
  assert.equal(snakeA.alive, false, '正面相撞双方都应死亡');
  assert.equal(snakeB.alive, false, '正面相撞双方都应死亡');
  assert.equal(head2head.deaths.length, 2, '应产生两条死亡记录');
  ok('蛇头正面相撞判定');

  const self = new SnakeGame();
  self.addPlayer('s', '自撞测试');
  const selfSnake = self.snakes.get('s');
  selfSnake.body = [
    { x: 10, y: 10 },
    { x: 10, y: 11 },
    { x: 11, y: 11 },
    { x: 11, y: 10 },
    { x: 11, y: 9 },
    { x: 10, y: 9 },
    { x: 9, y: 9 },
    { x: 9, y: 10 },
    { x: 9, y: 11 },
  ];
  selfSnake.dir = { x: -1, y: 0 };
  selfSnake.pendingDirs = [];
  self.update();
  assert.equal(selfSnake.alive, false, '咬到自己身体应当死亡');
  assert.equal(self.deaths[0].reason, 'self', '死亡原因为自撞');
  ok('自撞判定');

  /* 回归：刚进游戏不应该"莫名其妙"死掉（bug：出生点朝向墙、没有反应距离） */

  const waiting = new SnakeGame();
  waiting.addPlayer('wait', '等待测试', { waitForInput: true });
  const waitingSnake = waiting.snakes.get('wait');
  const restingBody = JSON.stringify(waitingSnake.body);
  for (let i = 0; i < 60; i += 1) waiting.update();
  assert.equal(waitingSnake.alive, true, '等待第一次操作期间不应死亡');
  assert.equal(JSON.stringify(waitingSnake.body), restingBody, '等待第一次操作期间应停在原地');
  ok('开局等待玩家操作，不会自己撞死');

  const firstStep = new SnakeGame();
  firstStep.addPlayer('step', '起步测试', { waitForInput: true });
  const stepSnake = firstStep.snakes.get('step');
  const stepHead = stepSnake.body[0];
  const room = {
    up: stepHead.y,
    down: WORLD_HEIGHT - 1 - stepHead.y,
    left: stepHead.x,
    right: WORLD_WIDTH - 1 - stepHead.x,
  };
  for (const [name, cells] of Object.entries(room)) {
    assert.ok(cells >= 8, `出生点朝 ${name} 方向应至少留出 8 格反应距离，实际 ${cells}`);
  }
  ok('出生点四周留出足够的反应距离');

  for (const name of ['up', 'down', 'left', 'right']) {
    for (let round = 0; round < 12; round += 1) {
      const round_ = new SnakeGame();
      round_.addPlayer('go', '起步', { waitForInput: true });
      round_.setDirection('go', name);
      round_.update();
      assert.equal(
        round_.snakes.get('go').alive,
        true,
        `以 ${name} 作为第一次操作时，第一步不应立刻死亡`
      );
    }
  }
  ok('任意方向都可以安全起步（含原地掉头）');
}

/* ---------------- 静态资源 ---------------- */

async function testStaticAssets() {
  const checks = [
    ['/', /霓虹贪吃蛇/, 'text/html'],
    ['/css/style.css', /\.auth-view/, 'text/css'],
    ['/js/app.js', /requestAnimationFrame/, 'javascript'],
    ['/socket.io/socket.io.js', /socket/, 'javascript'],
  ];

  for (const [pathname, pattern, typeHint] of checks) {
    const response = await fetch(BASE + pathname);
    const body = await response.text();
    const contentType = response.headers.get('content-type') || '';
    assert.equal(response.status, 200, `${pathname} 应返回 200`);
    assert.ok(body.length > 200, `${pathname} 内容不应为空`);
    assert.match(body, pattern, `${pathname} 内容应符合预期`);
    assert.ok(contentType.includes(typeHint), `${pathname} 内容类型应包含 ${typeHint}`);
  }
  ok('首页、样式、脚本与 Socket.IO 客户端均可访问');

  // 回归：地图边界必须画在蛇之上，并且开局要有"按方向键开始"的提示
  const appJs = await (await fetch(`${BASE}/js/app.js`)).text();
  assert.match(appJs, /function drawBoundary/, '前端应有专门的地图边界绘制逻辑');
  assert.ok(
    appJs.indexOf('drawBoundary(ctx, snapshot, now, view, me)') >
      appJs.indexOf('drawSnake(ctx, snake, bodies.get(snake.id), view)'),
    '边界必须画在蛇之后，避免被蛇身遮挡'
  );
  assert.match(appJs, /function interpolateBody/, '蛇的位置必须做连续插值');
  assert.match(appJs, /const gap = clamp\(now - state\.curAt/, '插值时长必须用真实的 state 到达间隔');
  assert.match(appJs, /state\.span = state\.gapAvg \* 1\.1/, '插值时长必须用平滑后的平均间隔 + 余量');
  assert.ok(
    appJs.indexOf('const clock = performance.now()') > 0,
    '插值必须用 performance.now()，不能用 rAF 时间戳（可能早于 state 到达时刻，导致抽搐）'
  );
  assert.match(appJs, /function drawBoundaryWarn/, '边界在屏幕外时也应有屏幕边缘预警');
  assert.ok(
    !/px > viewW \+ TILE/.test(appJs),
    '蛇的剔除必须按可视世界范围判断，不能拿世界坐标跟屏幕尺寸比较'
  );
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  assert.match(indexHtml, /id="start-hint"/, '游戏界面应有开局操作提示');
  const appJsCache = (await fetch(`${BASE}/js/app.js`)).headers.get('cache-control') || '';
  assert.ok(!/max-age=[1-9]/.test(appJsCache), `JS 不应被长时间强缓存（当前 ${appJsCache || '无'}）`);
  ok('地图边界绘制、贴边预警与开局提示存在');

  const fallback = await fetch(`${BASE}/play/room/1`);
  assert.equal(fallback.status, 200, '前端路由应回退到首页');

  const api404 = await fetch(`${BASE}/api/not-exist`);
  assert.equal(api404.status, 404, '不存在的接口应返回 404');

  const headersResponse = await fetch(`${BASE}/`);
  assert.equal(
    headersResponse.headers.get('x-content-type-options'),
    'nosniff',
    '应设置安全响应头'
  );
  ok('前端路由回退、接口 404 与安全响应头');
}

/* ---------------- 端到端测试 ---------------- */

async function testNetwork(server) {
  void server;
  const suffix = Date.now().toString(36).slice(-6);
  const userA = `联机测试A_${suffix}`;
  const userB = `联机测试B_${suffix}`;
  const password = 'snake123456';

  const registeredA = await post('/api/register', { username: userA, password });
  assert.equal(registeredA.status, 200, '注册玩家 A 应成功');
  assert.ok(registeredA.data.token && registeredA.data.token.length >= 32, '应返回会话 token');
  ok('账号注册（玩家 A）');

  const registeredB = await post('/api/register', { username: userB, password });
  assert.equal(registeredB.status, 200, '注册玩家 B 应成功');
  ok('账号注册（玩家 B）');

  const duplicate = await post('/api/register', { username: userA, password });
  assert.equal(duplicate.status, 400, '重复用户名应被拒绝');
  ok('重复用户名拦截');

  const badLogin = await post('/api/login', { username: userA, password: 'wrong-password' });
  assert.equal(badLogin.status, 401, '错误密码应被拒绝');
  ok('错误密码拦截');

  const goodLogin = await post('/api/login', { username: userA, password });
  assert.equal(goodLogin.status, 200, '正确密码应登录成功');
  ok('账号登录');

  const me = await get('/api/me', registeredA.data.token);
  assert.equal(me.status, 200, '携带 token 应能获取资料');
  assert.equal(me.data.user.username, userA, '资料用户名应匹配');
  ok('会话鉴权（/api/me）');

  const unauthorized = io(BASE, {
    auth: { token: 'not-a-valid-token' },
    transports: ['websocket'],
    reconnection: false,
  });
  const authError = await once(unauthorized, 'connect_error');
  assert.match(String(authError.message), /unauthorized/, '未授权连接应被拒绝');
  unauthorized.close();
  ok('未登录禁止连接实时服务');

  const socketA = io(BASE, {
    auth: { token: registeredA.data.token },
    transports: ['websocket'],
    reconnection: false,
  });
  const socketB = io(BASE, {
    auth: { token: registeredB.data.token },
    transports: ['websocket'],
    reconnection: false,
  });

  const welcomeA = await once(socketA, 'welcome');
  const welcomeB = await once(socketB, 'welcome');
  assert.equal(welcomeA.username, userA, '玩家 A 的欢迎消息用户名正确');
  assert.ok(welcomeA.id, '欢迎消息应包含蛇 id');
  assert.ok(welcomeA.world && welcomeA.world.w > 0, '欢迎消息应包含世界尺寸');
  assert.ok(welcomeB.id, '玩家 B 应获得蛇 id');
  ok('双人实时连接并收到欢迎消息');

  const initialState = await waitForState(
    socketA,
    (snapshot) =>
      findSnake(snapshot, welcomeA.id) && findSnake(snapshot, welcomeB.id),
    8000
  );
  assert.ok(initialState.online >= 2, '在线人数应至少为 2');
  assert.ok(Array.isArray(initialState.foods) && initialState.foods.length > 0, '应同步食物');
  assert.ok(initialState.leaderboard.length >= 2, '排行榜应包含两名玩家');
  ok('共享世界状态同步（蛇、食物、排行榜）');

  const snakeA0 = findSnake(initialState, welcomeA.id);
  const startHeadY = snakeA0.body[1];

  socketA.emit('input', 'down');
  const movedState = await waitForState(
    socketA,
    (snapshot) => {
      const snake = findSnake(snapshot, welcomeA.id);
      return snake && snake.body[1] > startHeadY;
    },
    8000
  );
  const snakeA1 = findSnake(movedState, welcomeA.id);
  assert.ok(snakeA1.body[1] > startHeadY, '向下指令应让蛇头沿 y 轴前进');
  ok('方向指令生效（服务器权威移动）');

  const seenByB = await waitForState(
    socketB,
    (snapshot) => {
      const snake = findSnake(snapshot, welcomeA.id);
      return snake && snake.alive === 1;
    },
    8000
  );
  assert.ok(findSnake(seenByB, welcomeA.id), '其他玩家也能收到该玩家的状态');
  ok('状态广播给其他玩家');

  const profileBefore = await get('/api/me', registeredA.data.token);
  assert.equal(profileBefore.status, 200, 'token 仍然有效');

  socketB.disconnect();
  const afterLeave = await waitForState(
    socketA,
    (snapshot) => !findSnake(snapshot, welcomeB.id),
    8000
  );
  assert.ok(afterLeave.online >= 1, '玩家 B 离开后在线人数应减少');
  ok('玩家断线后从世界中移除');

  socketA.disconnect();
}

/* ---------------- 入口 ---------------- */

async function main() {
  console.log('\n[1/2] 游戏规则单元测试');
  testGameLogic();

  console.log('\n[2/2] 端到端联机测试');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  try {
    await waitForServer();
    ok('服务器启动成功');
    await testStaticAssets();
    await testNetwork(server);
  } finally {
    server.kill();
    if (process.env.DEBUG_TEST) {
      console.log('\n--- 服务器日志 ---\n' + serverLog);
    }
  }

  console.log(`\n全部通过，共 ${passed} 项检查。`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n测试失败：', err);
    process.exit(1);
  });