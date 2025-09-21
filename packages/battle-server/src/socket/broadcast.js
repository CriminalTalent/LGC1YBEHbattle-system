// packages/battle-server/src/socket/broadcast.js
// Unified broadcaster: emits both legacy and new event names for compatibility.

export default class BroadcastManager {
  constructor(io) {
    this.io = io;
  }

  // ---- room helpers --------------------------------------------------------
  _rooms(battle) {
    const id = typeof battle === 'string' ? battle : battle?.id;
    const key = String(id || '');
    // Support multiple room naming schemes for backward compatibility
    return [`battle-${key}`, key, id];
  }

  _emitRooms(rooms, evt, payload) {
    if (!this.io || !rooms) return;
    rooms.forEach((r) => this.io.to(r).emit(evt, payload));
  }

  // ---- sanitizers ----------------------------------------------------------
  _sanitizePlayer(p) {
    return {
      id: p.id,
      team: p.team,
      name: p.name,
      avatar: p.avatar || '/uploads/avatars/default.svg',
      hp: p.hp,
      maxHp: p.maxHp,
      stats: p.stats,
      items: p.items,
      ready: !!p.ready,
    };
  }

  _sanitizeBattle(b) {
    if (!b) return {};
    const timeLeftSec = Math.max(
      0,
      Math.floor(((b.turnDeadline || 0) - Date.now()) / 1000)
    );

    return {
      id: b.id,
      mode: b.mode,
      status: b.status,
      players: (b.players || []).map((p) => this._sanitizePlayer(p)),
      currentTurn: {
        turnNumber: b.turnNumber,
        currentTeam: b.currentTeam,
        currentPlayer: b.currentPlayer
          ? {
              id: b.currentPlayer.id,
              name: b.currentPlayer.name,
              avatar: b.currentPlayer.avatar,
              team: b.currentPlayer.team,
            }
          : null,
        timeLeftSec,
      },
    };
  }

