/* packages/battle-server/index.js (ESM) */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import multer from 'multer';
import { Server as IOServer } from 'socket.io';

/* ─────────────────────────── 기본 설정 ─────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  path: '/socket.io',
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] }
});

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: CORS_ORIGIN }));

/* ───────────────────── 정적 라우팅 + 별칭 (/admin 등) ───────────────────── */
const PUBLIC_DIR = path.resolve(__dirname, 'public');

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// 업로드 디렉토리 설정
const uploadsDir = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const avatarsDir = path.join(uploadsDir, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));

const send = file => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', send('admin.html'));
app.get('/admin', send('admin.html'));
app.get('/player', send('player.html'));
app.get('/spectator', send('spectator.html'));

/* ─────────────────────────── 공용 유틸 ─────────────────────────── */
const battles = new Map(); // id -> battle state (엔진 외 부가 보관용)
const passwordStore = new Map(); // 토큰/OTP 저장소

// BattleEngine 임포트
import { createBattleStore } from './src/engine/BattleEngine.js';
const battleEngine = createBattleStore();

/* ====== ★ 엔진 이벤트 훅 연결: 로그/업데이트를 소켓으로 브로드캐스트 ★ ====== */
function broadcastToRoom(battleId, event, data) {
  io.to(`battle_${battleId}`).emit(event, data);
}
function broadcastSnapshot(battleId) {
  const snap = battleEngine.snapshot(battleId);
  if (snap) {
    broadcastToRoom(battleId, 'battleUpdate', snap);
    broadcastToRoom(battleId, 'battle:update', snap);
  }
}
function broadcastLog(battleId, log) {
  broadcastToRoom(battleId, 'battle:log', log);
  broadcastToRoom(battleId, 'battleLog', log);
}

// 엔진 훅 등록
battleEngine.setLogger((battleId, log) => {
  broadcastLog(battleId, log);
});
battleEngine.setUpdate((battleId) => {
  broadcastSnapshot(battleId);
});

/* ─────────────────────────── 업로드 설정 ─────────────────────────── */
import multerPkg from 'multer';
const storage = multerPkg.diskStorage({
  destination: function (_req, _file, cb) { cb(null, avatarsDir); },
  filename: function (_req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, 'avatar-' + uniqueSuffix + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    if (file.mimetype?.startsWith('image/')) return cb(null, true);
    cb(new Error('이미지 파일만 업로드 가능합니다.'));
  }
});

/* ─────────────────────────── API 라우트 ─────────────────────────── */

// 헬스체크
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    battles: battleEngine.size ? battleEngine.size() : 0,
    uptime: process.uptime()
  });
});

// 아바타 업로드
const uploadRouter = express.Router();
uploadRouter.post('/avatar', upload.single('avatar'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '파일이 없습니다' });
    const url = `/uploads/avatars/${req.file.filename}`;
    res.json({ ok: true, url });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
uploadRouter.use((err, _req, res, _next) => {
  if (err instanceof Error) return res.status(400).json({ ok: false, error: err.message });
  res.status(500).json({ ok: false, error: '업로드 중 오류' });
});
app.use('/api/upload', uploadRouter);

