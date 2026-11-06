'use strict';

const TICK_MS = 130;
const WORLD_WIDTH = 80;
const WORLD_HEIGHT = 50;
const INITIAL_LENGTH = 5;
const SPAWN_CLEARANCE = 10;
const SPAWN_HOLD_MS = 30000;
const MAX_FOOD = 70;
const RESPAWN_DELAY_MS = 2200;
const NORMAL_SCORE = 10;
const GOLD_SCORE = 30;
const GOLD_CHANCE = 0.08;
const MAX_PENDING_DIRS = 2;

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const COLORS = [
  { h: 152, s: 76, l: 55 },
  { h: 190, s: 90, l: 58 },
  { h: 265, s: 80, l: 66 },
  { h: 330, s: 82, l: 62 },
  { h: 28, s: 92, l: 58 },
  { h: 52, s: 94, l: 56 },
  { h: 210, s: 90, l: 62 },
  { h: 0, s: 78, l: 62 },
];

function cellKey(x, y) {
  return `${x},${y}`;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

class SnakeGame {
  constructor() {
    this.snakes = new Map();
    this.foods = new Map();
    this.deaths = [];
    this.tick = 0;
    this._colorCursor = 0;
    for (let i = 0; i < MAX_FOOD; i += 1) this._spawnFood();
  }

  get playerCount() {
    return this.snakes.size;
  }

  get aliveCount() {
    let count = 0;
    for (const snake of this.snakes.values()) if (snake.alive) count += 1;
    return count;
  }

  /* ---------------- 玩家管理 ---------------- */

  /**
   * @param {{ waitForInput?: boolean }} [options]
   *   waitForInput 为 true 时，新出生的蛇停在原地等待玩家第一次操作，
   *   避免玩家刚进游戏还没看清画面就一路撞到墙上出局。
   */
  addPlayer(id, name, options = {}) {
    const spawn = this._findSpawn();
    const color = COLORS[this._colorCursor % COLORS.length];
    const waitForInput = options.waitForInput === true;
    this._colorCursor += 1;
    const snake = {
      id,
      name,
      color: color.h,
      colorS: color.s,
      colorL: color.l,
      alive: true,
      holdForInput: waitForInput,
      awaitingStart: waitForInput,
      holdUntil: Date.now() + SPAWN_HOLD_MS,
      body: spawn.body,
      dir: spawn.dir,
      pendingDirs: [],
      grow: 0,
      score: 0,
      kills: 0,
      eaten: 0,
      bestLength: spawn.body.length,
      spawnAt: Date.now(),
      respawnAt: 0,
      deathReason: null,
      killerName: null,
    };
    this.snakes.set(id, snake);
    return this.publicSnake(snake);
  }

  removePlayer(id) {
    const snake = this.snakes.get(id);
    if (!snake) return;
    if (snake.alive) this._dropFoodFromSnake(snake);
    this.snakes.delete(id);
  }

  setDirection(id, dirName) {
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return;
    const dir = DIRECTIONS[dirName];
    if (!dir) return;
    // 还没起步的蛇：第一次操作直接决定起步方向（含原地掉头），随后开始移动
    if (snake.awaitingStart) {
      this._startMoving(snake, dir);
      return;
    }
    if (snake.pendingDirs.length >= MAX_PENDING_DIRS) return;
    const last = snake.pendingDirs.length > 0
      ? snake.pendingDirs[snake.pendingDirs.length - 1]
      : snake.dir;
    if (last.x + dir.x === 0 && last.y + dir.y === 0) return;
    if (last.x === dir.x && last.y === dir.y) return;
    snake.pendingDirs.push(dir);
  }

  respawn(id) {
    const snake = this.snakes.get(id);
    if (!snake || snake.alive) return false;
    if (Date.now() < snake.respawnAt) return false;
    const spawn = this._findSpawn();
    snake.alive = true;
    snake.awaitingStart = snake.holdForInput === true;
    snake.holdUntil = Date.now() + SPAWN_HOLD_MS;
    snake.body = spawn.body;
    snake.dir = spawn.dir;
    snake.pendingDirs = [];
    snake.grow = 0;
    snake.score = 0;
    snake.kills = 0;
    snake.eaten = 0;
    snake.bestLength = spawn.body.length;
    snake.spawnAt = Date.now();
    snake.respawnAt = 0;
    snake.deathReason = null;
    snake.killerName = null;
    return true;
  }

  /* ---------------- 游戏推进 ---------------- */

  update() {
    this.tick += 1;
    this.deaths = [];

    const alive = [...this.snakes.values()].filter((snake) => snake.alive);
    if (alive.length === 0) {
      this._refillFood();
      return this.deaths;
    }

    // 等待玩家第一次操作的蛇停在原地，本 tick 不参与移动，因此不会撞墙或撞身体
    const movers = this._collectMovers(alive);
    if (movers.length === 0) {
      this._refillFood();
      return this.deaths;
    }

    const occupancy = new Map();
    for (const snake of alive) {
      // 停在原地的蛇尾巴不会移开，所以整条身体都算占位；移动中的蛇则排除将要腾空的尾格
      const lastIndex = snake.awaitingStart ? snake.body.length - 1 : snake.body.length - 2;
      for (let i = 0; i <= lastIndex; i += 1) {
        const cell = snake.body[i];
        occupancy.set(cellKey(cell.x, cell.y), snake.id);
      }
    }

    const nextHeads = new Map();
    for (const snake of movers) {
      while (snake.pendingDirs.length > 0) {
        const candidate = snake.pendingDirs.shift();
        if (candidate.x + snake.dir.x === 0 && candidate.y + snake.dir.y === 0) continue;
        snake.dir = candidate;
        break;
      }
      const head = snake.body[0];
      nextHeads.set(snake.id, { x: head.x + snake.dir.x, y: head.y + snake.dir.y });
    }

    const headUsage = new Map();
    for (const head of nextHeads.values()) {
      const key = cellKey(head.x, head.y);
      headUsage.set(key, (headUsage.get(key) || 0) + 1);
    }

    const dying = [];
    for (const snake of movers) {
      const head = nextHeads.get(snake.id);
      const key = cellKey(head.x, head.y);
      let reason = null;
      let killerId = null;

      if (head.x < 0 || head.y < 0 || head.x >= WORLD_WIDTH || head.y >= WORLD_HEIGHT) {
        reason = 'wall';
      } else if (occupancy.has(key)) {
        killerId = occupancy.get(key);
        reason = killerId === snake.id ? 'self' : 'body';
      } else if ((headUsage.get(key) || 0) > 1) {
        reason = 'head';
      }

      if (reason) {
        snake.alive = false;
        snake.deathReason = reason;
        snake.respawnAt = Date.now() + RESPAWN_DELAY_MS;
        const killer = killerId && killerId !== snake.id ? this.snakes.get(killerId) : null;
        snake.killerName = killer ? killer.name : null;
        if (killer && killer.alive) killer.kills += 1;
        dying.push(snake);
      }
    }

    for (const snake of movers) {
      if (!snake.alive) continue;
      const head = nextHeads.get(snake.id);
      const key = cellKey(head.x, head.y);
      const food = this.foods.get(key);

      snake.body.unshift(head);

      if (food) {
        this.foods.delete(key);
        const growth = food.type === 'gold' ? 3 : 1;
        snake.grow += growth - 1;
        snake.score += food.type === 'gold' ? GOLD_SCORE : NORMAL_SCORE;
        snake.eaten += 1;
      }

      if (snake.grow > 0) {
        snake.grow -= 1;
      } else if (!food) {
        snake.body.pop();
      }

      if (snake.body.length > snake.bestLength) snake.bestLength = snake.body.length;
    }

    for (const snake of dying) {
      this._dropFoodFromSnake(snake);
      this.deaths.push({
        id: snake.id,
        name: snake.name,
        score: snake.score,
        length: snake.bestLength,
        reason: snake.deathReason,
        killer: snake.killerName,
      });
    }

    this._refillFood();
    return this.deaths;
  }

  /* ---------------- 快照 ---------------- */

  serialize() {
    const snakes = [];
    for (const snake of this.snakes.values()) {
      const flat = new Array(snake.body.length * 2);
      for (let i = 0; i < snake.body.length; i += 1) {
        flat[i * 2] = snake.body[i].x;
        flat[i * 2 + 1] = snake.body[i].y;
      }
      snakes.push({
        id: snake.id,
        name: snake.name,
        color: snake.color,
        s: snake.colorS,
        l: snake.colorL,
        body: flat,
        score: snake.score,
        kills: snake.kills,
        len: snake.body.length,
        alive: snake.alive ? 1 : 0,
        waiting: snake.alive && snake.awaitingStart ? 1 : 0,
        respawnIn: snake.alive ? 0 : Math.max(0, snake.respawnAt - Date.now()),
      });
    }

    const foods = [];
    for (const food of this.foods.values()) {
      foods.push([food.x, food.y, food.type === 'gold' ? 1 : 0]);
    }

    return {
      tick: this.tick,
      w: WORLD_WIDTH,
      h: WORLD_HEIGHT,
      snakes,
      foods,
      leaderboard: this.leaderboard(),
      online: this.snakes.size,
    };
  }

  leaderboard(limit = 10) {
    return [...this.snakes.values()]
      .sort((a, b) => b.score - a.score || b.body.length - a.body.length || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((snake) => ({
        id: snake.id,
        name: snake.name,
        score: snake.score,
        length: snake.body.length,
        kills: snake.kills,
        alive: snake.alive ? 1 : 0,
      }));
  }

  publicSnake(snake) {
    return {
      id: snake.id,
      name: snake.name,
      color: snake.color,
      s: snake.colorS,
      l: snake.colorL,
    };
  }

  /* ---------------- 内部工具 ---------------- */

  // 挑出本 tick 真正会移动的蛇；等玩家第一次操作的蛇留在原地
  _collectMovers(alive) {
    const now = Date.now();
    const movers = [];
    for (const snake of alive) {
      if (snake.awaitingStart) {
        if (now < snake.holdUntil) continue;
        // 等待超时后自动起步，避免一直占着位置挡住其他玩家
        snake.awaitingStart = false;
      }
      movers.push(snake);
    }
    return movers;
  }

  /**
   * 玩家的第一次操作：直接以该方向起步。
   * 若方向与当前朝向相反，因为蛇还没移动过，可以原地把身体翻到身后，
   * 这样玩家按哪个方向都能正常起步，也不会一启动就咬到自己。
   */
  _startMoving(snake, dir) {
    const reversing = snake.dir.x + dir.x === 0 && snake.dir.y + dir.y === 0;
    if (reversing) {
      const head = snake.body[0];
      const body = [];
      for (let i = 0; i < snake.body.length; i += 1) {
        const cell = { x: head.x - dir.x * i, y: head.y - dir.y * i };
        if (this._isBlockedByOthers(cell.x, cell.y, snake.id)) return false;
        body.push(cell);
      }
      snake.body = body;
    }
    snake.dir = dir;
    snake.pendingDirs = [];
    snake.awaitingStart = false;
    return true;
  }

  _isOccupied(x, y) {
    if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) return true;
    if (this.foods.has(cellKey(x, y))) return true;
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      for (const cell of snake.body) {
        if (cell.x === x && cell.y === y) return true;
      }
    }
    return false;
  }

  _isBlockedByOthers(x, y, selfId) {
    if (x < 0 || y < 0 || x >= WORLD_WIDTH || y >= WORLD_HEIGHT) return true;
    for (const snake of this.snakes.values()) {
      if (!snake.alive || snake.id === selfId) continue;
      for (const cell of snake.body) {
        if (cell.x === x && cell.y === y) return true;
      }
    }
    return false;
  }

  // 从 (x, y) 沿 dir 连续可走的空格数，最多统计 limit 格
  _runway(x, y, dir, limit) {
    let steps = 0;
    while (steps < limit) {
      if (this._isOccupied(x + dir.x * (steps + 1), y + dir.y * (steps + 1))) break;
      steps += 1;
    }
    return steps;
  }

  // 在 (x, y) 生成一条朝右的蛇，并要求四周都留出足够的安全距离
  _buildSpawn(x, y) {
    const dir = DIRECTIONS.right;
    const body = [];
    for (let i = 0; i < INITIAL_LENGTH; i += 1) {
      const cell = { x: x - dir.x * i, y: y - dir.y * i };
      if (this._isOccupied(cell.x, cell.y)) return null;
      body.push(cell);
    }
    // 玩家可能按任意方向作为第一个操作，所以四个方向都要留出反应距离
    let clearance = SPAWN_CLEARANCE;
    for (const name of ['up', 'down', 'left', 'right']) {
      clearance = Math.min(clearance, this._runway(x, y, DIRECTIONS[name], SPAWN_CLEARANCE));
      if (clearance === 0) return null;
    }
    return { body, dir: { ...dir }, clearance };
  }

  _findSpawn() {
    let best = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const x = 4 + randomInt(Math.max(1, WORLD_WIDTH - 8));
      const y = 3 + randomInt(Math.max(1, WORLD_HEIGHT - 6));
      const candidate = this._buildSpawn(x, y);
      if (!candidate) continue;
      if (candidate.clearance >= SPAWN_CLEARANCE) return candidate;
      if (!best || candidate.clearance > best.clearance) best = candidate;
    }
    // 实在找不到完美位置时，退回安全距离最大的那个，尽量不让玩家一出生就撞死
    if (best) return best;
    return this._fallbackSpawn();
  }

  _fallbackSpawn() {
    const body = [{ x: INITIAL_LENGTH + 3, y: 5 }];
    for (let i = 1; i < INITIAL_LENGTH; i += 1) {
      body.push({ x: INITIAL_LENGTH + 3 - i, y: 5 });
    }
    return { body, dir: { ...DIRECTIONS.right }, clearance: 0 };
  }

  _spawnFood() {
    for (let guard = 0; guard < 300; guard += 1) {
      const x = randomInt(WORLD_WIDTH);
      const y = randomInt(WORLD_HEIGHT);
      const key = cellKey(x, y);
      if (this.foods.has(key)) continue;
      if (this._isOccupied(x, y)) continue;
      this.foods.set(key, {
        x,
        y,
        type: Math.random() < GOLD_CHANCE ? 'gold' : 'normal',
        bornAt: Date.now(),
      });
      return true;
    }
    return false;
  }

  _refillFood() {
    let guard = 0;
    while (this.foods.size < MAX_FOOD && guard < MAX_FOOD * 4) {
      if (!this._spawnFood()) break;
      guard += 1;
    }
  }

  _dropFoodFromSnake(snake) {
    const cells = snake.body.filter((_, index) => index % 2 === 0);
    for (const cell of cells) {
      const key = cellKey(cell.x, cell.y);
      if (this.foods.has(key)) continue;
      this.foods.set(key, {
        x: cell.x,
        y: cell.y,
        type: Math.random() < GOLD_CHANCE ? 'gold' : 'normal',
        bornAt: Date.now(),
      });
    }
  }
}

module.exports = {
  SnakeGame,
  TICK_MS,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  INITIAL_LENGTH,
  MAX_FOOD,
  RESPAWN_DELAY_MS,
  DIRECTIONS,
};