// packages/battle-server/src/engine/turns.js
import { d20 } from "./dice.js"; // d20()는 이제 D10을 반환

/** 생존자만 반환 */
export function alive(players, team) {
  return (players || []).filter(p => (!team || p.team === team) && (p.hp || 0) > 0);
}

/** 선공 결정: 팀 민첩 합 + D10 (동점시 재굴림) - D20에서 D10으로 변경 */
export function decideFirstTeam(players) {
  const sumAgi = (team) => alive(players, team).reduce((s, p) => s + (p.stats?.agility || 0), 0);
  // 동점시 재굴림
  while (true) {
    const a = sumAgi("A") + d20(); // 실제로는 D10
    const b = sumAgi("B") + d20(); // 실제로는 D10
    if (a > b) return "A";
    if (b > a) return "B";
  }
}

/** 라운드/페이즈/행동 인덱스 세팅 */
export function initTurn(battle, firstTeam) {
  battle.turn = {
    round: 1,
    order: [firstTeam, firstTeam === "A" ? "B" : "A"], // 선공 -> 후공
    phaseIndex: 0,         // 0: 선공팀, 1: 후공팀
    idxA: 0,               // A팀 인덱스
    idxB: 0,               // B팀 인덱스
    lastActorTeam: null,   // 마지막 행동 팀
    phaseStartedAt: Date.now()
  };
  updateCurrentPlayer(battle);
}

/** 현재 플레이어 포인터 갱신 */
export function updateCurrentPlayer(battle) {
  const t = battle.turn;
  const team = t.order[t.phaseIndex];
  const list = alive(battle.players, team);
  const idx = (team === "A" ? t.idxA : t.idxB);
  const cur = list[idx] || null;
  battle.currentTurn = {
    turnNumber: t.round,
    currentTeam: team,
    currentPlayer: cur ? { id: cur.id, name: cur.name, avatar: cur.avatar, team: cur.team } : null,
    playerActions: {}
  };
}

/** 다음 순서로 진행, 팀 전원 완료 시 페이즈 교대, 라운드 종료 시 선후공 교대 */
export function advance(battle) {
  const t = battle.turn;
  const team = t.order[t.phaseIndex];
  const listA = alive(battle.players, "A");
  const listB = alive(battle.players, "B");
  const list = team === "A" ? listA : listB;

  if (team === "A") t.idxA++;
  else t.idxB++;

  const done = (team === "A" ? t.idxA >= list.length : t.idxB >= list.length);

  if (done) {
    // 팀 교대
    t.phaseIndex = (t.phaseIndex + 1) % 2;
    if (t.phaseIndex === 0) {
      // 라운드 종료 → 선/후공 교대
      t.round++;
      t.order.reverse();
      t.idxA = 0; t.idxB = 0;
    }
    t.phaseStartedAt = Date.now();
  }

  updateCurrentPlayer(battle);
}

/** 승리 판정 (즉시/제한) */
export function judgeWinner(battle) {
  const A = alive(battle.players, "A");
  const B = alive(battle.players, "B");
  if (A.length === 0 && B.length > 0) return "B";
  if (B.length === 0 && A.length > 0) return "A";
  if (A.length === 0 && B.length === 0) return "draw";

  // 제한: 100턴 또는 1시간
  const turnLimit = battle.turn?.round >= 100;
  const timeLimit = (Date.now() - (battle.createdAt || 0)) >= (60 * 60 * 1000);
  if (turnLimit || timeLimit) {
    const sumHp = (list) => list.reduce((s, p) => s + (p.hp || 0), 0);
    const sA = sumHp(A), sB = sumHp(B);
    if (sA > sB) return "A";
    if (sB > sA) return "B";
    // 무승부 방지 타이브레이커
    // 1) 생존자 수
    if (A.length > B.length) return "A";
    if (B.length > A.length) return "B";
    // 2) 최근 공격자 팀
    if (battle.turn?.lastActorTeam) return battle.turn.lastActorTeam;
    // 3) 현재 턴 팀
    if (battle.currentTurn?.currentTeam) return battle.currentTurn.currentTeam;
    // 4) 선공 팀
    if (battle.turn?.order?.[0]) return battle.turn.order[0];
    // 5) 민첩 합
    const sumAgi = (team) => alive(battle.players, team).reduce((s, p) => s + (p.stats?.agility || 0), 0);
    const agA = sumAgi("A"), agB = sumAgi("B");
    if (agA > agB) return "A"; if (agB > agA) return "B";
    // 6) 마지막: 알파벳 순
    return "A";
  }
  return null;
}