// 전투 생성 (HTTP 폴백)
app.post('/api/battles', (req, res) => {
  try {
    const { mode = '2v2' } = req.body || {};
    const battle = battleEngine.create(mode);
    battles.set(battle.id, battle);
    res.json({ ok: true, battleId: battle.id, battle });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 링크 생성 함수
function buildLinks(battle, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');

  // 관전자 OTP 생성
  if (!battle.spectatorOtp) {
    battle.spectatorOtp = Math.random().toString(36).slice(2, 8).toUpperCase();
    passwordStore.set(`spectator_${battle.id}`, {
      otp: battle.spectatorOtp,
      expiresAt: Date.now() + 30 * 60 * 1000
    });
  }

  // 플레이어 토큰 생성
  (battle.players || []).forEach(player => {
    if (!player.token) {
      player.token = Math.random().toString(36).slice(2, 8).toUpperCase();
      passwordStore.set(`player_${battle.id}_${player.id}`, {
        token: player.token,
        expiresAt: Date.now() + 30 * 60 * 1000
      });
    }
  });

  const spectator = {
    otp: battle.spectatorOtp,
    url: base ? `${base}/spectator?battle=${encodeURIComponent(battle.id)}&otp=${encodeURIComponent(battle.spectatorOtp)}` : undefined
  };

  const players = (battle.players || []).map(p => ({
    id: p.id,
    playerId: p.id,
    name: p.name,
    playerName: p.name,
    team: p.team,
    otp: p.token,
    token: p.token,
    url: base ? `${base}/player?battle=${encodeURIComponent(battle.id)}&token=${encodeURIComponent(p.token)}` : undefined
  }));

  return { spectator, players, playerLinks: players };
}

// 링크 생성 (관리자용)
app.post('/api/admin/battles/:id/links', (req, res) => {
  try {
    const battle = battleEngine.get(req.params.id);
    if (!battle) return res.status(404).json({ ok: false, error: '전투를 찾을 수 없습니다' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const links = buildLinks(battle, baseUrl);
    res.json({ ok: true, links });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 링크 생성 (호환)
app.post('/api/battles/:id/links', (req, res) => {
  try {
    const battle = battleEngine.get(req.params.id);
    if (!battle) return res.status(404).json({ ok: false, error: '전투를 찾을 수 없습니다' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const links = buildLinks(battle, baseUrl);
    res.json({ ok: true, links });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ─────────────────────────── 소켓 핸들러 ─────────────────────────── */
io.on('connection', (socket) => {
  let currentBattle = null;
  let displayName = null;
  let joinedRole = null;

  // 방 입장
  socket.on('join', ({ battleId }) => {
    if (!battleId) return;
    const battle = battleEngine.get(battleId);
    if (!battle) {
      socket.emit('error', { message: '전투를 찾을 수 없습니다' });
      return;
    }
    currentBattle = battleId;
    socket.join(`battle_${battleId}`);

    // 현재 스냅샷 전달
    broadcastSnapshot(battleId);
  });

  // 전투 생성
  socket.on('createBattle', ({ mode = '2v2' }, callback = () => {}) => {
    try {
      const battle = battleEngine.create(mode);
      battles.set(battle.id, battle);
      currentBattle = battle.id;
      socket.join(`battle_${battle.id}`);
      broadcastSnapshot(battle.id);
      callback({ ok: true, battleId: battle.id });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  // 전투 제어
  socket.on('startBattle', ({ battleId }, callback = () => {}) => {
    const res = battleEngine.start(battleId);
    if (!res) return callback({ ok: false, error: '전투를 시작할 수 없습니다' });
    broadcastSnapshot(battleId);
    callback({ ok: true });
  });
  socket.on('pauseBattle', ({ battleId }, callback = () => {}) => {
    const b = battleEngine.get(battleId);
    if (!b) return callback({ ok: false, error: '전투를 찾을 수 없습니다' });
    b.status = 'paused';
    b.phase = 'idle';
    broadcastSnapshot(battleId);
    callback({ ok: true });
  });
  socket.on('resumeBattle', ({ battleId }, callback = () => {}) => {
    const b = battleEngine.get(battleId);
    if (!b) return callback({ ok: false, error: '전투를 찾을 수 없습니다' });
    b.status = 'active';
    broadcastSnapshot(battleId);
    callback({ ok: true });
  });
  socket.on('endBattle', ({ battleId }, callback = () => {}) => {
    const b = battleEngine.end(battleId);
    if (!b) return callback({ ok: false, error: '전투를 찾을 수 없습니다' });
    broadcastSnapshot(battleId);
    broadcastToRoom(battleId, 'battle:ended', { winner: 'Draw' });
    callback({ ok: true });
  });

  // 플레이어 CRUD
  socket.on('addPlayer', ({ battleId, player }, callback = () => {}) => {
    try {
      const added = battleEngine.addPlayer(battleId, player);
      if (!added) return callback({ ok: false, error: '플레이어 추가 실패' });
      broadcastSnapshot(battleId);
      callback({ ok: true, player: added });
    } catch (e) {
      callback({ ok: false, error: e.message });
    }
  });
  socket.on('deletePlayer', ({ battleId, playerId }, callback = () => {}) => {
    try {
      const ok = battleEngine.removePlayer(battleId, playerId);
      if (!ok) return callback({ ok: false, error: '플레이어 제거 실패' });
      broadcastSnapshot(battleId);
      callback({ ok: true });
    } catch (e) {
      callback({ ok: false, error: e.message });
    }
  });
  socket.on('removePlayer', ({ battleId, playerId }, cb = () => {}) => {
    const ok = battleEngine.removePlayer(battleId, playerId);
    if (!ok) return cb({ ok: false, error: '플레이어 제거 실패' });
    broadcastSnapshot(battleId);
    cb({ ok: true });
  });

  // 인증
  socket.on('playerAuth', ({ battleId, name, token }, callback) => {
    const battle = battleEngine.get(battleId);
    if (!battle) {
      socket.emit('authError', { error: 'not found' });
      return callback?.({ ok: false, error: 'not found' });
    }
    let player = null;
    if (token) player = battleEngine.authByToken(battleId, token);
    if (!player && name) player = battle.players.find(x => x.name === name) || null;
    if (!player) {
      socket.emit('authError', { error: 'auth failed' });
      return callback?.({ ok: false, error: 'auth failed' });
    }
    currentBattle = battleId;
    displayName = player.name;
    joinedRole = 'player';
    socket.join(`battle_${battleId}`);

    const payload = { ok: true, playerId: player.id, name: player.name, team: player.team, player };
    socket.emit('authSuccess', payload);
    socket.emit('auth:success', payload);
    callback?.(payload);

    broadcastSnapshot(battleId);
  });

  socket.on('spectatorAuth', ({ battleId, otp, name }, callback) => {
    const battle = battleEngine.get(battleId);
    if (!battle) return callback?.({ ok: false, error: 'not found' });
    const stored = passwordStore.get(`spectator_${battleId}`);
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
      return callback?.({ ok: false, error: 'invalid otp' });
    }
    currentBattle = battleId;
    displayName = name || '관전자';
    joinedRole = 'spectator';
    socket.join(`battle_${battleId}`);
    callback?.({ ok: true });
    broadcastSnapshot(battleId);
  });

  // 준비/액션
  socket.on('player:ready', ({ battleId, playerId }, callback = () => {}) => {
    const ok = battleEngine.markReady(battleId, playerId, true);
    broadcastSnapshot(battleId);
    callback({ ok });
  });
  socket.on('playerReady', ({ battleId, playerId, ready = true }, callback = () => {}) => {
    const ok = battleEngine.markReady(battleId, playerId, ready);
    broadcastSnapshot(battleId);
    callback({ ok });
  });

  socket.on('player:action', ({ battleId, playerId, action }, callback = () => {}) => {
    const res = battleEngine.playerAction(battleId, playerId, action);
    if (!res) {
      socket.emit('actionError', { error: '행동 처리 실패' });
      return callback({ ok: false, error: '행동 처리 실패' });
    }
    socket.emit('actionSuccess', { ok: true, result: res.result });
    socket.emit('player:action:success', { ok: true, result: res.result });
    broadcastSnapshot(battleId);
    callback({ ok: true, result: res.result });
  });

  // 채팅/응원은 그대로
  socket.on('chatMessage', ({ battleId, name, message }) => {
    if (!battleId || !message?.trim()) return;
    const chat = { ts: Date.now(), name: name || displayName || '익명', message: message.trim() };
    broadcastToRoom(battleId, 'chatMessage', chat);
    broadcastToRoom(battleId, 'battle:chat', chat);
  });
  socket.on('spectator:cheer', ({ battleId, message }) => {
    if (!battleId || !message?.trim()) return;
    const chat = { ts: Date.now(), name: displayName || '관전자', message: message.trim(), type: 'cheer' };
    broadcastToRoom(battleId, 'chatMessage', chat);
    broadcastToRoom(battleId, 'battle:chat', chat);
  });

  socket.on('disconnect', () => {
    // 방출 로그는 엔진에 의존하지 않고 생략(원하면 여기서도 chat/log 송출 가능)
  });
});

/* ─────────────────────────── 서버 시작 ─────────────────────────── */
server.listen(PORT, HOST, () => {
  console.log(`PYXIS Battle System up on http://${HOST}:${PORT}`);
});
