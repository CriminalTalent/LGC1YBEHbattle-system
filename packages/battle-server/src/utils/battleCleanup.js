// packages/battle-server/src/utils/battleCleanup.js
// ESM 모드
// - 전투 관련 OTP 일괄 정리 유틸리티 (기존 API 유지)
// - 필요 시 타이머/브로드캐스트 정리까지 선택적으로 확장 가능(옵션)
// - app.get('otp') 에서 OTPManager 인스턴스를 가져와 battleId 기준으로 폐기
// - 예외 상황을 한국어 사유로 반환
//
// ⚠️ 호환성:
//   - cleanupOTPsForBattle(app, battleId) 시그니처/리턴은 기존 그대로 유지
//   - cleanupBattleResources(app, battleId) 역시 기존처럼 { ok, steps:{ otp } }를 포함
//   - 추가 스텝(timers, notify)은 옵션 사용 시에만 steps에 포함되며, 기본 동작/형태는 동일

'use strict';

/**
 * 내부 로깅 (console 기반)
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {any} [meta]
 */
function log(level, message, meta) {
  const ts = new Date().toISOString();
  const line = `[${ts}][battleCleanup][${level}] ${message}`;
  if (level === 'ERROR') console.error(line, meta ?? '');
  else if (level === 'WARN') console.warn(line, meta ?? '');
  else console.log(line, meta ?? '');
}

/**
 * 특정 전투에 발급된 OTP를 모두 정리합니다.
 * @param {import('express').Express} app Express 앱 인스턴스 (app.get('otp') 필요)
 * @param {string} battleId 전투 ID
 * @returns {{ ok: boolean, removed: number, reason?: string }}
 */
export function cleanupOTPsForBattle(app, battleId) {
  try {
    if (!app || typeof app.get !== 'function' || !battleId) {
      return { ok: false, removed: 0, reason: '유효하지 않은 인자입니다' };
    }

    const otpMgr = app.get('otp');
    if (!otpMgr || typeof otpMgr.clearByBattle !== 'function') {
      return { ok: false, removed: 0, reason: 'OTP 관리자 미초기화' };
    }

    const removed = Number(otpMgr.clearByBattle(battleId)) || 0;
    log('INFO', `OTP 정리 완료: battleId=${battleId}, removed=${removed}`);
    return { ok: true, removed };
  } catch (e) {
    log('ERROR', 'OTP 정리 중 오류', e);
    return { ok: false, removed: 0, reason: e?.message || '정리 중 오류 발생' };
  }
}

/**
 * (선택) 특정 전투에 연결된 타이머를 정리합니다.
 * - app.get('timers')가
 *   1) clearForBattle(battleId) 를 제공하거나
 *   2) Map 형태로 battleId -> TimerManager 를 저장하고 있다면 clearAll() 호출을 시도합니다.
 * @param {import('express').Express} app
 * @param {string} battleId
 * @returns {{ ok: boolean, cleared: number, reason?: string }}
 */
export function cleanupTimersForBattle(app, battleId) {
  try {
    if (!app || typeof app.get !== 'function' || !battleId) {
      return { ok: false, cleared: 0, reason: '유효하지 않은 인자입니다' };
    }

    const timers = app.get('timers');
    if (!timers) {
      return { ok: true, cleared: 0 }; // 타이머 미사용 환경
    }

    // 케이스 1: Registry 객체가 clearForBattle 제공
    if (typeof timers.clearForBattle === 'function') {
      const n = Number(timers.clearForBattle(battleId)) || 0;
      log('INFO', `타이머 레지스트리 clearForBattle 실행: battleId=${battleId}, cleared=${n}`);
      return { ok: true, cleared: n };
    }

    // 케이스 2: Map 형태: battleId -> TimerManager
    if (typeof timers.get === 'function') {
      const tm = timers.get(battleId);
      if (tm && typeof tm.clearAll === 'function') {
        tm.clearAll();
        log('INFO', `TimerManager.clearAll 실행: battleId=${battleId}`);
        return { ok: true, cleared: 1 };
      }
      return { ok: true, cleared: 0 };
    }

    // 알 수 없는 형태면 성공으로 간주(필수 스텝 아님)
    return { ok: true, cleared: 0 };
  } catch (e) {
    log('ERROR', '타이머 정리 중 오류', e);
    return { ok: false, cleared: 0, reason: e?.message || '타이머 정리 오류' };
  }
}

