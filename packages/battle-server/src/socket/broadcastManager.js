// packages/battle-server/src/socket/broadcastManager.js
// BroadcastManager: 브로드캐스트 계층 캡슐화 (신/구 이벤트 동시 지원)
// - init(io) 후 인스턴스 메서드 사용
// - 상태/로그/채팅/턴/라운드/페이즈/선택/타이머/관전자 카운트 모두 신·구 이벤트명으로 송신
// - 기존 룰/디자인/이벤트 명칭 유지 + 누락된 별칭 보강

'use strict';

/** @typedef {import('socket.io').Server} IOServer */

class BroadcastManager {
  /** @param {IOServer} [io] */
  constructor(io) {
    this.io = io || null;
    this.isInitialized = !!io;
    this.options = {
      verbose: false,
      enableMetrics: false,
      batchEnabled: false
    };
    this.metrics = {
      messagesSent: 0,
      errors: 0,
      lastActivity: Date.now()
    };
  }

  /** @param {IOServer} io */
  init(io, options = {}) {
    if (io) this.io = io;
    if (!this.io) throw new Error('Socket.IO instance is required');

    this.options = { ...this.options, ...options };
    this.isInitialized = true;

    if (this.options.verbose) {
      console.log('[BroadcastManager] Initialized', this.options);
    }
  }

  // ---- room helpers --------------------------------------------------------
  room(battleId) {
    return String(battleId || '');
  }

  _ensureInitialized() {
    if (!this.isInitialized || !this.io) {
      throw new Error('BroadcastManager not initialized. Call init() first.');
    }
  }

  _incrementMetrics(type = 'message') {
    if (!this.options.enableMetrics) return;
    if (type === 'error') this.metrics.errors++;
    else this.metrics.messagesSent++;
    this.metrics.lastActivity = Date.now();
  }

  _safeEmit(roomId, event, data) {
    try {
      this._ensureInitialized();
      this.io.to(roomId).emit(event, data);
      this._incrementMetrics('message');
      return true;
    } catch (err) {
      console.error('[BroadcastManager] Emit error:', err);
      this._incrementMetrics('error');
      return false;
    }
  }

  // =============== 공통 송신기 ===============
  toAll(battleId, event, data) {
    if (!battleId || !event) return false;
    return this._safeEmit(this.room(battleId), event, data);
  }
  toTeam(battleId, teamKey, event, data) {
    if (!battleId || !teamKey || !event) return false;
    return this._safeEmit(`battle:${battleId}:${teamKey}`, event, data);
  }
  toRole(battleId, role, event, data) {
    if (!battleId || !role || !event) return false;
    return this._safeEmit(`battle:${battleId}:${role}`, event, data);
  }

  // =============== 룸 조인/이탈 ===============
  joinSocketToRooms(socket, battleId, role, teamAB, options = {}) {
    if (!socket || !battleId) return false;
    try {
      this._ensureInitialized();
      socket.join(this.room(battleId));
      if (options.withRoleRooms && role) socket.join(`battle:${battleId}:${role}`);
      if (teamAB) socket.join(`battle:${battleId}:${teamAB}`);
      return true;
    } catch (e) {
      console.error('[BroadcastManager] joinSocketToRooms error:', e);
      return false;
    }
  }
  leaveSocketFromRooms(socket, battleId, role, teamAB) {
    if (!socket || !battleId) return false;
    try {
      this._ensureInitialized();
      socket.leave(this.room(battleId));
      if (role) socket.leave(`battle:${battleId}:${role}`);
      if (teamAB) socket.leave(`battle:${battleId}:${teamAB}`);
      return true;
    } catch (e) {
      console.error('[BroadcastManager] leaveSocketFromRooms error:', e);
      return false;
    }
  }

  // =============== 상태 스냅샷 ===============
  /**
   * 전투 상태 전체 브로드캐스트
   * - 신: "battle:update"
   * - 구: "battleUpdate"
   * 클라이언트 호환을 위해 currentTurn/timeLeftSec 포함
   */
  state(battle, extra = {}) {
    if (!battle?.id) return false;

    const players = Array.isArray(battle.players) ? battle.players : [];
    const logs = Array.isArray(battle.log) ? battle.log : [];

    // timeLeftSec 계산 (turnDeadline/turnEndsAt 둘 다 호환)
    const now = Date.now();
    const deadline = Number(battle.turnDeadline ?? battle.turnEndsAt ?? 0) || 0;
    const timeLeftSec = Math.max(0, Math.floor((deadline - now) / 1000));

    const currentPlayer = battle.currentPlayer || battle.turn?.currentPlayer || null;
    const currentTeam = battle.currentTeam ?? battle.turn?.currentTeam ?? null;
    const turnNumber = battle.turnNumber ?? battle.turn?.turnNumber ?? battle.round ?? 1;

    const payload = {
      id: battle.id,
      mode: battle.mode,
      status: battle.status || 'waiting',

      // 엔진형 구조(있는 경우 그대로 유지)
      turn: battle.turn,

      // 레거시/호환 필드
      currentTurn: {
        turnNumber,
        currentTeam,
        currentPlayer: currentPlayer
          ? {
              id: currentPlayer.id,
              name: currentPlayer.name,
              avatar: currentPlayer.avatar,
              team: currentPlayer.team
            }
          : null,
        timeLeftSec
      },

      current: battle.current ?? null,
      startedAt: battle.startedAt ?? null,
      endedAt: battle.endedAt ?? null,
      turnEndsAt: deadline || null,

      players: players
        .map(p => ({
          id: p?.id || '',
          name: p?.name || '',
          team: p?.team || '',
          hp: Number(p?.hp || 0),
          maxHp: Number(p?.maxHp || p?.hp || 0),
          ready: !!p?.ready,
          avatar: p?.avatar || p?.avatarUrl || '/uploads/avatars/default.svg',
          stats: p?.stats || {},
          items: p?.items || {}
        }))
        .filter(p => p.id),

      // 마지막 로그 일부(관리/디버깅용)
      log: logs.slice(-200),

      ...extra
    };

    const roomId = this.room(battle.id);
    const a = this._safeEmit(roomId, 'battle:update', payload);
    const b = this._safeEmit(roomId, 'battleUpdate', payload);
    return a && b;
  }

  // 관리자 델타(meta) 전용
  admin(battleId, data) {
    if (!battleId) return false;
