// packages/battle-server/src/routes/links.js
// PYXIS 배틀 시스템 - 링크 생성 API (도메인 수정/오류 정리)
const express = require('express');
const router = express.Router();

// 고정 도메인
const BASE_URL = 'https://pyxisbattlesystem.monster';

/* ───────────── 유틸 ───────────── */
function generateOTP(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateToken(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 실제 처리 로직(주/호환 라우트가 같은 함수를 호출)
 */
function handleCreateLinks(req, res) {
  try {
    // 기존 코드와의 파라미터 이름 혼선(:id vs :battleId) 모두 지원
    const battleId = req.params.battleId || req.params.id;
    if (!battleId) {
      return res.status(400).json({ ok: false, error: 'battleId is required' });
    }

    // 전투 조회 (전역 battleEngine 사용 전제: index.js 등에서 세팅)
    const battle = global.battleEngine?.get(battleId);
    if (!battle) {
      return res.status(404).json({ ok: false, error: 'Battle not found' });
    }

    // 관전자 OTP 생성 및 보관(30분 유효)
    const spectatorOtp = generateOTP(8);
    const spectatorExpiry = Date.now() + 30 * 60 * 1000;

    if (!global.passwordStore) {
      global.passwordStore = new Map();
    }
    global.passwordStore.set(`spectator_${battleId}`, {
      otp: spectatorOtp,
      battleId,
      expiresAt: spectatorExpiry
    });

    // 응답 데이터 구성
    const responseData = {
      ok: true,
      battleId,
      spectator: {
        otp: spectatorOtp,
        url: `/spectator?battle=${encodeURIComponent(battleId)}&otp=${encodeURIComponent(spectatorOtp)}`,
        fullUrl: `${BASE_URL}/spectator?battle=${encodeURIComponent(battleId)}&otp=${encodeURIComponent(spectatorOtp)}`,
        expiresAt: spectatorExpiry
      },
      players: []
    };

    // 플레이어 링크 생성(토큰 발급 및 battle 객체에 반영)
    if (Array.isArray(battle.players)) {
      battle.players.forEach((player) => {
        const token = generateToken(16);
        player.token = token; // 기존 흐름 유지(메모리 battle에 기록)

        responseData.players.push({
          id: player.id,
          name: player.name,
          team: player.team,
          token,
          url: `/player?battle=${encodeURIComponent(battleId)}&token=${encodeURIComponent(token)}`,
          fullUrl: `${BASE_URL}/player?battle=${encodeURIComponent(battleId)}&token=${encodeURIComponent(token)}`
        });
      });
    }

    return res.json(responseData);
  } catch (error) {
    console.error('링크 생성 실패:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/* ───────────── 라우트 ─────────────
   두 경로 모두 지원:
   - /api/admin/battles/:id/links  (관리자용 주 경로)
   - /api/battles/:id/links       (호환 경로)
   ※ :id / :battleId 파라미터 모두 허용
*/
router.post('/admin/battles/:id/links', handleCreateLinks);
router.post('/admin/battles/:battleId/links', handleCreateLinks);

// 호환 API
router.post('/battles/:id/links', handleCreateLinks);
router.post('/battles/:battleId/links', handleCreateLinks);

module.exports = router;
