'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

const auth = require('./src/auth');
const { SnakeGame, TICK_MS, WORLD_WIDTH, WORLD_HEIGHT } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 10000,
  pingTimeout: 8000,
});

const game = new SnakeGame();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// 静态资源：图片等可以缓存，但 HTML/JS 必须每次校验，
// 否则改完代码浏览器还在用缓存里的旧版本（改了却没生效的经典原因）。
app.use(
  express.static(PUBLIC_DIR, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (/\.(html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/* ---------------- 简易限流 ---------------- */

const rateBuckets = new Map();

function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ ok: false, error: '操作过于频繁，请稍后再试' });
      return;
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start > 10 * 60 * 1000) rateBuckets.delete(ip);
  }
}, 10 * 60 * 1000).unref?.();

/* ---------------- HTTP 接口 ---------------- */

function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

app.post('/api/register', rateLimit(30, 60000), (req, res) => {
  const { username, password } = req.body || {};
  const result = auth.register(username, password);
  if (!result.ok) {
    fail(res, 400, result.error);
    return;
  }
  const token = auth.createSession(result.user.username);
  res.json({ ok: true, token, user: result.user });
});

app.post('/api/login', rateLimit(30, 60000), (req, res) => {
  const { username, password } = req.body || {};
  const result = auth.login(username, password);
  if (!result.ok) {
    fail(res, 401, result.error);
    return;
  }
  const token = auth.createSession(result.user.username);
  res.json({ ok: true, token, user: result.user });
});

app.post('/api/logout', (req, res) => {
  auth.revokeToken(tokenFromRequest(req));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const username = auth.verifyToken(tokenFromRequest(req));
  if (!username) {
    fail(res, 401, '登录已过期，请重新登录');
    return;
  }
  const user = auth.getProfile(username);
  if (!user) {
    fail(res, 401, '账号不存在');
    return;
  }
  res.json({ ok: true, user });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ ok: true, players: auth.getTopUsers(10), online: game.playerCount });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    fail(res, 404, '接口不存在');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    fail(res, 400, '请求格式错误');
    return;
  }
  console.error('[server] 请求处理失败：', err);
  fail(res, 500, '服务器内部错误');
});

/* ---------------- 实时对战 ---------------- */

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = auth.verifyToken(token);
  if (!username) {
    next(new Error('unauthorized'));
    return;
  }
  socket.data.username = username;
  next();
});

io.on('connection', (socket) => {
  const username = socket.data.username;
  // 新玩家先原地待命，等第一次方向操作再起步，避免"开局就撞墙"
  const snake = game.addPlayer(socket.id, username, { waitForInput: true });

  socket.emit('welcome', {
    id: socket.id,
    username,
    tickMs: TICK_MS,
    world: { w: WORLD_WIDTH, h: WORLD_HEIGHT },
    snake,
    profile: auth.getProfile(username),
  });

  socket.on('input', (dir) => {
    game.setDirection(socket.id, dir);
  });

  socket.on('respawn', () => {
    if (game.respawn(socket.id)) socket.emit('respawned');
  });

  socket.on('disconnect', () => {
    game.removePlayer(socket.id);
  });
});

setInterval(() => {
  try {
    game.update();

    for (const death of game.deaths) {
      auth.recordGame(death.name, death.score, death.length);
      const snake = game.snakes.get(death.id);
      const respawnIn = snake && !snake.alive ? Math.max(0, snake.respawnAt - Date.now()) : 0;
      io.to(death.id).emit('you-died', {
        score: death.score,
        length: death.length,
        reason: death.reason,
        killer: death.killer,
        respawnIn,
      });
    }

    io.emit('state', game.serialize());
  } catch (err) {
    console.error('[game] 游戏循环异常：', err);
  }
}, TICK_MS);

/* ---------------- 启动 ---------------- */

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address);
    }
  }
  return result;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  多人联机贪吃蛇已启动');
  console.log(`  本机访问：http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网访问：http://${ip}:${PORT}`);
  }
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});