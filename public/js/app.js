'use strict';

(function () {
  const TILE = 22;
  const WALL_WARN_CELLS = 6;
  const STORAGE_KEY = 'neon-snake.token';
  const KEY_DIRS = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right',
    W: 'up',
    A: 'left',
    S: 'down',
    D: 'right',
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    authView: $('auth-view'),
    gameView: $('game-view'),
    authForm: $('auth-form'),
    username: $('username'),
    password: $('password'),
    authError: $('auth-error'),
    submitBtn: $('submit-btn'),
    submitLabel: $('submit-label'),
    tabs: document.querySelectorAll('.tab'),
    historyList: $('history-list'),
    historyOnline: $('history-online'),
    canvas: $('game-canvas'),
    minimap: $('minimap'),
    myScore: $('my-score'),
    myLength: $('my-length'),
    myKills: $('my-kills'),
    myBest: $('my-best'),
    onlineCount: $('online-count'),
    who: $('who'),
    liveList: $('live-list'),
    logoutBtn: $('logout-btn'),
    deathOverlay: $('death-overlay'),
    deathReason: $('death-reason'),
    deathScore: $('death-score'),
    respawnBtn: $('respawn-btn'),
    respawnHint: $('respawn-hint'),
    touchPad: $('touch-pad'),
    toast: $('toast'),
    connectStatus: $('connect-status'),
    startHint: $('start-hint'),
  };

  const state = {
    token: localStorage.getItem(STORAGE_KEY) || '',
    user: null,
    socket: null,
    myId: null,
    tickMs: 130,
    world: { w: 80, h: 50 },
    cur: null,
    prev: null,
    curAt: 0,
    span: 0,
    gapAvg: 0,
    fromBodies: new Map(),
    liveBodies: new Map(),
    lastFrameAt: 0,
    camera: { x: 0, y: 0, ready: false },
    best: 0,
    dead: false,
    respawnTimer: null,
    ctx: null,
    minimapCtx: null,
    viewW: 0,
    viewH: 0,
    dpr: 1,
    authMode: 'login',
    touchStart: null,
  };

  /* ---------------- 基础工具 ---------------- */

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function toast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  async function api(path, options = {}) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, Object.assign({}, options, { headers }));
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok || !data || data.ok === false) {
      const error = new Error((data && data.error) || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /* ---------------- 登录与注册 ---------------- */

  function setAuthMode(mode) {
    state.authMode = mode;
    els.tabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.submitLabel.textContent = mode === 'login' ? '登录并进入游戏' : '注册并进入游戏';
    els.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    els.authError.textContent = '';
    els.password.value = '';
  }

  function bindAuth() {
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
    });

    els.authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = els.username.value.trim();
      const password = els.password.value;
      els.authError.textContent = '';

      if (username.length < 2) {
        els.authError.textContent = '请输入至少 2 个字符的用户名';
        els.username.focus();
        return;
      }
      if (password.length < 6) {
        els.authError.textContent = '密码至少需要 6 位字符';
        els.password.focus();
        return;
      }

      els.submitBtn.disabled = true;
      const originalText = els.submitLabel.textContent;
      els.submitLabel.textContent = state.authMode === 'login' ? '登录中…' : '注册中…';

      try {
        const endpoint = state.authMode === 'login' ? '/api/login' : '/api/register';
        const data = await api(endpoint, {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        state.token = data.token;
        localStorage.setItem(STORAGE_KEY, data.token);
        els.password.value = '';
        enterGame(data.user);
      } catch (err) {
        els.authError.textContent = err.message || '操作失败，请重试';
      } finally {
        els.submitBtn.disabled = false;
        els.submitLabel.textContent = originalText;
      }
    });
  }

  async function tryAutoLogin() {
    try {
      const data = await api('/api/me');
      enterGame(data.user);
    } catch (err) {
      clearSession();
      els.authError.textContent = '';
    }
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async function logout(silent) {
    const token = state.token;
    if (state.socket) {
      state.socket.removeAllListeners();
      state.socket.disconnect();
      state.socket = null;
    }
    clearSession();
    state.cur = null;
    state.prev = null;
    state.camera.ready = false;
    state.dead = false;
    clearInterval(state.respawnTimer);
    els.deathOverlay.hidden = true;
    els.gameView.hidden = true;
    els.authView.hidden = false;
    els.onlineCount.textContent = '在线 0 人';
    els.liveList.replaceChildren();
    if (!silent && token) {
      fetch('/api/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    loadHistory();
  }

  /* ---------------- 进入游戏 ---------------- */

  function enterGame(user) {
    state.user = user || state.user;
    state.best = Math.max(state.best, (user && user.bestScore) || 0);
    els.who.textContent = state.user ? state.user.username : '';
    els.myBest.textContent = state.best;
    els.authView.hidden = true;
    els.gameView.hidden = false;
    els.authError.textContent = '';
    resizeCanvas();
    connectSocket();
    toast('已进入服务器，使用 WASD / 方向键控制');
  }

  function connectSocket() {
    if (typeof window.io !== 'function') {
      toast('实时通信模块加载失败，请刷新页面');
      return;
    }
    if (state.socket) {
      state.socket.removeAllListeners();
      state.socket.disconnect();
    }

    els.connectStatus.hidden = false;
    els.connectStatus.textContent = '正在连接服务器…';

    const socket = window.io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('connect', () => {
      els.connectStatus.hidden = true;
      state.dead = false;
    });

    socket.on('connect_error', (err) => {
      if (String(err && err.message) === 'unauthorized') {
        toast('登录已失效，请重新登录');
        logout(true);
        return;
      }
      els.connectStatus.hidden = false;
      els.connectStatus.textContent = '连接失败，正在重试…';
    });

    socket.on('disconnect', () => {
      els.connectStatus.hidden = false;
      els.connectStatus.textContent = '与服务器断开，正在重连…';
    });

    socket.on('welcome', (data) => {
      state.myId = data.id;
      state.tickMs = data.tickMs || 130;
      state.world = data.world || state.world;
      state.best = Math.max(state.best, (data.profile && data.profile.bestScore) || 0);
      els.myBest.textContent = state.best;
      state.camera.ready = false;
      state.dead = false;
      state.fromBodies.clear();
      state.liveBodies.clear();
      state.span = 0;
      state.gapAvg = 0;
      state.lastFrameAt = 0;
      clearInterval(state.respawnTimer);
      els.deathOverlay.hidden = true;
      els.connectStatus.hidden = true;
      resizeCanvas();
    });

    socket.on('state', (snapshot) => {
      const now = performance.now();
      if (state.cur) {
        state.prev = state.cur;
        const spanBefore = state.span || state.tickMs;
        // 插值时长的来源：平滑后的平均到达间隔 + 10% 余量
        const gap = clamp(now - state.curAt, state.tickMs * 0.5, state.tickMs * 2);
        state.gapAvg = state.gapAvg ? state.gapAvg + (gap - state.gapAvg) * 0.25 : gap;
        // 新一段的插值起点 = "收到 state 这一刻，屏幕上蛇应该在的位置"。
        // 直接用上一帧画出来的位置会落后最多一帧，每 tick 都会有一次微小停顿。
        const tArrive = clamp((now - state.curAt) / spanBefore, 0, 1);
        const cooked = new Map();
        for (const snake of state.cur.snakes) {
          if (!snake.alive) continue;
          const from = state.fromBodies.get(snake.id)
            || (state.liveBodies.get(snake.id) || null);
          cooked.set(snake.id, interpolateBody(snake.body, from, tArrive));
        }
        state.fromBodies = cooked;
        state.span = state.gapAvg * 1.1;
      }
      state.cur = snapshot;
      state.curAt = now;
      updateHud(snapshot);
      updateStartHint(snapshot);
      renderLiveLeaderboard(snapshot.leaderboard || []);
    });

    socket.on('you-died', (info) => {
      state.dead = true;
      showDeath(info);
    });

    socket.on('respawned', () => {
      state.dead = false;
      state.camera.ready = false;
      clearInterval(state.respawnTimer);
      els.deathOverlay.hidden = true;
      toast('已重生，继续战斗！');
    });
  }

  /* ---------------- 死亡与重生 ---------------- */

  function describeDeath(info) {
    if (!info) return '你被淘汰了';
    switch (info.reason) {
      case 'wall':
        return '撞上了地图边界';
      case 'self':
        return '咬到了自己的身体';
      case 'head':
        return '与对手正面相撞';
      case 'body':
        return info.killer ? `撞上了「${info.killer}」的身体` : '撞上了其他玩家的身体';
      default:
        return '你被淘汰了';
    }
  }

  function showDeath(info) {
    els.deathOverlay.hidden = false;
    els.deathScore.textContent = String((info && info.score) || 0);
    els.deathReason.textContent = describeDeath(info);
    els.respawnBtn.disabled = true;

    const wait = Math.max(0, Number(info && info.respawnIn) || 0) + 150;
    const deadline = performance.now() + wait;
    els.respawnHint.textContent = `将在 ${(wait / 1000).toFixed(1)} 秒后自动重生`;

    clearInterval(state.respawnTimer);
    state.respawnTimer = setInterval(() => {
      const left = deadline - performance.now();
      if (left > 0) {
        els.respawnHint.textContent = `将在 ${(left / 1000).toFixed(1)} 秒后自动重生`;
        return;
      }
      clearInterval(state.respawnTimer);
      els.respawnHint.textContent = '正在重生…';
      els.respawnBtn.disabled = false;
      if (state.socket && state.socket.connected) state.socket.emit('respawn');
    }, 100);
  }

  function bindGame() {
    window.addEventListener('keydown', (event) => {
      if (els.gameView.hidden) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const dir = KEY_DIRS[event.key];
      if (!dir) return;
      event.preventDefault();
      sendDirection(dir);
    });

    els.logoutBtn.addEventListener('click', () => logout(false));

    els.respawnBtn.addEventListener('click', () => {
      if (state.socket && state.socket.connected) state.socket.emit('respawn');
    });

    els.touchPad.querySelectorAll('.touch-btn').forEach((button) => {
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        sendDirection(button.dataset.dir);
      });
    });

    if (window.matchMedia('(pointer: coarse)').matches) {
      els.touchPad.hidden = false;
    }

    const canvas = els.canvas;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      state.touchStart = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!state.touchStart) return;
      const dx = event.clientX - state.touchStart.x;
      const dy = event.clientY - state.touchStart.y;
      state.touchStart = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        sendDirection(dx > 0 ? 'right' : 'left');
      } else {
        sendDirection(dy > 0 ? 'down' : 'up');
      }
    });

    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resizeCanvas();
    });
  }

  function sendDirection(dir) {
    if (state.socket && state.socket.connected) state.socket.emit('input', dir);
  }

  /* ---------------- HUD ---------------- */

  function updateHud(snapshot) {
    const me = findSnake(snapshot, state.myId);
    if (me) {
      els.myScore.textContent = String(me.score);
      els.myLength.textContent = String(me.len);
      els.myKills.textContent = String(me.kills);
      state.best = Math.max(state.best, me.score);
      els.myBest.textContent = String(state.best);
    }
    els.onlineCount.textContent = `在线 ${snapshot.online || 0} 人`;
  }

  // 蛇在原地等待玩家第一次操作时，给出明确提示，避免"为什么不动"的困惑
  function updateStartHint(snapshot) {
    if (!els.startHint) return;
    const me = findSnake(snapshot, state.myId);
    els.startHint.hidden = !(me && me.alive && me.waiting);
  }

  function renderLiveLeaderboard(list) {
    const frag = document.createDocumentFragment();
    list.forEach((item, index) => {
      const li = document.createElement('li');
      if (item.id === state.myId) li.classList.add('me');
      if (!item.alive) li.classList.add('dead');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.id === state.myId ? `${item.name}（你）` : item.name;

      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = String(item.score);

      li.append(rank, name, score);
      frag.appendChild(li);
    });
    els.liveList.replaceChildren(frag);
  }

  async function loadHistory() {
    try {
      const data = await api('/api/leaderboard');
      els.historyOnline.textContent = `在线 ${data.online || 0} 人`;
      const frag = document.createDocumentFragment();
      (data.players || []).forEach((player, index) => {
        const li = document.createElement('li');

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = String(index + 1);

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = player.username;

        const score = document.createElement('span');
        score.className = 'score';
        score.textContent = String(player.bestScore);

        li.append(rank, name, score);
        frag.appendChild(li);
      });
      if (frag.childNodes.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'history-empty';
        empty.textContent = '暂无战绩，快来成为第一名！';
        frag.appendChild(empty);
      }
      els.historyList.replaceChildren(frag);
    } catch (err) {
      els.historyList.replaceChildren();
    }
  }

  /* ---------------- 渲染 ---------------- */

  function resizeCanvas() {
    if (els.gameView.hidden) return;
    const canvas = els.canvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.viewW = rect.width;
    state.viewH = rect.height;
    const width = Math.round(rect.width * state.dpr);
    const height = Math.round(rect.height * state.dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function findSnake(snapshot, id) {
    if (!snapshot || !snapshot.snakes) return null;
    for (const snake of snapshot.snakes) {
      if (snake.id === id) return snake;
    }
    return null;
  }

  /**
   * 把一条蛇从 from 插值到 body，返回扁平的 [x0,y0,x1,y1,...]。
   * from 可以是上一帧真正画出来的位置（可能是小数），所以位置随时间是连续的。
   */
  function interpolateBody(body, from, t) {
    const total = body.length / 2;
    if (!from) return body;
    // t=0 时必须停在 from（上一帧画出来的位置），绝不能跳到目标位置，
    // 否则会出现"这一帧跳到前面、下一帧又跳回来"的抽搐。
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    const fromLength = from.length / 2;
    const out = new Array(total * 2);
    for (let i = 0; i < total; i += 1) {
      const j = i * 2;
      if (i < fromLength) {
        out[j] = lerp(from[j], body[j], k);
        out[j + 1] = lerp(from[j + 1], body[j + 1], k);
      } else {
        // 变长时新增的尾节没有可插值的前身，直接放到目标位置
        out[j] = body[j];
        out[j + 1] = body[j + 1];
      }
    }
    return out;
  }

  function render(now) {
    if (els.gameView.hidden || !state.ctx) return;
    resizeCanvas();
    const ctx = state.ctx;
    const width = state.viewW;
    const height = state.viewH;
    if (!width || !height) return;

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, width, height);

    const snapshot = state.cur;
    if (!snapshot) return;

    const prevSnapshot = state.prev;
    // 用 performance.now() 而不是 rAF 的时间戳：rAF 时间戳是"这一帧开始"的时刻，
    // 可能早于刚刚收到 state 的时刻，会算出负的 t 导致抽搐。
    const clock = performance.now();
    // 用真实到达间隔做插值时长，避免收到 state 时"跳一下 / 卡一下"
    const span = state.span || state.tickMs;
    const t = prevSnapshot ? clamp((clock - state.curAt) / span, 0, 1) : 0;
    const me = findSnake(snapshot, state.myId);

    // 先把所有蛇这一帧的插值位置算出来：
    // 1) 用来绘制；2) 存成下一帧的插值起点，这样位置永远是时间的连续函数，
    //    即使 state 到达有抖动，头部也不会在每次收到 state 时突跳。
    const bodies = new Map();
    for (const snake of snapshot.snakes) {
      if (!snake.alive) continue;
      const prevSnake = prevSnapshot ? findSnake(prevSnapshot, snake.id) : null;
      const from = state.fromBodies.get(snake.id)
        || (prevSnake && prevSnake.alive ? prevSnake.body : null);
      bodies.set(snake.id, interpolateBody(snake.body, from, t));
    }
    state.liveBodies = bodies;

    const myBody = bodies.get(state.myId);
    let targetX = state.camera.x;
    let targetY = state.camera.y;
    if (myBody && myBody.length >= 2) {
      targetX = (myBody[0] + 0.5) * TILE;
      targetY = (myBody[1] + 0.5) * TILE;
    }
    // 镜头跟随按时间常数收敛：掉帧时手感一致，不会因为帧率低而变"拖"
    const frameDt = state.lastFrameAt ? clamp(clock - state.lastFrameAt, 1, 100) : 16.7;
    state.lastFrameAt = clock;
    const follow = 1 - Math.pow(1 - 0.18, frameDt / 16.7);
    if (!state.camera.ready) {
      state.camera.x = targetX;
      state.camera.y = targetY;
      state.camera.ready = true;
    } else {
      state.camera.x = lerp(state.camera.x, targetX, follow);
      state.camera.y = lerp(state.camera.y, targetY, follow);
    }

    const worldW = snapshot.w * TILE;
    const worldH = snapshot.h * TILE;
    const halfW = width / 2;
    const halfH = height / 2;
    if (worldW > width) {
      state.camera.x = clamp(state.camera.x, halfW, worldW - halfW);
    } else {
      state.camera.x = worldW / 2;
    }
    if (worldH > height) {
      state.camera.y = clamp(state.camera.y, halfH, worldH - halfH);
    } else {
      state.camera.y = worldH / 2;
    }

    const originX = width / 2 - state.camera.x;
    const originY = height / 2 - state.camera.y;

    ctx.save();
    ctx.translate(originX, originY);

    // 可视范围（世界坐标），边界危险区只需要处理这一块
    const view = {
      x0: -originX,
      y0: -originY,
      x1: width - originX,
      y1: height - originY,
    };

    drawWorld(ctx, snapshot, now);

    for (const food of snapshot.foods) {
      drawFood(ctx, food, now, view);
    }

    const ordered = snapshot.snakes.slice().sort((a, b) => {
      const aMe = a.id === state.myId ? 1 : 0;
      const bMe = b.id === state.myId ? 1 : 0;
      if (aMe !== bMe) return aMe - bMe;
      return a.len - b.len;
    });

    for (const snake of ordered) {
      drawSnake(ctx, snake, bodies.get(snake.id), view);
    }

    // 边界画在蛇之上，避免贴着边界时被蛇身遮住而"看不见墙"
    drawBoundary(ctx, snapshot, now, view, me);

    ctx.restore();

    // 屏幕边缘的贴边预警：镜头跟随时真正的边界线可能在屏幕外，
    // 用屏幕四周的红色渐变让玩家始终能感知"墙还有多远"。
    drawBoundaryWarn(ctx, snapshot, now, me, width, height);

    drawMinimap(snapshot, now);
  }

  function drawWorld(ctx, snapshot, now) {
    const worldW = snapshot.w * TILE;
    const worldH = snapshot.h * TILE;

    ctx.fillStyle = '#08111f';
    ctx.fillRect(0, 0, worldW, worldH);

    const glow = ctx.createRadialGradient(
      worldW / 2, worldH / 2, 40,
      worldW / 2, worldH / 2, Math.max(worldW, worldH) / 1.6
    );
    glow.addColorStop(0, 'rgba(46, 230, 166, 0.05)');
    glow.addColorStop(1, 'rgba(8, 17, 31, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, worldW, worldH);

    ctx.strokeStyle = 'rgba(86, 148, 208, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= snapshot.w; x += 1) {
      const px = x * TILE;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, worldH);
    }
    for (let y = 0; y <= snapshot.h; y += 1) {
      const py = y * TILE;
      ctx.moveTo(0, py);
      ctx.lineTo(worldW, py);
    }
    ctx.stroke();
  }

  /**
   * 地图边界：清晰的红色警戒线 + 内侧危险带 + 地图外的危险斜纹。
   * 画在蛇之后，保证任何时候边界都不会被蛇身盖住。
   */
  function drawBoundary(ctx, snapshot, now, view, me) {
    const worldW = snapshot.w * TILE;
    const worldH = snapshot.h * TILE;

    // 1. 地图之外：压暗 + 斜纹，一眼就能看出哪里是"外面"
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    ctx.rect(0, 0, worldW, worldH);
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(2, 4, 9, 0.94)';
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    ctx.strokeStyle = 'rgba(255, 92, 122, 0.13)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    const span = view.y1 - view.y0;
    for (let x = view.x0 - span; x < view.x1 + span; x += 28) {
      ctx.moveTo(x, view.y0);
      ctx.lineTo(x + span, view.y1);
    }
    ctx.stroke();
    ctx.restore();

    // 2. 内侧危险带：越靠近边界越红，玩家贴近时整体变亮
    let danger = 0;
    if (me && me.alive && me.body.length >= 2) {
      const near = Math.min(
        me.body[0],
        me.body[1],
        snapshot.w - 1 - me.body[0],
        snapshot.h - 1 - me.body[1]
      );
      danger = clamp(1 - near / 5, 0, 1);
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / 340);
    const band = TILE * 1.8;
    const bandAlpha = 0.05 + 0.16 * danger + 0.03 * pulse;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, worldW, worldH);
    ctx.clip();

    const top = ctx.createLinearGradient(0, 0, 0, band);
    top.addColorStop(0, `rgba(255, 92, 122, ${bandAlpha})`);
    top.addColorStop(1, 'rgba(255, 92, 122, 0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, worldW, band);

    const bottom = ctx.createLinearGradient(0, worldH, 0, worldH - band);
    bottom.addColorStop(0, `rgba(255, 92, 122, ${bandAlpha})`);
    bottom.addColorStop(1, 'rgba(255, 92, 122, 0)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, worldH - band, worldW, band);

    const left = ctx.createLinearGradient(0, 0, band, 0);
    left.addColorStop(0, `rgba(255, 92, 122, ${bandAlpha})`);
    left.addColorStop(1, 'rgba(255, 92, 122, 0)');
    ctx.fillStyle = left;
    ctx.fillRect(0, 0, band, worldH);

    const right = ctx.createLinearGradient(worldW, 0, worldW - band, 0);
    right.addColorStop(0, `rgba(255, 92, 122, ${bandAlpha})`);
    right.addColorStop(1, 'rgba(255, 92, 122, 0)');
    ctx.fillStyle = right;
    ctx.fillRect(worldW - band, 0, band, worldH);

    ctx.restore();

    // 3. 边界线本体：用两层描边做发光（比 shadowBlur 便宜很多，弱显卡也不掉帧）
    const lineAlpha = clamp(0.62 + 0.28 * danger + 0.1 * pulse, 0, 1);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 92, 122, ${0.14 + 0.16 * danger})`;
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, worldW - 12, worldH - 12);
    ctx.strokeStyle = `rgba(255, 116, 143, ${lineAlpha})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, worldW - 3, worldH - 3);
    ctx.restore();

    // 4. 四角亮色护角，进一步强化"这里是边界"的观感
    const corner = Math.min(TILE * 2, worldW / 4, worldH / 4);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 209, 102, ${0.55 + 0.3 * pulse})`;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(2, 2 + corner);
    ctx.lineTo(2, 2);
    ctx.lineTo(2 + corner, 2);
    ctx.moveTo(worldW - 2 - corner, 2);
    ctx.lineTo(worldW - 2, 2);
    ctx.lineTo(worldW - 2, 2 + corner);
    ctx.moveTo(worldW - 2, worldH - 2 - corner);
    ctx.lineTo(worldW - 2, worldH - 2);
    ctx.lineTo(worldW - 2 - corner, worldH - 2);
    ctx.moveTo(2 + corner, worldH - 2);
    ctx.lineTo(2, worldH - 2);
    ctx.lineTo(2, worldH - 2 - corner);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 屏幕边缘的贴边预警（屏幕坐标，不跟随镜头）。
   * 镜头跟随时真正的边界线常常在屏幕外，只画世界里的那条线，玩家根本看不到墙；
   * 所以按"距离最近的边界还有几格"在对应屏幕边缘画出红色渐变 + 一条实线。
   */
  function drawBoundaryWarn(ctx, snapshot, now, me, width, height) {
    if (!me || !me.alive || me.body.length < 2) return;
    const headX = me.body[0];
    const headY = me.body[1];
    const gaps = {
      left: headX,
      right: snapshot.w - 1 - headX,
      top: headY,
      bottom: snapshot.h - 1 - headY,
    };

    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    const band = Math.max(80, Math.min(width, height) * 0.14);

    ctx.save();
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const cells = gaps[side];
      if (cells > WALL_WARN_CELLS) continue;
      const strength = clamp(1 - cells / WALL_WARN_CELLS, 0, 1);
      // 渐变要轻，只做提示；糊太重会把贴边的蛇本身染红，看着像"蛇消失了"
      const alpha = 0.04 + 0.18 * strength * (0.7 + 0.3 * pulse);

      let gradient;
      if (side === 'left') gradient = ctx.createLinearGradient(0, 0, band, 0);
      else if (side === 'right') gradient = ctx.createLinearGradient(width, 0, width - band, 0);
      else if (side === 'top') gradient = ctx.createLinearGradient(0, 0, 0, band);
      else gradient = ctx.createLinearGradient(0, height, 0, height - band);
      gradient.addColorStop(0, `rgba(255, 92, 122, ${alpha})`);
      gradient.addColorStop(1, 'rgba(255, 92, 122, 0)');

      ctx.fillStyle = gradient;
      if (side === 'left') ctx.fillRect(0, 0, band, height);
      else if (side === 'right') ctx.fillRect(width - band, 0, band, height);
      else if (side === 'top') ctx.fillRect(0, 0, width, band);
      else ctx.fillRect(0, height - band, width, band);

      // 紧贴屏幕边缘的一条实线，作为"前方就是墙"的硬提示
      ctx.fillStyle = `rgba(255, 116, 143, ${0.45 + 0.45 * strength})`;
      if (side === 'left') ctx.fillRect(0, 0, 5, height);
      else if (side === 'right') ctx.fillRect(width - 5, 0, 5, height);
      else if (side === 'top') ctx.fillRect(0, 0, width, 5);
      else ctx.fillRect(0, height - 5, width, 5);
    }
    ctx.restore();
  }

  function drawFood(ctx, food, now, view) {
    const x = food[0];
    const y = food[1];
    const gold = food[2] === 1;
    const cx = (x + 0.5) * TILE;
    const cy = (y + 0.5) * TILE;
    // 屏幕外的食物不必画（带发光阴影的圆很费性能，会影响帧率）
    if (cx < view.x0 - TILE || cy < view.y0 - TILE || cx > view.x1 + TILE || cy > view.y1 + TILE) return;
    const phase = now / 260 + x * 0.9 + y * 1.3;
    const scale = 0.9 + 0.14 * Math.sin(phase);
    const radius = (gold ? 0.34 : 0.22) * TILE * scale;

    ctx.save();
    ctx.shadowColor = gold ? 'rgba(255, 209, 102, 0.9)' : 'rgba(46, 230, 166, 0.85)';
    ctx.shadowBlur = gold ? 18 : 10;
    ctx.fillStyle = gold ? '#ffd166' : '#2ee6a6';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (gold) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(cx - radius * 0.3, cy - radius * 0.35, radius * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSnake(ctx, snake, bodyNow, view) {
    if (!bodyNow || bodyNow.length < 2) return;
    const total = bodyNow.length / 2;
    const isMe = snake.id === state.myId;
    const lightBase = isMe ? 62 : 56;
    const radius = TILE * (isMe ? 0.47 : 0.45);

    // 注意：此处坐标是世界坐标，必须跟"可视世界范围"比较，
    // 不能跟屏幕尺寸比较，否则蛇一走到地图右下角就会被整段剔除（消失/闪动）。
    const points = [];
    for (let i = total - 1; i >= 0; i -= 1) {
      const px = (bodyNow[i * 2] + 0.5) * TILE;
      const py = (bodyNow[i * 2 + 1] + 0.5) * TILE;
      if (px < view.x0 - TILE || py < view.y0 - TILE || px > view.x1 + TILE || py > view.y1 + TILE) {
        points.push(null);
        continue;
      }
      points.push({ x: px, y: py, index: i });
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const point of points) {
      if (!point) continue;
      const ratio = point.index / Math.max(1, total - 1);
      const light = lightBase - ratio * 24;
      ctx.fillStyle = `hsl(${snake.color} ${snake.s}% ${Math.max(20, light)}%)`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const point of points) {
      if (!point || point.index > 1) continue;
      const ratio = point.index;
      const light = lightBase - ratio * 24;
      ctx.fillStyle = `hsla(${snake.color} ${snake.s}% ${Math.min(80, light + 12)}% / 0.55)`;
      ctx.beginPath();
      ctx.arc(point.x - radius * 0.28, point.y - radius * 0.34, radius * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }

    const head = points[points.length - 1];
    if (head) {
      let dx = 1;
      let dy = 0;
      if (total > 1) {
        // 用插值后的头部与颈部方向，转向时朝向也连续
        dx = bodyNow[0] - bodyNow[2];
        dy = bodyNow[1] - bodyNow[3];
        const length = Math.hypot(dx, dy);
        if (length > 0.01) {
          dx /= length;
          dy /= length;
        } else {
          dx = 1;
          dy = 0;
        }
      }

      if (isMe) {
        ctx.shadowColor = `hsla(${snake.color} 100% 60% / 0.9)`;
        ctx.shadowBlur = 18;
      }
      ctx.fillStyle = `hsl(${snake.color} ${snake.s}% ${Math.min(72, lightBase + 6)}%)`;
      ctx.beginPath();
      ctx.arc(head.x, head.y, radius + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      const eyeOffset = radius * 0.42;
      const forward = radius * 0.28;
      const perpendicularX = -dy;
      const perpendicularY = dx;
      for (const side of [-1, 1]) {
        const ex = head.x + dx * forward + perpendicularX * eyeOffset * side;
        const ey = head.y + dy * forward + perpendicularY * eyeOffset * side;
        ctx.fillStyle = '#f8ffff';
        ctx.beginPath();
        ctx.arc(ex, ey, radius * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#08131f';
        ctx.beginPath();
        ctx.arc(ex + dx * radius * 0.13, ey + dy * radius * 0.13, radius * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }

      const label = isMe ? `${snake.name}（你）` : snake.name;
      ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(3, 8, 15, 0.85)';
      ctx.strokeText(label, head.x, head.y - TILE * 0.95);
      ctx.fillStyle = isMe ? '#eafff7' : 'rgba(206, 224, 245, 0.82)';
      ctx.fillText(label, head.x, head.y - TILE * 0.95);
    }

    ctx.restore();
  }

  function drawMinimap(snapshot, now) {
    const canvas = els.minimap;
    const g = state.minimapCtx;
    if (!g) return;
    const width = canvas.width;
    const height = canvas.height;
    const scaleX = width / snapshot.w;
    const scaleY = height / snapshot.h;

    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(5, 10, 18, 0.88)';
    g.fillRect(0, 0, width, height);

    g.strokeStyle = 'rgba(86, 148, 208, 0.16)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 10; x < width; x += 10) {
      g.moveTo(x, 0);
      g.lineTo(x, height);
    }
    for (let y = 10; y < height; y += 10) {
      g.moveTo(0, y);
      g.lineTo(width, y);
    }
    g.stroke();

    g.fillStyle = 'rgba(46, 230, 166, 0.5)';
    for (const food of snapshot.foods) {
      g.fillRect(food[0] * scaleX, food[1] * scaleY, 1.6, 1.6);
    }

    for (const snake of snapshot.snakes) {
      if (!snake.alive || snake.body.length < 2) continue;
      const isMe = snake.id === state.myId;
      g.fillStyle = isMe ? '#ffffff' : `hsl(${snake.color} ${snake.s}% ${Math.min(72, snake.l + 8)}%)`;
      for (let i = 0; i < snake.body.length; i += 2) {
        g.fillRect(
          snake.body[i] * scaleX - 1,
          snake.body[i + 1] * scaleY - 1,
          isMe ? 3 : 2.2,
          isMe ? 3 : 2.2
        );
      }
    }

    // 小地图边界与主画面保持一致的红色警戒色
    g.strokeStyle = 'rgba(255, 116, 143, 0.75)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, width - 2, height - 2);
  }

  function startRenderLoop() {
    const loop = (now) => {
      window.requestAnimationFrame(loop);
      try {
        render(now);
      } catch (err) {
        console.error('[render]', err);
      }
    };
    window.requestAnimationFrame(loop);
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    state.ctx = els.canvas.getContext('2d');
    state.minimapCtx = els.minimap.getContext('2d');
    bindAuth();
    bindGame();
    setAuthMode('login');
    loadHistory();
    startRenderLoop();

    if (state.token) {
      tryAutoLogin();
    } else {
      els.username.focus();
    }
  }

  init();
})();