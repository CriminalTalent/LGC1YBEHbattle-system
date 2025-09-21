// packages/battle-server/src/api/index.js
// PYXIS API Routes - ESM Enhanced Design Version
// - 기존 룰/디자인/이벤트 명세는 유지
// - 관리자/플레이어 페이지에서 기대하는 모든 HTTP 경로(폴백 포함) 제공
// - 업로드/링크/플레이어 추가/삭제/전투 제어/헬스체크 일원화
// - BroadcastManager(io)를 app.set('broadcast', ...) 으로 주입하면 자동 브로드캐스트

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/* ─────────────────────────────────────────────
 * 공용 스토어 확보 (없으면 생성)
 * ───────────────────────────────────────────── */
function ensureStores(app) {
  if (!app.get('battles')) app.set('battles', new Map());
  if (!app.get('passwordStore')) app.set('passwordStore', new Map());
  return {
    battles: app.get('battles'),
    pw: app.get('passwordStore'),
    broadcast: app.get('broadcast') || null, // 선택
  };
}

/* ─────────────────────────────────────────────
 * 로깅/응답 유틸
 * ───────────────────────────────────────────── */
function logWithTimestamp(message, level = 'INFO', data = null) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}][API][${level}] ${message}`;
  if (level === 'ERROR') console.error(logMessage, data || '');
  else if (level === 'WARN') console.warn(logMessage, data || '');
  else console.log(logMessage, data || '');
}
function sendSuccess(res, data = {}, message = null) {
  const response = { ok: true, timestamp: Date.now(), ...data };
  if (message) response.message = message;
  res.json(response);
}
function sendError(res, statusCode, error, details = null) {
  const response = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  if (details && process.env.NODE_ENV === 'development') response.details = details;
  res.status(statusCode).json(response);
}
function validateRequired(data, fields) {
  const missing = [];
  fields.forEach((field) => {
    if (data[field] == null || (typeof data[field] === 'string' && !data[field].trim())) {
      missing.push(field);
    }
  });
  if (missing.length > 0) throw new Error(`필수 필드 누락: ${missing.join(', ')}`);
}
function sanitizeString(str, maxLength = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLength);
}

/* ─────────────────────────────────────────────
 * 미들웨어
 * ───────────────────────────────────────────── */
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 요청 로깅
router.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  res.send = function (data) {
    const duration = Date.now() - start;
    logWithTimestamp(`${req.method} ${req.originalUrl || req.url} - ${res.statusCode} (${duration}ms)`,
      res.statusCode >= 400 ? 'WARN' : 'INFO');
    return originalSend.call(this, data);
  };
  next();
});

// Rate limiting
const createRateLimit = (windowMs, max, message) =>
  rateLimit({ windowMs, max, message: { ok: false, error: message }, standardHeaders: true, legacyHeaders: false });

const battleCreationLimit = createRateLimit(60_000, 5, '전투 생성 요청이 너무 많습니다.');
const generalLimit = createRateLimit(60_000, 120, 'API 요청이 너무 많습니다.');
const uploadLimit = createRateLimit(60_000, 20, '파일 업로드 요청이 너무 많습니다.');

/* ─────────────────────────────────────────────
 * 헬퍼: ID/OTP/링크 생성
 * ───────────────────────────────────────────── */
const genId = (pfx = 'battle_') => `${pfx}${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const genOTP = (len = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function normalizeItems(items) {
  // 클라이언트가 쓰는 키 혼용 지원: attackBooster|attack_boost, defenseBooster|defense_boost, dittany|ditany
  const src = items || {};
  const dittany = Number.isInteger(src.dittany) ? src.dittany
                : Number.isInteger(src.ditany) ? src.ditany : 0;
  const attackBooster = Number.isInteger(src.attackBooster) ? src.attackBooster
                      : Number.isInteger(src.attack_boost) ? src.attack_boost : 0;
  const defenseBooster = Number.isInteger(src.defenseBooster) ? src.defenseBooster
                       : Number.isInteger(src.defense_boost) ? src.defense_boost : 0;
  return {
    dittany: clamp(dittany, 0, 9),
    attackBooster: clamp(attackBooster, 0, 9),
    defenseBooster: clamp(defenseBooster, 0, 9),
  };
}
function normalizeStats(stats) {
  const { attack = 1, defense = 1, agility = 1, luck = 1 } = stats || {};
  const check = (v) => (Number.isInteger(v) ? clamp(v, 1, 5) : 1);
  return { attack: check(attack), defense: check(defense), agility: check(agility), luck: check(luck) };
}

function buildLinks(battle, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const spectator = {
    otp: battle.spectatorOtp,
    url: base ? `${base}/spectator?battle=${encodeURIComponent(battle.id)}&otp=${encodeURIComponent(battle.spectatorOtp)}` : undefined,
  };
  const playerLinks = (battle.players || []).map((p) => ({
    id: p.id,
    playerId: p.id,
    playerName: p.name,
    team: p.team,
    otp: p.token,
    token: p.token,
    url: base
      ? `${base}/player?battle=${encodeURIComponent(battle.id)}&playerId=${encodeURIComponent(p.id)}&token=${encodeURIComponent(p.token)}`
      : undefined,
  }));
  return { spectator, playerLinks };
}

/* ─────────────────────────────────────────────
 * 업로드 (공용): /api/upload/avatar (+ 하위 호환 라우트)
 * ───────────────────────────────────────────── */
const avatarDir = path.join(__dirname, '../../public/uploads/avatars');
fs.mkdirSync(avatarDir, { recursive: true });

function validateImageFile(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.mimetype)) throw new Error('지원되지 않는 파일 형식입니다');
  if (file.size > 5 * 1024 * 1024) throw new Error('파일 크기가 너무 큽니다(최대 5MB)');
}
function safeAvatarName(originalName) {
  const ext = (path.extname(originalName) || '.png').toLowerCase();
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    try { validateImageFile(file); cb(null, safeAvatarName(file.originalname)); }
    catch (e) { cb(e); }
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function avatarUploadHandler(req, res) {
  try {
    if (!req.file) throw new Error('업로드된 파일이 없습니다');
    const rel = `/uploads/avatars/${req.file.filename}`;
    sendSuccess(res, { url: rel }, '이미지 업로드 성공');
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    sendError(res, 400, err);
  }
}
router.post('/upload/avatar', uploadLimit, upload.single('avatar'), avatarUploadHandler);
// 하위 호환 경로 (기존 구현들과의 호환)
router.post('/battles/:battleId/avatar', uploadLimit, upload.single('avatar'), avatarUploadHandler);

/* ─────────────────────────────────────────────
 * 전투 생성
 * ───────────────────────────────────────────── */
router.post('/battles', battleCreationLimit, (req, res) => {
  try {
    const { battles, pw } = ensureStores(req.app);
    const { mode, options = {} } = req.body || {};

    const validModes = ['1v1', '2v2', '3v3', '4v4'];
    const battleMode = validModes.includes(mode) ? mode : '2v2';

    const battleId = genId('battle_');
    const spectatorOtp = genOTP(8);

    const battle = {
      id: battleId,
      mode: battleMode,
      status: 'waiting',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      players: [],
      // UI/엔진 호환 필드(있는 경우 그대로 사용됨)
      turnNumber: 1,
      currentTurn: {
        turnNumber: 0,
        currentTeam: null,
        currentPlayer: null,
        timeLeftSec: 0,
      },
      currentPlayer: null,
      currentTeam: null,
      effects: [],
      logs: [],
      spectatorOtp,
      options: {
        // 기본 총 시간/턴 시간(초 → ms). 팀 제한시간 5분(=300초)은 엔진에서 관리.
        timeLimit: Number(options.timeLimit || 3600) * 1000,
        turnTimeLimit: Number(options.turnTimeLimit || 300) * 1000,
        maxSpectators: clamp(Number(options.maxSpectators || 50), 1, 200),
      },
    };

    battles.set(battleId, battle);

    // 관리자 OTP (선택)
    const adminOtp = genOTP(8);
    pw.set(`admin_${battleId}`, {
      password: adminOtp, battleId, role: 'admin', expires: Date.now() + 60 * 60 * 1000,
    });

    sendSuccess(
      res,
      {
        id: battleId,
        battleId,
        battle,
        adminOtp,
        spectatorOtp,
        urls: {
          admin: `/admin?battle=${battleId}&otp=${adminOtp}`,
          spectator: `/spectator?battle=${battleId}&otp=${spectatorOtp}`,
          status: `/api/battles/${battleId}`,
        },
      },
      '전투가 성공적으로 생성되었습니다.',
    );
  } catch (err) {
    logWithTimestamp('전투 생성 실패', 'ERROR', err);
    sendError(res, 500, err);
  }
});

/* ─────────────────────────────────────────────
 * 플레이어 추가 (여러 경로 호환)
 * ───────────────────────────────────────────── */
function addPlayerImpl(battles, broadcast, battleId, body) {
  const battle = battles.get(battleId);
  if (!battle) throw new Error('전투를 찾을 수 없습니다');

  const name = sanitizeString(body?.player?.name ?? body?.name, 40);
  const team = (body?.player?.team ?? body?.team) === 'B' ? 'B' : 'A';
  if (!name) throw new Error('이름을 입력하세요');

  const p = {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    name,
    team,
    hp: Number(body?.player?.hp ?? body?.hp ?? 100),
    maxHp: Number(body?.player?.maxHp ?? body?.maxHp ?? 100),
    stats: normalizeStats(body?.player?.stats ?? body?.stats),
    items: normalizeItems(body?.player?.items ?? body?.items),
    avatar: sanitizeString(body?.player?.avatar ?? body?.avatar ?? '/uploads/avatars/default.svg', 300),
    ready: false,
    stance: 'n
