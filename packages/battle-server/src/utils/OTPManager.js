// packages/battle-server/src/utils/OTPManager.js
// PYXIS OTP Manager - Enhanced Design Version (ESM)
// 역할별 TTL/사용한도 + 배틀/사용자 인덱싱 + 만료·폐기·일괄정리 지원
// 개선점 포함:
//  - 혼동 문자(I/O/0/1) 제거된 코드 생성
//  - clearExpired 시 stats.expired도 함께 집계
//  - type 소문자 정규화
//  - 표시용 포맷 helper(formatForDisplay) 추가

'use strict';

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

class OTPManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = {
      maxSpectators: options.maxSpectators || 30,
      maxPlayers: options.maxPlayers || 8,
      maxAdmins: options.maxAdmins || 3,
      otpLength: options.otpLength || 6,
      cleanupInterval: options.cleanupInterval || 5 * 60 * 1000, // 5분
      defaultTTL: {
        spectator: 30 * 60 * 1000, // 30분
        player: 30 * 60 * 1000,    // 30분
        admin: 60 * 60 * 1000,     // 60분
        ...(options.defaultTTL || {}),
      },
      defaultMaxUses: {
        spectator: Number.MAX_SAFE_INTEGER,
        player: Number.MAX_SAFE_INTEGER,
        admin: Number.MAX_SAFE_INTEGER,
        ...(options.defaultMaxUses || {}),
      },
      rateLimiting: {
        maxAttemptsPerIP: 10,
        windowMs: 15 * 60 * 1000,
        ...(options.rateLimiting || {}),
      },
      ...options,
    };

    // 저장소
    this.otpStore = new Map();   // otp -> { type, data, expiresAt, createdAt, usage, limits }
    this.ipAttempts = new Map(); // ip -> { attempts, resetAt }
    this.battleOTPs = new Map(); // battleId -> Set<otp>
    this.userOTPs = new Map();   // userId -> Set<otp>

    // 통계
    this.stats = {
      generated: 0,
      validated: 0,
      expired: 0,
      failed: 0,
      cleaned: 0,
      revoked: 0,
    };

    // 자동 만료 정리
    this.cleanupTimer = setInterval(() => {
      try {
        this.clearExpired();
      } catch (_) {}
    }, this.config.cleanupInterval);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();

    this.log('OTPManager 초기화 완료', 'INFO', this.config);
  }

  // ────────────────────────────
  // 로깅/유틸
  // ────────────────────────────
  mask(otp, left = 2) {
    if (!otp) return '';
    return otp.slice(0, left) + '****';
  }

  // 화면 표시용: 4자리-그룹 형태 (예: ABCD-EF)
  formatForDisplay(otp) {
    return String(otp || '').replace(/(.{4})(?=.)/g, '$1-');
  }

  log(message, level = 'INFO', data = null) {
    const timestamp = new Date().toISOString();
    const s = `[${timestamp}][OTPManager][${level}] ${message}`;
    if (level === 'ERROR') console.error(s, data || '');
    else if (level === 'WARN') console.warn(s, data || '');
    else console.log(s, data || '');
    this.emit('log', { message, level, data, timestamp });
  }

  now() {
    return Date.now();
  }

  // ────────────────────────────
  // Rate Limiting(IP별)
  // ────────────────────────────
  checkRateLimit(ip) {
    if (!ip) return true;
    const now = this.now();
    const { windowMs, maxAttemptsPerIP } = this.config.rateLimiting;
    const rec = this.ipAttempts.get(ip);

    if (!rec) {
      this.ipAttempts.set(ip, { attempts: 1, resetAt: now + windowMs });
      return true;
    }
    if (now > rec.resetAt) {
      rec.attempts = 1;
      rec.resetAt = now + windowMs;
      return true;
    }
    if (rec.attempts >= maxAttemptsPerIP) {
      this.log('Rate limit 초과', 'WARN', { ip, attempts: rec.attempts });
      return false;
    }
    rec.attempts += 1;
    return true;
  }

  // ────────────────────────────
  // 생성
  // ────────────────────────────
  generateOTP(type, data = {}, options = {}) {
    try {
      type = String(type || '').toLowerCase();

      const currentCount = this.getCountByType(type);
      const maxCount = this.getMaxCountByType(type);
      if (currentCount >= maxCount) {
        this.log('OTP 생성 한도 초과', 'WARN', { type, currentCount, maxCount });
        return null;
      }

      if (options.ip && !this.checkRateLimit(options.ip)) return null;

      let otp;
      let tries = 0;
      do {
        otp = this._secureCode(this.config.otpLength);
        if (++tries > 10) {
          this.log('OTP 생성 최대 시도 초과', 'ERROR', { tries });
          return null;
        }
      } while (this.otpStore.has(otp));

      const ttl =
        options.ttl ??
        this.config.defaultTTL[type] ??
        this.config.defaultTTL.spectator;

      const maxUses = options.oneTime
        ? 1
        : (options.maxUses ??
           this.config.defaultMaxUses[type] ??
           this.config.defaultMaxUses.spectator);

      const rec = {
        type,
        data: { ...(data || {}) },
        createdAt: this.now(),
        expiresAt: this.now() + ttl,
        usage: { attempts: 0, uses: 0, lastUsed: null, ip: options.ip || null },
        limits: { maxUses, oneTime: !!options.oneTime },
      };

      this.otpStore.set(otp, rec);
      this._indexAdd(otp, rec);
      this.stats.generated += 1;
      this.log('OTP 생성 성공', 'INFO', { type, otp: this.mask(otp), ttl, maxUses });
      this.emit('generated', { otp, ...rec });
      return otp;
    } catch (e) {
      this.log('OTP 생성 실패', 'ERROR', e);
      return null;
    }
  }

  // 혼동 문자(I,O,0,1) 제거
  _secureCode(length) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  getMaxCountByType(type) {
    if (type === 'spectator') return this.config.maxSpectators;
    if (type === 'player') return this.config.maxPlayers;
    if (type === 'admin') return this.config.maxAdmins;
    return 0;
  }

  getCountByType(type) {
    const now = this.now();
    let n = 0;
    for (const [, rec] of this.otpStore) {
      if (rec.type === type && now <= rec.expiresAt) n += 1;
    }
    return n;
  }

  // ────────────────────────────
  // 검증
  // ────────────────────────────
  validateOTP(otp, options = {}) {
    try {
      if (options.ip && !this.checkRateLimit(options.ip)) {
        this.stats.failed += 1;
        return { valid: false, reason: 'rate_limit' };
      }

      const rec = this.otpStore.get(otp);
      if (!rec) {
        this.stats.failed += 1;
        this.log('존재하지 않는 OTP', 'WARN', { otp: this.mask(otp) });
        return { valid: false, reason: 'not_found' };
      }

      if (this.now() > rec.expiresAt) {
        this.otpStore.delete(otp);
        this._indexRemove(otp, rec);
        this.stats.expired += 1; // 만료 카운트
        this.log('만료된 OTP', 'WARN', { otp: this.mask(otp) });
        return { valid: false, reason: 'expired' };
      }

      if (rec.usage.uses >= rec.limits.maxUses) {
        this.otpStore.delete(otp);
        this._indexRemove(otp, rec);
        this.log('사용 한도 초과', 'WARN', { otp: this.mask(otp) });
        return { valid: false, reason: 'usage_limit_exceeded' };
      }

      rec.usage.attempts += 1;
      rec.usage.uses += 1;
      rec.usage.lastUsed = this.now();
      if (options.ip) rec.usage.ip = options.ip;

      const reachedLimit = rec.usage.uses >= rec.limits.maxUses || rec.limits.oneTime;
      this.stats.validated += 1;
      this.log('OTP 검증 성공', 'INFO', {
        otp: this.mask(otp),
        type: rec.type,
        uses: rec.usage.uses,
        max: rec.limits.maxUses,
      });

      if (reachedLimit) {
        this.otpStore.delete(otp);
        this._indexRemove(otp, rec);
        this.stats.revoked += 1;
        this.emit('revoked', { otp, ...rec });
      }

      this.emit('validated', { otp, ...rec });
      return {
        valid: true,
        type: rec.type,
        data: { ...rec.data },
        usage: { ...rec.usage },
        remainingUses: Math.max(0, rec.limits.maxUses - rec.usage.uses),
        willRevoke: reachedLimit,
      };
    } catch (e) {
      this.stats.failed += 1;
      this.log('OTP 검증 오류', 'ERROR', e);
      return { valid: false, reason: 'error' };
    }
  }

  // ────────────────────────────
  // 인덱스 관리
  // ────────────────────────────
  _indexAdd(otp, rec) {
    const b = rec?.data?.battleId;
    if (b) {
      if (!this.battleOTPs.has(b)) this.battleOTPs.set(b, new Set());
      this.battleOTPs.get(b).add(otp);
    }
    const u = rec?.data?.userId || rec?.data?.playerId || rec?.data?.nickname;
    if (u) {
      if (!this.userOTPs.has(u)) this.userOTPs.set(u, new Set());
      this.userOTPs.get(u).add(otp);
    }
  }

  _indexRemove(otp, rec) {
    const b = rec?.data?.battleId;
    if (b && this.battleOTPs.has(b)) {
      const set = this.battleOTPs.get(b);
      set.delete(otp);
      if (set.size === 0) this.battleOTPs.delete(b);
    }
    const u = rec?.data?.userId || rec?.data?.playerId || rec?.data?.nickname;
    if (u && this.userOTPs.has(u)) {
      const set = this.userOTPs.get(u);
      set.delete(otp);
      if (set.size === 0) this.userOTPs.delete(u);
    }
  }

  // ────────────────────────────
  // 정리/폐기 API
  // ────────────────────────────
  clearExpired() {
    const now = this.now();
    let n = 0;
    for (const [otp, rec] of this.otpStore.entries()) {
      if (now > rec.expiresAt) {
        this.otpStore.delete(otp);
        this._indexRemove(otp, rec);
        n += 1;
      }
    }
    if (n) {
      this.stats.cleaned += n;
      this.stats.expired += n; // 만료 집계에 반영
      this.log(`만료 OTP 정리: ${n}건`, 'INFO');
    }
    return n;
  }

  clearByBattle(battleId) {
    if (!battleId) return 0;
    const set = this.battleOTPs.get(battleId);
    if (!set || set.size === 0) return 0;

    let n = 0;
    for (const otp of Array.from(set)) {
      const rec = this.otpStore.get(otp);
      if (!rec) {
        set.delete(otp);
        continue;
      }
      this.otpStore.delete(otp);
      this._indexRemove(otp, rec);
      n += 1;
    }
    if (n) {
      this.stats.cleaned += n;
      this.log(`배틀 OTP 일괄 폐기: ${battleId} (${n}건)`, 'INFO');
    }
    return n;
  }

  clearByUser(userId) {
    if (!userId) return 0;
    const set = this.userOTPs.get(userId);
    if (!set || set.size === 0) return 0;

    let n = 0;
    for (const otp of Array.from(set)) {
      const rec = this.otpStore.get(otp);
      if (!rec) {
        set.delete(otp);
        continue;
      }
      this.otpStore.delete(otp);
      this._indexRemove(otp, rec);
      n += 1;
    }
    if (n) {
      this.stats.cleaned += n;
      this.log(`사용자 OTP 일괄 폐기: ${userId} (${n}건)`, 'INFO');
    }
    return n;
  }

  clearAll() {
    const n = this.otpStore.size;
    this.otpStore.clear();
    this.battleOTPs.clear();
    this.userOTPs.clear();
    if (n) {
      this.stats.cleaned += n;
      this.log(`전체 OTP 초기화: ${n}건`, 'WARN');
    }
    return n;
  }

  revokeOTP(otp) {
    const rec = this.otpStore.get(otp);
    if (!rec) return false;
    this.otpStore.delete(otp);
    this._indexRemove(otp, rec);
    this.stats.revoked += 1;
    this.emit('revoked', { otp, ...rec, by: 'manual' });
    this.log(`OTP 수동 폐기: ${this.mask(otp)}`, 'INFO');
    return true;
  }

  getOTPsByBattle(battleId) {
    const set = this.battleOTPs.get(battleId);
    if (!set) return [];
    return Array.from(set);
  }

  getOTPsByUser(userId) {
    const set = this.userOTPs.get(userId);
    if (!set) return [];
    return Array.from(set);
  }

  getStats() {
    return { ...this.stats, total: this.otpStore.size };
  }

  getDetailedInfo(battleId) {
    const otps = this.getOTPsByBattle(battleId);
    return otps.map((o) => {
      const rec = this.otpStore.get(o);
      return rec ? { otp: o, ...rec } : { otp: o, missing: true };
    });
  }

  destroy() {
    try {
      clearInterval(this.cleanupTimer);
    } catch (_) {}
    this.clearAll();
    this.ipAttempts.clear();
    this.log('OTPManager destroy', 'WARN');
  }
}

export default OTPManager;
export { OTPManager };
