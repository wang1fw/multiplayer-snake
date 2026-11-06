'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
const NAME_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/;

const users = new Map();
const sessions = new Map();
let saveTimer = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[auth] 读取 ${path.basename(file)} 失败：${err.message}`);
    }
    return fallback;
  }
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function persistNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    ensureDataDir();
    writeFileAtomic(USERS_FILE, JSON.stringify([...users.values()], null, 2));
    const sessionList = [...sessions.entries()].map(([token, item]) => ({ token, ...item }));
    writeFileAtomic(SESSIONS_FILE, JSON.stringify(sessionList, null, 2));
  } catch (err) {
    console.error(`[auth] 数据持久化失败：${err.message}`);
  }
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 150);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function normalizeName(name) {
  return String(name == null ? '' : name).trim();
}

function keyOf(name) {
  return normalizeName(name).toLowerCase();
}

function validate(name, password) {
  if (!NAME_PATTERN.test(name)) {
    return '用户名需为 2-16 位的中文、字母、数字、下划线或短横线';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return '密码长度需为 6-64 位';
  }
  return null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function publicUser(user) {
  return {
    username: user.username,
    bestScore: user.bestScore,
    bestLength: user.bestLength,
    games: user.games,
    createdAt: user.createdAt,
  };
}

function register(name, password) {
  const username = normalizeName(name);
  const invalid = validate(username, password);
  if (invalid) return { ok: false, error: invalid };

  const key = keyOf(username);
  if (users.has(key)) return { ok: false, error: '该用户名已被注册' };

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    username,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    bestScore: 0,
    bestLength: 0,
    games: 0,
    totalScore: 0,
  };
  users.set(key, user);
  persist();
  return { ok: true, user: publicUser(user) };
}

function login(name, password) {
  const key = keyOf(name);
  const user = users.get(key);
  if (!user) return { ok: false, error: '用户名或密码错误' };
  if (typeof password !== 'string') return { ok: false, error: '用户名或密码错误' };
  const hash = hashPassword(password, user.salt);
  if (!safeEqualHex(hash, user.hash)) return { ok: false, error: '用户名或密码错误' };
  return { ok: true, user: publicUser(user) };
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  persist();
  return token;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    persist();
    return null;
  }
  return session.username;
}

function revokeToken(token) {
  if (token && sessions.delete(token)) persist();
}

function getProfile(username) {
  const user = users.get(keyOf(username));
  return user ? publicUser(user) : null;
}

function recordGame(username, score, length) {
  const user = users.get(keyOf(username));
  if (!user) return;
  user.games += 1;
  user.totalScore += Math.max(0, Number(score) || 0);
  if (score > user.bestScore) user.bestScore = score;
  if (length > user.bestLength) user.bestLength = length;
  persist();
}

function getTopUsers(limit = 10) {
  return [...users.values()]
    .filter((user) => user.bestScore > 0)
    .sort((a, b) => b.bestScore - a.bestScore || b.bestLength - a.bestLength)
    .slice(0, limit)
    .map((user, index) => ({
      rank: index + 1,
      username: user.username,
      bestScore: user.bestScore,
      bestLength: user.bestLength,
      games: user.games,
    }));
}

function cleanupSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) persist();
}

function init() {
  ensureDataDir();
  const storedUsers = loadJson(USERS_FILE, []);
  if (Array.isArray(storedUsers)) {
    for (const user of storedUsers) {
      if (!user || !user.username || !user.hash || !user.salt) continue;
      users.set(keyOf(user.username), {
        username: user.username,
        salt: user.salt,
        hash: user.hash,
        createdAt: user.createdAt || Date.now(),
        bestScore: Number(user.bestScore) || 0,
        bestLength: Number(user.bestLength) || 0,
        games: Number(user.games) || 0,
        totalScore: Number(user.totalScore) || 0,
      });
    }
  }

  const storedSessions = loadJson(SESSIONS_FILE, []);
  if (Array.isArray(storedSessions)) {
    const now = Date.now();
    for (const item of storedSessions) {
      if (!item || !item.token || !item.username) continue;
      if (!(item.expiresAt > now)) continue;
      sessions.set(item.token, {
        username: item.username,
        createdAt: item.createdAt || now,
        expiresAt: item.expiresAt,
      });
    }
  }

  cleanupSessions();
  setInterval(cleanupSessions, 60 * 60 * 1000).unref?.();
}

init();

module.exports = {
  register,
  login,
  createSession,
  verifyToken,
  revokeToken,
  getProfile,
  recordGame,
  getTopUsers,
  normalizeName,
  keyOf,
};