// packages/battle-server/src/engine/battle-handlers.js
// Glue between socket and engine
export function makeBattleHandlers({ battles, io }) {
  // ▼ 표시용 팀명(내부 키는 A/B 유지)
  const teamName = (t) => (t === 'A' ? '불사조 기사단' : t === 'B' ? '죽음을 먹는자' : String(t));

  function emitUpdate(bid) {
    const b = battles.snapshot(bid);
    if (!b) return;

    // 남은 시간 보강: 엔진 timers.turnDeadline 사용
    const raw = battles.get(bid);
    const dl =
      (raw && raw.timers && raw.timers.turnDeadline)
        ? raw.timers.turnDeadline
        : (raw?.currentTurn?.turnDeadline || null);

    b.currentTurn = b.currentTurn || {};
    // 항상 숫자 내려주기 (없으면 0)
    b.currentTurn.timeLeftSec = dl
      ? Math.max(0, Math.floor((dl - Date.now()) / 1000))
      : 0;

    // 호환성: 구 이벤트도 함께 발행
    io.to(bid).emit('battleUpdate', b);
    io.to(bid).emit('battle:update', b);
  }

  function pushLog(bid, type, message, extra = {}) {
    const b = battles.get(bid);
    if (!b) return;
    const entry = { ts: Date.now(), type, message, ...extra };
    b.logs.push(entry);
    // 단일 채널로만 브로드캐스트 (중복 제거)
    io.to(bid).emit('battle:log', entry);
  }

  return {
    createBattle(mode = '1v1') {
      const b = battles.create(mode);
      pushLog(b.id, 'system', `전투 생성 (${mode})`);
      emitUpdate(b.id);
      return b.id;
    },

    addPlayer(bid, player) {
      const p = battles.addPlayer(bid, player);
      pushLog(bid, 'system', `전투 참가자 추가: ${p.name} (${teamName(p.team)})`);
      emitUpdate(bid);
      return p;
    },

    removePlayer(bid, pid) {
      const b = battles.get(bid); if (!b) return false;
      const p = b.players.find(x => x.id === pid);
      const ok = battles.removePlayer(bid, pid);
      if (ok) {
        pushLog(bid, 'system', `전투 참가자 삭제: ${p?.name || pid}`);
        emitUpdate(bid);
      }
      return ok;
    },

    markReady(bid, pid) {
      const b = battles.get(bid); if (!b) return false;
      const p = b.players.find(x => x.id === pid);
      const ok = battles.markReady(bid, pid, true);
      if (ok) {
        pushLog(bid, 'battle', `${p?.name || pid} 준비 완료`);
        emitUpdate(bid);
      }
      return ok;
    },

    startBattle(bid) {
      const r = battles.start(bid);
      if (!r) return null;
      const { b, sumA, sumB, rA, rB, totalA, totalB, first } = r;
      pushLog(
        b.id,
        'battle',
        `선공 판정: ${teamName('A')}(${sumA} + D20=${rA} → ${totalA}) / ${teamName('B')}(${sumB} + D20=${rB} → ${totalB}) → 선공: ${teamName(first)}`
      );
      emitUpdate(b.id);
      return b;
    },

    playerAction(bid, pid, action) {
      const { result, phase } = battles.playerAction(bid, pid, action);
      const actorName = (battles.get(bid)?.players.find(p => p.id === pid)?.name) || pid;

      // 행동 로그(요약)
      pushLog(bid, 'battle', `[행동] ${actorName}: ${result.message}`);
      emitUpdate(bid);

      if (phase === 'switch') {
        const b = battles.get(bid);
        pushLog(bid, 'battle', `턴 교대 → ${teamName(b.currentTurn.currentTeam)}`);
        emitUpdate(bid);
      }

      if (phase === 'roundEnd') {
        const b = battles.get(bid);
        pushLog(bid, 'battle', `라운드 종료 → 다음 라운드 ${b.currentTurn.turnNumber} 시작 (선공 ${teamName(b.currentTurn.currentTeam)})`);
        emitUpdate(bid);
      }
      return result;
    },

    sendChat(bid, payload) {
      io.to(bid).emit('chatMessage', payload);
      io.to(bid).emit('battle:chat', payload);
    },

    sendCheerToChat(bid, name, message) {
      const payload = { name: name || '관전자', message: `[응원] ${message}` };
      io.to(bid).emit('chatMessage', payload);
      io.to(bid).emit('battle:chat', payload);
    },
  };
}