/**
 * (선택) 브로드캐스트/소켓 측에 전투 종료를 알립니다.
 * - app.get('broadcast')가 BroadcastManager 인스턴스라면 battle:ended 등 알림
 * - 없으면 조용히 통과
 * @param {import('express').Express} app
 * @param {string} battleId
 * @param {{ winner?: 'A'|'B'|null, reason?: string }} [endData]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function notifyBattleEnded(app, battleId, endData = {}) {
  try {
    if (!app || typeof app.get !== 'function' || !battleId) {
      return { ok: false, reason: '유효하지 않은 인자입니다' };
    }
    const broadcast = app.get('broadcast');
    if (!broadcast) return { ok: true }; // 브로드캐스터 미사용 환경

    // BroadcastManager의 ended() 신식 이벤트가 있다면 사용
    if (typeof broadcast.ended === 'function') {
      broadcast.ended(battleId, {
        winner: endData.winner ?? null,
        reason: endData.reason ?? 'cleanup',
        at: Date.now()
      });
      log('INFO', `브로드캐스트 종료 알림 전송(ended): battleId=${battleId}`);
      return { ok: true };
    }

    // 신식 메소드가 없다면 안전한 범위에서 구 이벤트로 전송 시도
    if (typeof broadcast.toAll === 'function') {
      broadcast.toAll(battleId, 'battle:ended', {
        winner: endData.winner ?? null,
        reason: endData.reason ?? 'cleanup',
        at: Date.now()
      });
      log('INFO', `브로드캐스트 종료 알림 전송(toAll): battleId=${battleId}`);
      return { ok: true };
    }

    return { ok: true };
  } catch (e) {
    log('ERROR', '브로드캐스트 종료 알림 중 오류', e);
    return { ok: false, reason: e?.message || '브로드캐스트 알림 오류' };
  }
}

/**
 * 전투 종료 시 후처리를 한 번에 수행합니다.
 * 기본은 OTP 정리만 수행(기존과 동일). 옵션을 통해 타이머 정리/브로드캐스트 알림을 추가할 수 있습니다.
 *
 * @param {import('express').Express} app
 * @param {string} battleId
 * @param {{ timers?: boolean, notify?: boolean, winner?: 'A'|'B'|null, reason?: string }} [options]
 * @returns {{ ok: boolean, steps: { otp: { ok: boolean, removed: number, reason?: string }, timers?: { ok: boolean, cleared: number, reason?: string }, notify?: { ok: boolean, reason?: string } } }}
 */
export function cleanupBattleResources(app, battleId, options = {}) {
  // 항상 수행: OTP 정리 (기존 동작 유지)
  const otp = cleanupOTPsForBattle(app, battleId);

  const steps = { otp };
  let allOk = otp.ok;

  // 선택: 타이머 정리
  if (options.timers) {
    const timers = cleanupTimersForBattle(app, battleId);
    steps.timers = timers;
    allOk = allOk && timers.ok;
  }

  // 선택: 브로드캐스트 종료 알림
  if (options.notify) {
    const notify = notifyBattleEnded(app, battleId, {
      winner: options.winner ?? null,
      reason: options.reason ?? 'cleanup'
    });
    steps.notify = notify;
    allOk = allOk && notify.ok;
  }

  return { ok: allOk, steps };
}

export default {
  cleanupOTPsForBattle,
  cleanupTimersForBattle,
  notifyBattleEnded,
  cleanupBattleResources
};