  // ---- generic battle snapshot --------------------------------------------
  broadcastBattleUpdate(battle, opts = {}) {
    const payload = this._sanitizeBattle(battle);
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'battleUpdate', payload);
    this._emitRooms(rooms, 'battle:update', payload);
    if (opts.immediate) {
      // no-op (kept for API parity)
    }
  }

  // ---- logs ---------------------------------------------------------------
  broadcastSystemLog(battleOrId, log) {
    const rooms = this._rooms(battleOrId);
    const payload = normalizeLog(log);
    this._emitRooms(rooms, 'battleLog', payload);
    this._emitRooms(rooms, 'battle:log', payload);
  }

  broadcastCombatLog(battleOrId, logs) {
    const rooms = this._rooms(battleOrId);
    (logs || []).forEach((l) => {
      const payload = normalizeLog(l);
      this._emitRooms(rooms, 'battleLog', payload);
      this._emitRooms(rooms, 'battle:log', payload);
    });
  }

  broadcastImportantLog(battleOrId, message) {
    const rooms = this._rooms(battleOrId);
    const payload = normalizeLog({ type: 'notice', message });
    this._emitRooms(rooms, 'importantLog', payload);
    this._emitRooms(rooms, 'battle:log', payload);
  }

  // ---- action results ------------------------------------------------------
  broadcastActionResult(battle, action, result) {
    const payload = { type: 'action_result', action, ...result };
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'battle_update', payload);
    this._emitRooms(rooms, 'actionSuccess', payload);
    this._emitRooms(rooms, 'player:action:success', payload);
  }

  // ---- phase/turn/round lifecycle -----------------------------------------
  broadcastPhaseChange(battle, phase, meta = {}) {
    const rooms = this._rooms(battle);
    const payload = { phase, ...meta };
    this._emitRooms(rooms, 'phase_change', payload);
    this._emitRooms(rooms, 'phase:start', payload);
  }

  broadcastPhaseComplete(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'phase_complete', payload);
    this._emitRooms(rooms, 'phase:end', payload);
  }

  broadcastTurnStart(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'turn_start', payload);
    this._emitRooms(rooms, 'turn:start', payload);
  }

  broadcastTurnEnd(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'turn_end', payload);
    this._emitRooms(rooms, 'turn:end', payload);
  }

  broadcastRoundStart(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'round_start', payload);
    this._emitRooms(rooms, 'round:start', payload);
  }

  broadcastRoundEnd(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'round_end', payload);
    this._emitRooms(rooms, 'round:end', payload);
  }

  // ---- per-selection progress (선공/후공 개별 선택 중계) --------------------
  // Emits granular selection updates while teams are choosing targets/actions.
  // Clients can listen to any of these aliases.
  broadcastSelectionUpdate(battle, payload) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'selection:update', payload);
    this._emitRooms(rooms, 'battle:selection', payload);
    this._emitRooms(rooms, 'select:update', payload);
  }

  // ---- timer ticks (used by admin/spectator UIs) ---------------------------
  // Emits multiple aliases: 'timer:tick', 'battle:tick', 'countdown', 'tick'
  broadcastTimerTick(battle, secondsLeft, meta = {}) {
    const rooms = this._rooms(battle);
    const payload = {
      secondsLeft,
      sec: secondsLeft,
      timeLeftSec: secondsLeft,
      remain: secondsLeft,
      ...meta,
    };
    this._emitRooms(rooms, 'timer:tick', payload);
    this._emitRooms(rooms, 'battle:tick', payload);
    this._emitRooms(rooms, 'countdown', payload);
    this._emitRooms(rooms, 'tick', payload);
  }

  // ---- start/end -----------------------------------------------------------
  broadcastBattleStart(battle, initiative) {
    const payload = { type: 'battle_start', initiative };
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'battle_start', payload);
    this._emitRooms(rooms, 'battle:started', payload);
    this._emitRooms(rooms, 'battleStarted', payload);
  }

  broadcastBattleEnd(battle, endData) {
    const rooms = this._rooms(battle);
    this._emitRooms(rooms, 'battle_end', endData);
    this._emitRooms(rooms, 'battle:ended', endData);
  }

  // ---- chat/cheer ----------------------------------------------------------
  broadcastChat(battleOrId, data) {
    const rooms = this._rooms(battleOrId);
    this._emitRooms(rooms, 'chatMessage', data);
    this._emitRooms(rooms, 'battle:chat', data);
  }

  broadcastCheer(battleOrId, data) {
    const rooms = this._rooms(battleOrId);
    const payload = { ...data };
    this._emitRooms(rooms, 'cheerMessage', payload);
    this._emitRooms(rooms, 'spectator:cheer', payload);
    // Also mirror as chat with [응원] prefix for UIs that only read chat
    const name = payload.name || payload.spectatorName || '익명';
    this.broadcastChat(battleOrId, {
      name,
      message: `[응원] ${payload.message || payload.cheer || ''}`.trim(),
    });
  }

  // ---- misc ---------------------------------------------------------------
  broadcastSpectatorCount(battleOrId, count) {
    const rooms = this._rooms(battleOrId);
    this._emitRooms(rooms, 'spectator_count', { count });
  }
}

// Named exports (functional style) for convenience/legacy imports
export const broadcastChat = (io, battleId, data) => {
  const mgr = new BroadcastManager(io);
  mgr.broadcastChat(battleId, data);
};

export const broadcastSpectatorCount = (io, battleId, count) => {
  const mgr = new BroadcastManager(io);
  mgr.broadcastSpectatorCount(battleId, count);
};

export const broadcastCheer = (io, battleId, data) => {
  const mgr = new BroadcastManager(io);
  mgr.broadcastCheer(battleId, data);
};

export const broadcastTimerTick = (io, battleId, secondsLeft, meta = {}) => {
  const mgr = new BroadcastManager(io);
  mgr.broadcastTimerTick(battleId, secondsLeft, meta);
};

// ---- helpers ---------------------------------------------------------------
function normalizeLog(input) {
  if (!input) return { ts: Date.now(), type: 'system', message: '' };
  if (typeof input === 'string') {
    return { ts: Date.now(), type: 'system', message: input };
    }
  return {
    ts: input.ts || input.timestamp || Date.now(),
    type: input.type || input.level || 'system',
    message: input.message || input.text || '',
  };
}
