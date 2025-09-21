// packages/battle-server/src/socket/socketHandlers.js
// 소켓 이벤트 집결 처리 (클라이언트 호환 유지)
// - 기존 로직/룰/디자인 변경 없이 브로드캐스트/룸 조인 체계만 보강
// - 신/구 이벤트명 동시 지원 (BroadcastManager 연계)

import { makeBattleHandlers } from '../engine/battle-handlers.js';
import BroadcastManager, { init as initBroadcastManager } from './broadcastManager.js';

export function makeSocketHandlers(io, { battles }) {
  // 전파 관리자 (신/구 이벤트 동시 송신자)
  const bm = initBroadcastManager(io, { verbose: false });

  // 엔진 핸들러 (전투/행동 로직)
  const h = makeBattleHandlers({ battles, io, broadcast: bm });

  io.on('connection', (socket) => {
    let currentBattle = null;
    let currentPlayerId = null;
    let displayName = '익명';
    let joinedTeamAB = null;
    let joinedRole = null;

    function roomEmit(ev, data) {
      if (!currentBattle) return;
      io.to(currentBattle).emit(ev, data);
    }

    // ===== 방 입장 =====
    // role/team/name/otp 등은 선택(호환)
    socket.on('join', ({ battleId, role, team, name, otp }) => {
      if (!battleId) return;
      const bid = String(battleId);
      const snap = battles.snapshot(bid);
      if (!snap) return;

      currentBattle = bid;
      joinedRole = role || joinedRole || null;
      joinedTeamAB = team || joinedTeamAB || null;
      if (name) displayName = String(name);

      // 기본 룸 + 역할/팀 룸 조인(있을 때)
      socket.join(currentBattle);
      bm.joinSocketToRooms(socket, currentBattle, joinedRole, joinedTeamAB, { withRoleRooms: true });

      // 스냅샷 즉시 송신 (신/구 이벤트 동시)
      socket.emit('battleUpdate', snap);
      socket.emit('battle:update', snap);

      // 입장 로그 (신/구)
      bm.log(currentBattle, { type: 'info', message: '관람 입장' });
      roomEmit('battleLog',  { ts: Date.now(), type: 'info', message: '관람 입장' });
      roomEmit('battle:log', { ts: Date.now(), type: 'info', message: '관람 입장' });
    });

    // ===== 플레이어 인증 =====
    // token/otp/name(폴백) 허용. 인증 성공시 플레이어 룸/팀 룸 자동 조인
    socket.on('playerAuth', ({ battleId, token, password, otp, playerName }, cb) => {
      const bid = String(battleId || currentBattle || '');
      if (!bid) {
        socket.emit('authError', { error: 'no battle' });
        return cb?.({ ok: false, error: 'no battle' });
      }

      const snap = battles.get(bid);
      if (!snap) {
        socket.emit('authError', { error: 'not found' });
        return cb?.({ ok: false, error: 'not found' });
      }

      // Player token 우선
      let p = null;
      if (token) p = battles.authByToken?.(bid, token);

      // 이름 매칭(폴백) — 관리자가 링크 없이 입장 시 사용
      if (!p && playerName) {
        p = snap.players.find(x => x.name === playerName) || null;
      }

      if (!p) {
        socket.emit('authError', { error: 'auth failed' });
        return cb?.({ ok: false, error: 'auth failed' });
      }

      currentBattle = bid;
      currentPlayerId = p.id;
      displayName = p.name;
      joinedRole = 'player';
      joinedTeamAB = p.team;

      socket.join(currentBattle);
      bm.joinSocketToRooms(socket, currentBattle, 'player', p.team, { withRoleRooms: true });

      // 성공 알림(신/구)
      socket.emit('authSuccess',  { ok: true, playerId: p.id, name: p.name, team: p.team });
      socket.emit('auth:success', { ok: true, playerId: p.id, name: p.name, team: p.team });
      cb?.({ ok: true, playerId: p.id, name: p.name, team: p.team });

      // 시스템 채팅으로도 공지
      h.sendChat(currentBattle, { name: '시스템', message: `${p.name} 입장` });
    });

    // ===== 준비 완료 =====
    socket.on('player:ready', (payload, cb) => {
      if (!currentBattle || !currentPlayerId) { return cb?.({ ok: false }); }
      try {
        h.markReady(currentBattle, currentPlayerId);
        cb?.({ ok: true });
      } catch {
        cb?.({ ok: false });
      }
    });

    // ===== 플레이어 행동 =====
    // payload 예: { type:'attack'|'defend'|'dodge'|'item'|'pass', item?, targetId? }
    socket.on('player:action', (payload, cb) => {
      if (!currentBattle || !currentPlayerId) {
        cb?.({ ok: false, error: 'no battle or player' });
        return;
      }
      try {
        h.playerAction(currentBattle, currentPlayerId, payload || {});
        cb?.({ ok: true });
      } catch (e) {
        socket.emit('actionError', { error: String(e?.message || e) });
        cb?.({ ok: false, error: String(e?.message || e) });
      }
    });

    // ===== 전투 제어(관리자) =====
    socket.on('createBattle', ({ mode }, cb = () => {}) => {
      try {
        const id = h.createBattle(mode || '1v1');
        cb({ ok: true, battleId: id, battle: battles.snapshot(id) });
      } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
    });

    socket.on('startBattle', ({ battleId }, cb = () => {}) => {
      try {
        h.startBattle(battleId || currentBattle);
        cb({ ok: true });
      } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
    });

    // 일시정지/재개는 엔진에 구현되어 있으면 위임, 아니면 호환 콜백만
    socket.on('pauseBattle', ({ battleId }, cb = () => {}) => {
      try {
        if (typeof h.pauseBattle === 'function') {
          h.pauseBattle(battleId || currentBattle);
        }
        cb({ ok: true });
      } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
    });

    socket.on('resumeBattle', ({ battleId }, cb = () => {}) => {
      try {
        if (typeof h.resumeBattle === 'function') {
          h.resumeBattle(battleId || currentBattle);
        }
        cb({ ok: true });
      } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
    });

    socket.on('endBattle', ({ battleId }, cb = () => {}) => {
      try {
        battles.end(battleId || currentBattle);
        cb({ ok: true });
      } catch (e) { cb({ ok: false, error: String(e?.message || e) }); }
    });

    // ===== 채팅 =====
    // 서버는 한 이벤트(chatMessage)만 받아서 브로드캐스트(신/구 모두 발행)
    socket.on('chatMessage', (payload = {}, cb) => {
      if (!currentBattle) { return cb?.({ ok: false }); }
      const data = {
        name: payload?.name || displayName || '익명',
        message: String(payload?.message || '').slice(0, 500)
      };
      h.sendChat(currentBattle, data);
      cb?.({ ok: true });
    });

    // ===== 응원(관전자) =====
    // 관전자 응원은 채팅에 [응원] 접두어로 미러링
    socket.on('spectator:cheer', ({ message, name }, cb) => {
      if (!currentBattle) { return cb?.({ ok: false }); }
      const m = String(message || '').trim();
      if (!m) { return cb?.({ ok: false }); }
      h.sendCheerToChat(currentBattle, name || displayName, m);
      cb?.({ ok: true });
    });

    // 구 이벤트를 받으면 신 이벤트 경로로 중계 (자기에코 대신 전체 방송)
    socket.on('cheerMessage', ({ message, name }, cb) => {
      if (!currentBattle) { return cb?.({ ok: false }); }
      const m = String(message || '').trim();
      if (!m) { return cb?.({ ok: false }); }
      h.sendCheerToChat(currentBattle, name || displayName, m);
      cb?.({ ok: true });
    });

    // ===== 연결 종료 =====
    socket.on('disconnect', () => {
      // 룸 정리는 소켓IO가 처리. 별도 상태 변경 없음.
      // 필요시 bm.leaveSocketFromRooms(socket, currentBattle, joinedRole, joinedTeamAB);
    });
  });
}

export default makeSocketHandlers;
