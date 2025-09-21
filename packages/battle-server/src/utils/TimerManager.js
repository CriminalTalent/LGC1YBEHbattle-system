// packages/battle-server/src/utils/TimerManager.js
// PYXIS Timer Manager - Enhanced Design Version (ESM)
// 정밀한 시간 관리, 이벤트 시스템, 상태 추적, 자동 백업(옵션), pause/resume 정확도 개선
// 팀 턴(5분) 규정 지원: 팀 페이즈 타이머 + 미행동 자동 패스

'use strict';

import { EventEmitter } from 'node:events';

class TimerManager extends EventEmitter {
  /**
   * @param {string} battleId
   * @param {object} callbacks
   * @param {object} options
   */
  constructor(battleId, callbacks = {}, options = {}) {
    super();

    this.battleId = battleId;

    // 콜백(필요한 것만 넣어도 됨)
    this.callbacks = {
      onBattleEnd: callbacks.onBattleEnd || (() => {}),
      onPlayerTimeout: callbacks.onPlayerTimeout || (() => {}),      // 미행동 플레이어 자동 패스 등
      onTurnWarning: callbacks.onTurnWarning || (() => {}),          // 개별 플레이어 경고
      onBattleWarning: callbacks.onBattleWarning || (() => {}),      // 전투 시간 경고
      onTeamPhaseTimeout: callbacks.onTeamPhaseTimeout || (() => {}),// 팀 턴 전체 만료
      onAutoPass: callbacks.onAutoPass || (() => {}),                // 개별 자동 패스 트리거(선택)
      onTeamPhaseComplete: callbacks.onTeamPhaseComplete || null,    // 팀 페이즈 모든 인원 행동 완료
      onAutoSave: callbacks.onAutoSave || null,                      // (state) => {}
      ...callbacks,
    };

    // 설정
    this.config = {
      battleDuration: 60 * 60 * 1000,   // 전투 총 시간(필요 시)
      playerTurnTimeout: 5 * 60 * 1000, // 규정: 팀 턴 제한 5분. 팀 페이즈 기본값으로도 사용
      warningThreshold: 0.8,            // 80% 경과 시 1회 경고
      warningPercents: [],              // 추가 경고 지점(예: [0.5, 0.9])
      tickInterval: 1000,               // 1초마다 tick
      enableWarnings: true,
      enableAutoSave: true,
      autoSaveIntervalMs: 30 * 1000,    // 30초마다 자동 백업 이벤트
      precision: 'millisecond',         // 'second' | 'millisecond'
      unrefTimers: true,                // 타임아웃/인터벌이 종료를 막지 않도록
      ...options,
    };

    // ── Battle 타이머 상태 (deadline 기반)
    this._battle = {
      startAt: null,
      endAt: null,
      deadlineAt: null,
      paused: false,
      pauseStartedAt: null,
      remainingAtPauseMs: 0,
      totalPlannedMs: null,
      warnedPercents: new Set(),
      timer: null,
    };

    // ── Team Phase(팀 턴) 타이머 상태
    // 규정: 팀 단위 턴 5분, 초과 시 미행동 플레이어 자동 패스
    this._teamPhase = {
      active: false,
      teamKey: null,           // 호출측 규칙에 맞게 사용 (예: 'A'|'B' 또는 'phoenix'|'eaters')
      startAt: null,
      deadlineAt: null,
      totalMs: 0,
      timer: null,
      pendingPlayers: new Set(), // 아직 행동하지 않은 playerId 집합
      warned: false,
    };

    // ── Player 개별 타이머 상태 (선택 사용)
    // timerInfo: { startAt, deadlineAt, totalMs, warned, timer }
    this.playerTimers = new Map();

    // 호환용: pause된 타이머 저장
    // pausedTimers: playerId -> { remaining, duration, warned }
    this.pausedTimers = new Map();

    // 통계
    this.stats = {
      battleTimeouts: 0,
      playerTimeouts: 0,
      teamPhaseTimeouts: 0,
      warningsIssued: 0,
      pauseCount: 0,
      totalPausedTime: 0,
    };

    // 틱/오토세이브 인터벌
    this.tickTimer = null;
    this.autoSaveTimer = null;
    if (this.config.tickInterval > 0) this._startTicker();
    if (this.config.enableAutoSave && this.callbacks.onAutoSave) this._startAutoSave();

    this.log('TimerManager 초기화 완료', 'INFO', { battleId, config: this.config });
  }

  // ─────────────────────────────────────────────
  // 로깅/유틸
  // ─────────────────────────────────────────────

  log(message, level = 'INFO', data = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}][TimerManager][${this.battleId}][${level}] ${message}`;
    if (level === 'ERROR') console.error(line, data || '');
    else if (level === 'WARN') console.warn(line, data || '');
    else console.log(line, data || '');
    this.emit('log', { message, level, data, timestamp, battleId: this.battleId });
  }

  _now() {
    return Date.now();
  }

  _applyPrecision(ms) {
    if (this.config.precision === 'second') {
      return Math.max(0, Math.round(ms / 1000) * 1000);
    }
    return Math.max(0, ms);
  }

  _setTimeout(handler, ms) {
    const t = setTimeout(handler, ms);
    if (this.config.unrefTimers && t?.unref) t.unref();
    return t;
  }

  _setInterval(handler, ms) {
    const t = setInterval(handler, ms);
    if (this.config.unrefTimers && t?.unref) t.unref();
    return t;
  }

  // ─────────────────────────────────────────────
  // Ticker / AutoSave
  // ─────────────────────────────────────────────

  _startTicker() {
    if (this.tickTimer) return;
    this.tickTimer = this._setInterval(() => this._tick(), this.config.tickInterval);
  }

  _stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  _startAutoSave() {
    if (this.autoSaveTimer || !this.callbacks.onAutoSave) return;
    this.autoSaveTimer = this._setInterval(() => {
      try {
        const state = this.exportState();
        this.callbacks.onAutoSave(state);
        this.emit('autosave', { battleId: this.battleId, state });
      } catch (err) {
        this.log('자동 백업(onAutoSave) 오류', 'ERROR', err);
      }
    }, this.config.autoSaveIntervalMs);
  }

  _stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  _tick() {
    const now = this._now();

    // 전투 틱
    if (this.isBattleActive() && !this.isBattlePaused()) {
      const remaining = this.getBattleRemainingTime();
      const elapsed = this.getBattleElapsedTime();
      const total = this._battle.totalPlannedMs || this.config.battleDuration;

      if (this.config.enableWarnings && total > 0 && remaining > 0) {
        const progress = elapsed / total;
        const marks = [this.config.warningThreshold, ...(this.config.warningPercents || [])]
          .filter((x) => typeof x === 'number' && x > 0 && x < 1);
        for (const p of marks) {
          if (progress >= p && !this._battle.warnedPercents.has(p)) {
            this._battle.warnedPercents.add(p);
            this._issueBattleWarning(remaining, p);
          }
        }
      }

      this.emit('tick', {
        type: 'battle',
        elapsed: this._applyPrecision(elapsed),
        remaining: this._applyPrecision(remaining),
        progress: total ? Math.min(1, elapsed / total) : 0,
      });
    }

    // 팀 페이즈 틱
    if (this._teamPhase.active) {
      const remaining = Math.max(0, (this._teamPhase.deadlineAt || now) - now);
      const elapsed = Math.max(0, (this._teamPhase.totalMs || 0) - remaining);
      const total = this._teamPhase.totalMs || 0;

      if (this.config.enableWarnings && !this._teamPhase.warned && total > 0) {
        const progress = elapsed / total;
        if (progress >= this.config.warningThreshold) {
          this._teamPhase.warned = true;
          this.emit('teamPhase:warning', {
            teamKey: this._teamPhase.teamKey,
            remaining: this._applyPrecision(remaining),
          });
        }
      }

      this.emit('tick', {
        type: 'team',
        teamKey: this._teamPhase.teamKey,
        elapsed: this._applyPrecision(elapsed),
        remaining: this._applyPrecision(remaining),
        progress: total ? Math.min(1, elapsed / total) : 0,
        pendingCount: this._teamPhase.pendingPlayers.size,
      });
    }

    // 플레이어 틱
    for (const [playerId, info] of this.playerTimers.entries()) {
      if (!info.startAt || !info.deadlineAt) continue;
      const remaining = info.deadlineAt - now;
      const elapsed = info.totalMs - Math.max(0, remaining);
      const progress = info.totalMs ? Math.min(1, elapsed / info.totalMs) : 0;

      if (this.config.enableWarnings && remaining > 0 && !info.warned) {
        if (progress >= this.config.warningThreshold) {
          this._issuePlayerWarning(playerId, remaining);
          info.warned = true;
        }
      }

      this.emit('tick', {
        type: 'player',
        playerId,
        elapsed: this._applyPrecision(elapsed),
        remaining: this._applyPrecision(Math.max(0, remaining)),
        progress,
      });
    }
  }

  // ─────────────────────────────────────────────
  // 전투 타이머
  // ─────────────────────────────────────────────

  startBattleTimer(duration = null) {
    const d = typeof duration === 'number' && duration > 0 ? duration : this.config.battleDuration;
    this._clearBattleTimeout();

    const now = this._now();
    this._battle.startAt = now;
    this._battle.endAt = null;
    this._battle.deadlineAt = now + d;
    this._battle.paused = false;
    this._battle.pauseStartedAt = null;
    this._battle.remainingAtPauseMs = 0;
    this._battle.totalPlannedMs = d;
    this._battle.warnedPercents = new Set();

    this._battle.timer = this._setTimeout(() => this._handleBattleTimeout(), d);

    this.log('전투 타이머 시작', 'INFO', {
      duration: d,
      endsAt: new Date(this._battle.deadlineAt).toISOString(),
    });

    this.emit('battleTimer:started', {
      duration: d,
      startTime: this._battle.startAt,
      endsAt: this._battle.deadlineAt,
    });

    return this._battle.startAt;
  }

  _clearBattleTimeout() {
    if (this._battle?.timer) {
      clearTimeout(this._battle.timer);
      this._battle.timer = null;
    }
  }

  clearBattleTimer() {
    this._clearBattleTimeout();
    if (this._battle.startAt && !this._battle.endAt) {
      this._battle.endAt = this._now();
    }
    this.log('전투 타이머 정리', 'INFO');
  }

  pauseBattleTimer() {
    if (!this.isBattleActive() || this.isBattlePaused()) return false;

    const now = this._now();
    const remaining = this.getBattleRemainingTime();

    this._battle.paused = true;
    this._battle.pauseStartedAt = now;
    this._battle.remainingAtPauseMs = remaining;

    this._clearBattleTimeout();

    this.stats.pauseCount += 1;

    this.log('전투 타이머 일시정지', 'INFO', { remaining });
    this.emit('battleTimer:paused', { pausedAt: now, remaining });

    return true;
  }

  resumeBattleTimer() {
    if (!this.isBattlePaused()) return false;

    const now = this._now();
    const pausedDuration = now - (this._battle.pauseStartedAt || now);
    this.stats.totalPausedTime += pausedDuration;

    const remaining = Math.max(0, this._battle.remainingAtPauseMs || 0);
    this._battle.deadlineAt = now + remaining;

    this._battle.paused = false;
    this._battle.pauseStartedAt = null;
    this._battle.remainingAtPauseMs = 0;
    this._battle.endAt = null;

    if (remaining > 0) {
      this._battle.timer = this._setTimeout(() => this._handleBattleTimeout(), remaining);
    }

    this.log('전투 타이머 재개', 'INFO', {
      pausedDuration,
      remaining,
      totalPausedTime: this.stats.totalPausedTime,
    });

    this.emit('battleTimer:resumed', {
      pausedDuration,
      remaining,
      totalPausedTime: this.stats.totalPausedTime,
    });

    return true;
  }

  _handleBattleTimeout() {
    this._battle.endAt = this._now();
    this.stats.battleTimeouts += 1;

    this.log('전투 시간 만료', 'WARN', {
      duration: this.getBattleElapsedTime(),
    });

    this.emit('battleTimer:timeout', {
      battleId: this.battleId,
      duration: this.getBattleElapsedTime(),
    });

    try {
      this.callbacks.onBattleEnd(this.battleId, 'timeout');
    } catch (err) {
      this.log('전투 종료 콜백 오류', 'ERROR', err);
    }
  }

  _issueBattleWarning(remaining, atPercent) {
    this.stats.warningsIssued += 1;
    this.log('전투 시간 경고', 'WARN', { remaining, atPercent });

    this.emit('battleTimer:warning', {
      battleId: this.battleId,
      remaining,
      percentage: atPercent * 100,
    });

    try {
      this.callbacks.onBattleWarning(this.battleId, remaining);
    } catch (err) {
      this.log('전투 경고 콜백 오류', 'ERROR', err);
    }
  }

  // ─────────────────────────────────────────────
  // 팀 페이즈(팀 턴) 타이머 — 규정 대응
  // ─────────────────────────────────────────────

  /**
   * 팀 페이즈 시작
   * @param {string} teamKey
   * @param {string[]} pendingPlayerIds
   * @param {number|null} durationMs
   */
  startTeamPhase(teamKey, pendingPlayerIds = [], durationMs = null) {
    const total =
      typeof durationMs === 'number' && durationMs > 0
        ? durationMs
        : this.config.playerTurnTimeout;

    this.clearTeamPhase(); // 기존 팀 페이즈 정리

    const now = this._now();
    this._teamPhase.active = true;
    this._teamPhase.teamKey = teamKey || null;
    this._teamPhase.startAt = now;
    this._teamPhase.totalMs = total;
    this._teamPhase.deadlineAt = now + total;
    this._teamPhase.pendingPlayers = new Set(
      Array.isArray(pendingPlayerIds) ? pendingPlayerIds : []
    );
    this._teamPhase.warned = false;

    // 모든 인원이 이미 행동 완료 상태라면 즉시 완료 처리
    if (this._teamPhase.pendingPlayers.size === 0) {
      this._completeTeamPhase('allActed');
      return;
    }

    this._teamPhase.timer = this._setTimeout(() => this._handleTeamPhaseTimeout(), total);

    this.log('팀 페이즈 타이머 시작', 'INFO', {
      teamKey: this._teamPhase.teamKey,
      pending: this._teamPhase.pendingPlayers.size,
      duration: total,
      endsAt: new Date(this._teamPhase.deadlineAt).toISOString(),
    });

    this.emit('teamPhase:started', {
      teamKey: this._teamPhase.teamKey,
      pendingPlayers: Array.from(this._teamPhase.pendingPlayers),
      duration: total,
      endsAt: this._teamPhase.deadlineAt,
    });
  }

  /** 팀 페이즈에서 플레이어가 행동 완료했을 때 호출 */
  markPlayerActed(playerId) {
    if (!this._teamPhase.active) return;
    if (this._teamPhase.pendingPlayers.has(playerId)) {
      this._teamPhase.pendingPlayers.delete(playerId);
      this.emit('teamPhase:acted', {
        teamKey: this._teamPhase.teamKey,
        playerId,
        remainingPending: this._teamPhase.pendingPlayers.size,
      });
      // 모든 인원이 선택/행동을 마치면 즉시 페이즈 완료
      if (this._teamPhase.pendingPlayers.size === 0) {
        this._completeTeamPhase('allActed');
      }
    }
  }

  /** 팀 페이즈 종료/정리 */
  clearTeamPhase() {
    if (this._teamPhase.timer) {
      clearTimeout(this._teamPhase.timer);
    }
    const wasActive = this._teamPhase.active;
    this._teamPhase = {
      active: false,
      teamKey: null,
      startAt: null,
      deadlineAt: null,
      totalMs: 0,
      timer: null,
      pendingPlayers: new Set(),
      warned: false,
    };
    if (wasActive) {
      this.emit('teamPhase:cleared', { battleId: this.battleId });
    }
  }

  /** 팀 페이즈 강제 완료(모든 인원 행동 완료 등) */
  _completeTeamPhase(trigger = 'allActed') {
    const teamKey = this._teamPhase.teamKey;
    const pending = Array.from(this._teamPhase.pendingPlayers);
    this.log('팀 페이즈 완료', 'INFO', { teamKey, trigger, pendingCount: pending.length });

    this.emit('teamPhase:completed', { teamKey, trigger });

    try {
      if (this.callbacks.onTeamPhaseComplete) {
        this.callbacks.onTeamPhaseComplete(this.battleId, teamKey);
      } else {
        // 콜백 미구현 시, 하위 호환: timeout 콜백을 빈 pending으로 호출
        this.callbacks.onTeamPhaseTimeout(this.battleId, teamKey, []);
      }
    } catch (err) {
      this.log('onTeamPhaseComplete/Timeout 콜백 오류', 'ERROR', err);
    }

    this.clearTeamPhase();
  }

  /** 팀 페이즈 만료: 남은 모든 pending 플레이어 자동 패스 */
  _handleTeamPhaseTimeout() {
    this.stats.teamPhaseTimeouts += 1;

    const teamKey = this._teamPhase.teamKey;
    const pending = Array.from(this._teamPhase.pendingPlayers);
    this.log('팀 페이즈 시간 만료', 'WARN', {
      teamKey,
      pendingCount: pending.length,
    });

    // 미행동 플레이어 각각에 대해 onPlayerTimeout/onAutoPass 콜백 호출
    for (const playerId of pending) {
      try {
        if (this.callbacks.onAutoPass) {
          this.callbacks.onAutoPass(playerId, { teamKey, reason: 'teamPhaseTimeout' });
        }
        this.callbacks.onPlayerTimeout(playerId, { teamKey, reason: 'teamPhaseTimeout' });
      } catch (err) {
        this.log('팀 페이즈 만료 처리 오류', 'ERROR', { playerId, err });
      }
    }

    // 상위 알림
    try {
      this.callbacks.onTeamPhaseTimeout(this.battleId, teamKey, pending);
    } catch (err) {
      this.log('onTeamPhaseTimeout 콜백 오류', 'ERROR', err);
    }

    this.emit('teamPhase:timeout', { teamKey, pendingPlayers: pending });

    // 팀 페이즈 종료
    this.clearTeamPhase();
  }

  // ─────────────────────────────────────────────
  // 플레이어 타이머(선택 사용, 팀 페이즈와 별개)
  // ─────────────────────────────────────────────

  startPlayerTimer(playerId, timeout = null) {
    const total =
      typeof timeout === 'number' && timeout > 0 ? timeout : this.config.playerTurnTimeout;

    this.clearPlayerTimer(playerId);

    const now = this._now();
    const deadlineAt = now + total;
    const timer = this._setTimeout(() => this._handlePlayerTimeout(playerId), total);

    this.playerTimers.set(playerId, {
      startAt: now,
      deadlineAt,
      totalMs: total,
      warned: false,
      timer,
    });

    this.log('플레이어 타이머 시작', 'INFO', {
      playerId,
      duration: total,
      endsAt: new Date(deadlineAt).toISOString(),
    });

    this.emit('playerTimer:started', {
      playerId,
      duration: total,
      startTime: now,
      endsAt: deadlineAt,
    });

    return now;
  }

  clearPlayerTimer(playerId) {
    const info = this.playerTimers.get(playerId);
    if (info?.timer) clearTimeout(info.timer);

    this.playerTimers.delete(playerId);
    this.pausedTimers.delete(playerId);

    this.emit('playerTimer:cleared', { playerId });
  }

  pausePlayerTimer(playerId) {
    const info = this.playerTimers.get(playerId);
    if (!info) return false;

    const now = this._now();
    const remaining = Math.max(0, info.deadlineAt - now);

    if (info.timer) clearTimeout(info.timer);

    // 호환용 맵 갱신
    this.pausedTimers.set(playerId, {
      remaining,
      duration: info.totalMs,
      warned: info.warned,
    });

    // 활성 맵에서는 제거
    this.playerTimers.delete(playerId);

    this.log('플레이어 타이머 일시정지', 'INFO', { playerId, remaining });
    this.emit('playerTimer:paused', { playerId, remaining });

    return true;
  }

  resumePlayerTimer(playerId) {
    const pausedInfo = this.pausedTimers.get(playerId);
    if (!pausedInfo) return false;

    const now = this._now();
    const remaining = Math.max(0, pausedInfo.remaining);
    const deadlineAt = now + remaining;
    const timer = this._setTimeout(() => this._handlePlayerTimeout(playerId), remaining);

    this.playerTimers.set(playerId, {
      startAt: now - (pausedInfo.duration - remaining),
      deadlineAt,
      totalMs: pausedInfo.duration,
      warned: pausedInfo.warned,
      timer,
    });

    this.pausedTimers.delete(playerId);

    this.log('플레이어 타이머 재개', 'INFO', { playerId, remaining });
    this.emit('playerTimer:resumed', { playerId, remaining, startTime: now });

    return true;
  }

  extendPlayerTimer(playerId, additionalTime) {
    const add = Number(additionalTime) || 0;
    if (add <= 0) return false;

    // 실행 중
    const info = this.playerTimers.get(playerId);
    if (info) {
      const now = this._now();
      info.deadlineAt += add;
      info.totalMs += add;

      if (info.timer) clearTimeout(info.timer);
      const newRemaining = Math.max(0, info.deadlineAt - now);
      info.timer = this._setTimeout(() => this._handlePlayerTimeout(playerId), newRemaining);

      this.log('플레이어 타이머 연장', 'INFO', {
        playerId,
        additionalTime: add,
        newRemaining,
      });

      this.emit('playerTimer:extended', { playerId, additionalTime: add, newRemaining });
      return true;
    }

    // 일시정지 중
    const p = this.pausedTimers.get(playerId);
    if (p) {
      p.remaining += add;
      p.duration += add;

      this.log('일시정지된 플레이어 타이머 연장', 'INFO', {
        playerId,
        additionalTime: add,
        newRemaining: p.remaining,
      });

      this.emit('playerTimer:extended', {
        playerId,
        additionalTime: add,
        newRemaining: p.remaining,
      });
      return true;
    }

    return false;
  }

  _handlePlayerTimeout(playerId) {
    this.clearPlayerTimer(playerId);
    this.stats.playerTimeouts += 1;

    this.log('플레이어 시간 만료', 'WARN', { playerId });

    this.emit('playerTimer:timeout', { playerId });

    try {
      this.callbacks.onPlayerTimeout(playerId);
    } catch (err) {
      this.log('플레이어 타임아웃 콜백 오류', 'ERROR', err);
    }
  }

  _issuePlayerWarning(playerId, remaining) {
    this.stats.warningsIssued += 1;
    this.log('플레이어 시간 경고', 'WARN', { playerId, remaining });

    this.emit('playerTimer:warning', { playerId, remaining });

    try {
      this.callbacks.onTurnWarning(playerId, remaining);
    } catch (err) {
      this.log('플레이어 경고 콜백 오류', 'ERROR', err);
    }
  }

  clearAllPlayerTimers() {
    for (const [, info] of this.playerTimers) {
      if (info.timer) clearTimeout(info.timer);
    }
    const clearedCount = this.playerTimers.size;
    this.playerTimers.clear();
    this.pausedTimers.clear();

    this.log('모든 플레이어 타이머 정리', 'INFO', { clearedCount });
    this.emit('playerTimers:cleared', { clearedPlayers: clearedCount });
  }

  // ─────────────────────────────────────────────
  // 상태 조회
  // ─────────────────────────────────────────────

  isBattleActive() {
    return !!(this._battle.startAt && !this._battle.endAt);
  }

  isBattlePaused() {
    return !!this._battle.paused;
  }

  getBattleRemainingTime() {
    if (!this.isBattleActive()) return 0;
    if (this.isBattlePaused()) return Math.max(0, this._battle.remainingAtPauseMs || 0);
    return Math.max(0, (this._battle.deadlineAt || 0) - this._now());
  }

  getBattleElapsedTime() {
    if (!this._battle.startAt) return 0;
    const total = this._battle.totalPlannedMs || this.config.battleDuration;
    const remaining = this.getBattleRemainingTime();
    const elapsed = Math.max(0, total - remaining);
    return elapsed;
  }

  isTeamPhaseActive() {
    return !!this._teamPhase.active;
  }

  getTeamPhaseRemainingTime() {
    if (!this._teamPhase.active) return 0;
    return Math.max(0, (this._teamPhase.deadlineAt || 0) - this._now());
  }

  getTeamPhasePendingCount() {
    return this._teamPhase.pendingPlayers.size;
  }

  getTeamPhaseInfo() {
    if (!this._teamPhase.active) return null;
    return {
      teamKey: this._teamPhase.teamKey,
      startAt: this._teamPhase.startAt,
      deadlineAt: this._teamPhase.deadlineAt,
      totalMs: this._teamPhase.totalMs,
      pendingPlayers: Array.from(this._teamPhase.pendingPlayers),
      warned: this._teamPhase.warned,
    };
  }

  isPlayerTimerActive(playerId) {
    return this.playerTimers.has(playerId);
  }

  isPlayerTimerPaused(playerId) {
    return this.pausedTimers.has(playerId);
  }

  getActivePlayerTimers() {
    return Array.from(this.playerTimers.keys());
  }

  getPausedPlayerTimers() {
    return Array.from(this.pausedTimers.keys());
  }

  getPlayerRemainingTime(playerId) {
    const info = this.playerTimers.get(playerId);
    if (!info) return this.pausedTimers.get(playerId)?.remaining || 0;
    return Math.max(0, (info.deadlineAt || 0) - this._now());
  }

  getPlayerElapsedTime(playerId) {
    const info = this.playerTimers.get(playerId);
    if (info) {
      const remaining = Math.max(0, (info.deadlineAt || 0) - this._now());
      return Math.max(0, info.totalMs - remaining);
    }
    const paused = this.pausedTimers.get(playerId);
    if (paused) return Math.max(0, paused.duration - paused.remaining);
    return 0;
  }

  // ─────────────────────────────────────────────
  // 통계/리포트
  // ─────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      battle: {
        isActive: this.isBattleActive(),
        isPaused: this.isBattlePaused(),
        elapsed: this.getBattleElapsedTime(),
        remaining: this.getBattleRemainingTime(),
        startTime: this._battle.startAt,
        endTime: this._battle.endAt,
        plannedDuration: this._battle.totalPlannedMs || this.config.battleDuration,
      },
      teamPhase: {
        isActive: this.isTeamPhaseActive(),
        teamKey: this._teamPhase.teamKey,
        pending: this.getTeamPhasePendingCount(),
        remaining: this.getTeamPhaseRemainingTime(),
      },
      players: {
        active: this.playerTimers.size,
        paused: this.pausedTimers.size,
        activeList: this.getActivePlayerTimers(),
        pausedList: this.getPausedPlayerTimers(),
      },
    };
  }

  getDetailedStatus() {
    const total = this._battle.totalPlannedMs || this.config.battleDuration;
    const elapsed = this.getBattleElapsedTime();
    const remaining = this.getBattleRemainingTime();

    const status = {
      battleId: this.battleId,
      config: this.config,
      stats: this.getStats(),
      timers: {
        battle: this.isBattleActive()
          ? {
              startTime: this._battle.startAt,
              duration: total,
              elapsed,
              remaining,
              isPaused: this.isBattlePaused(),
              progress: total ? elapsed / total : 0,
              endsAt: this.isBattlePaused() ? null : this._battle.deadlineAt || null,
            }
          : null,
        teamPhase: this.isTeamPhaseActive()
          ? {
              teamKey: this._teamPhase.teamKey,
              startTime: this._teamPhase.startAt,
              duration: this._teamPhase.totalMs,
              elapsed: Math.max(0, this._teamPhase.totalMs - this.getTeamPhaseRemainingTime()),
              remaining: this.getTeamPhaseRemainingTime(),
              pendingPlayers: Array.from(this._teamPhase.pendingPlayers),
              endsAt: this._teamPhase.deadlineAt,
            }
          : null,
        players: [],
      },
    };

    for (const [playerId, info] of this.playerTimers.entries()) {
      const rem = Math.max(0, (info.deadlineAt || 0) - this._now());
      const el = Math.max(0, info.totalMs - rem);
      status.timers.players.push({
        playerId,
        startTime: info.startAt,
        duration: info.totalMs,
        elapsed: el,
        remaining: rem,
        warned: info.warned,
        isPaused: false,
        progress: info.totalMs ? el / info.totalMs : 0,
        endsAt: info.deadlineAt,
      });
    }

    for (const [playerId, paused] of this.pausedTimers.entries()) {
      status.timers.players.push({
        playerId,
        duration: paused.duration,
        remaining: paused.remaining,
        warned: paused.warned,
        isPaused: true,
        progress: paused.duration ? (paused.duration - paused.remaining) / paused.duration : 0,
        endsAt: null,
      });
    }

    return status;
  }

  // ─────────────────────────────────────────────
  // 정리/소멸자
  // ─────────────────────────────────────────────

  clearAll() {
    this._stopTicker();
    this._stopAutoSave();

    this.clearBattleTimer();
    this.clearTeamPhase();
    this.clearAllPlayerTimers();

    this.log('모든 타이머 정리 완료', 'INFO');
    this.emit('timers:cleared', { battleId: this.battleId });
  }

  destroy() {
    this.clearAll();
    this.removeAllListeners();
    this.log('TimerManager 종료', 'INFO');
  }

  // ─────────────────────────────────────────────
  // 상태 백업/복원
  // ─────────────────────────────────────────────

  exportState() {
    return {
      battleId: this.battleId,
      config: this.config,
      battle: {
        startAt: this._battle.startAt,
        endAt: this._battle.endAt,
        deadlineAt: this._battle.deadlineAt,
        paused: this._battle.paused,
        remainingAtPauseMs: this._battle.remainingAtPauseMs,
        totalPlannedMs: this._battle.totalPlannedMs,
        warnedPercents: Array.from(this._battle.warnedPercents || []),
      },
      teamPhase: this.isTeamPhaseActive()
        ? {
            teamKey: this._teamPhase.teamKey,
            startAt: this._teamPhase.startAt,
            deadlineAt: this._teamPhase.deadlineAt,
            totalMs: this._teamPhase.totalMs,
            pendingPlayers: Array.from(this._teamPhase.pendingPlayers),
            warned: this._teamPhase.warned,
          }
        : null,
      stats: this.stats,
      activeTimers: Array.from(this.playerTimers.entries()).map(([playerId, i]) => ({
        playerId,
        startAt: i.startAt,
        deadlineAt: i.deadlineAt,
        totalMs: i.totalMs,
        warned: i.warned,
      })),
      pausedTimers: Array.from(this.pausedTimers.entries()).map(([playerId, p]) => ({
        playerId,
        remaining: p.remaining,
        duration: p.duration,
        warned: p.warned,
      })),
    };
  }

  importState(state) {
    if (!state || state.battleId !== this.battleId) {
      throw new Error('배틀 ID가 일치하지 않습니다');
    }

    // 기존 정리
    this.clearAll();

    // 통계 복원(필요 시 일부만)
    this.stats = { ...this.stats, ...(state.stats || {}) };

    // 배틀 복원
    if (state.battle) {
      const b = state.battle;
      this._battle.startAt = b.startAt || null;
      this._battle.endAt = b.endAt || null;
      this._battle.deadlineAt = b.deadlineAt || null;
      this._battle.paused = !!b.paused;
      this._battle.pauseStartedAt = null;
      this._battle.remainingAtPauseMs = b.remainingAtPauseMs || 0;
      this._battle.totalPlannedMs = b.totalPlannedMs || this.config.battleDuration;
      this._battle.warnedPercents = new Set(b.warnedPercents || []);

      if (this.isBattleActive()) {
        if (this.isBattlePaused()) {
          // paused 상태면 타임아웃 예약하지 않음
        } else {
          const remaining = this.getBattleRemainingTime();
          if (remaining > 0) {
            this._battle.timer = this._setTimeout(
              () => this._handleBattleTimeout(),
              remaining
            );
          } else {
            // 이미 만료된 상태면 즉시 처리
            this._handleBattleTimeout();
          }
        }
      }
    }

    // 팀 페이즈 복원
    if (state.teamPhase) {
      const tp = state.teamPhase;
      this._teamPhase.active = true;
      this._teamPhase.teamKey = tp.teamKey || null;
      this._teamPhase.startAt = tp.startAt || null;
      this._teamPhase.totalMs = tp.totalMs || this.config.playerTurnTimeout;
      this._teamPhase.deadlineAt = tp.deadlineAt || null;
      this._teamPhase.pendingPlayers = new Set(tp.pendingPlayers || []);
      this._teamPhase.warned = !!tp.warned;

      const now = this._now();
      const remaining = Math.max(0, (this._teamPhase.deadlineAt || now) - now);
      if (remaining > 0) {
        this._teamPhase.timer = this._setTimeout(
          () => this._handleTeamPhaseTimeout(),
          remaining
        );
      } else {
        // 복원 시점에서 이미 만료됐다면 즉시 만료 처리
        this._handleTeamPhaseTimeout();
      }
    }

    // 플레이어 복원
    if (Array.isArray(state.activeTimers)) {
      for (const t of state.activeTimers) {
        const now = this._now();
        const remaining = Math.max(0, (t.deadlineAt || now) - now);
        if (remaining > 0) {
          const timer = this._setTimeout(
            () => this._handlePlayerTimeout(t.playerId),
            remaining
          );
          this.playerTimers.set(t.playerId, {
            startAt: t.startAt || now - ((t.totalMs || 0) - remaining),
            deadlineAt: t.deadlineAt || now + remaining,
            totalMs: t.totalMs || remaining,
            warned: !!t.warned,
            timer,
          });
        } else {
          // 이미 만료되었으면 즉시 타임아웃 처리
          this._handlePlayerTimeout(t.playerId);
        }
      }
    }

    if (Array.isArray(state.pausedTimers)) {
      for (const p of state.pausedTimers) {
        this.pausedTimers.set(p.playerId, {
          remaining: p.remaining,
          duration: p.duration,
          warned: !!p.warned,
        });
      }
    }

    // 틱/오토세이브 재가동
    if (this.config.tickInterval > 0) this._startTicker();
    if (this.config.enableAutoSave && this.callbacks.onAutoSave) this._startAutoSave();

    this.log('상태 복원 완료', 'INFO', {
      activeTimers: this.playerTimers.size,
      pausedTimers: this.pausedTimers.size,
      teamPhaseActive: this._teamPhase.active,
    });
  }
}

export default TimerManager;
export { TimerManager };
