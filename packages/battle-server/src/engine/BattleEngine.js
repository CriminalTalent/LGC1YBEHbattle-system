/* packages/battle-server/src/engine/BattleEngine.js (ESM, drop-in replacement)
 * 규칙 요약
 * - 선택 페이즈: '의도 로그'만 송출
 * - 해석 페이즈(resolve): 수치 적용 + '결과 로그' 일괄 송출
 * - 팀당 선택 제한: 5분
 * - 선후공: 라운드마다 교대
 * - 팀 내부 실행 순서: 민첩 내림차순, 동률 시 이름 오름차순(ABC)
 * - 전투 하드리밋: 1시간 (전투 시작 시점부터) — 시간 종료 시 생존 HP 합산 승자
 * - 아이템: 1회용(디터니 고정10, 공격 보정기 1회 강화공격, 방어 보정기 방어×2)
 * - 회피/방어는 '선택했을 때만' 적용 (자동 없음)
 * - ✅ 집중공격 규칙: 한 대상에게 들어오는 여러 공격 중 '최초 1회'만 회피/방어/방어보정기 적용
 */

import { randomUUID } from 'node:crypto';

const now = () => Date.now();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const TEAM_SELECT_MS    = 5 * 60 * 1000; // 팀당 5분
const ROUND_BREAK_MS    = 5_000;         // 라운드 간 5초 (실제 대기 반영)
const RESOLVE_WINDOW_MS = 3_000;         // 해석(오버레이) 표시 보장 시간

const d10 = () => 1 + Math.floor(Math.random() * 10);
const teamOf = (p) => (p?.team === 'B' ? 'B' : 'A');

function sortByInitiative(players) {
  return [...players].sort((a, b) => {
    const ag = (b.stats?.agility ?? 0) - (a.stats?.agility ?? 0);
    if (ag !== 0) return ag;
    return (a.name || '').localeCompare((b.name || ''), 'ko-KR');
  });
}

// 콜백 안전 호출 + 로그 캡
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) {
    // 콜백 예외는 엔진을 죽이지 않음
    console.error('[BattleEngine callback error]', e);
  }
}

export function createBattleStore() {
  const battles = new Map();

  let onLog = null;    // (battleId, entry)
  let onUpdate = null; // (battleId) => void

  const setLogger = fn => { onLog = (typeof fn === 'function') ? fn : null; };
  const setUpdate = fn => { onUpdate = (typeof fn === 'function') ? fn : null; };

  const pushLog = (b, message, type = 'system') => {
    const entry = { ts: now(), type, message };
    b.logs.push(entry);

    // 로그 캡(최근 N개만 보관)
    const MAX_LOGS = 3000;
    if (b.logs.length > MAX_LOGS) {
      b.logs.splice(0, b.logs.length - MAX_LOGS);
    }

    safeCall(onLog, b.id, entry);
  };

  const touch = b => { safeCall(onUpdate, b.id); };

  const size = () => battles.size;
  const get  = id => battles.get(id) || null;

  function snapshot(id) {
    const b = battles.get(id);
    if (!b) return null;
    const timeLeftSec = Math.max(
      0,
      Math.ceil(((b.phaseEndsAt || now()) - now()) / 1000)
    );
    const currentPlayer = b.turnCursor?.playerId
      ? b.players.find(p => p.id === b.turnCursor.playerId) || null
      : null;

    return {
      id: b.id,
      status: b.status,
      phase: b.phase,
      round: b.round,
      currentTeam: b.currentTeam,
      nextFirstTeam: b.nextFirstTeam,
      createdAt: b.createdAt,
      hardLimitAt: b.hardLimitAt,
      currentTurn: { round: b.round, currentTeam: b.currentTeam, timeLeftSec, currentPlayer },
      players: b.players.map(p => ({
        id: p.id, name: p.name, team: p.team, avatar: p.avatar,
        hp: p.hp, maxHp: p.maxHp, ready: !!p.ready,
        stats: { ...p.stats },
        items: { ...p.items },
      }))
    };
  }

  const teamAlive = (b, t) => b.players.some(p => p.team === t && p.hp > 0);
  const bothAlive = (b) => teamAlive(b, 'A') && teamAlive(b, 'B');

  function create(mode = '2v2') {
    const id = randomUUID();
    const b = {
      id, mode,
      status: 'waiting',         // waiting|active|paused|ended
      phase: 'idle',             // idle|A_select|B_select|resolve|inter
      round: 0,
      currentTeam: null,
      nextFirstTeam: null,
      selectionDone: { A: false, B: false },
      players: [],
      choices: { A: [], B: [] },
      logs: [],
      createdAt: now(),
      hardLimitAt: null,         // ✅ 전투 시작 시점에 세팅
      turnCursor: null,          // {team, order:[ids], index, playerId}
      phaseEndsAt: null
    };
    battles.set(id, b);
    return b;
  }

  function addPlayer(battleId, player) {
    const b = get(battleId); if (!b) return null;
    const id = player.id || randomUUID();
    const p = {
      id,
      team: player.team === 'B' ? 'B' : 'A',
      name: player.name || `P${b.players.length + 1}`,
      avatar: player.avatar || '',
      hp: Number.isFinite(player.hp) ? player.hp : 100,
      maxHp: Number.isFinite(player.maxHp) ? player.maxHp :
        (Number.isFinite(player.hp) ? player.hp : 100),
      stats: {
        attack:  +(player.stats?.attack  ?? 1),
        defense: +(player.stats?.defense ?? 1),
        agility: +(player.stats?.agility ?? 1),
        luck:    +(player.stats?.luck    ?? 1),
      },
      items: {
        dittany:        +(player.items?.dittany ?? player.items?.ditany ?? 0),
        attackBooster:  +(player.items?.attackBooster  ?? player.items?.attack_boost  ?? 0),
        defenseBooster: +(player.items?.defenseBooster ?? player.items?.defense_boost ?? 0),
      },
      ready: false,
      token: player.token || null,
    };
    b.players.push(p);
    touch(b);
    return p;
  }

  function removePlayer(battleId, playerId) {
    const b = get(battleId); if (!b) return false;
    const idx = b.players.findIndex(p => p.id === playerId);
    if (idx === -1) return false;
    b.players.splice(idx, 1);
    ['A', 'B'].forEach(t => { b.choices[t] = b.choices[t].filter(c => c.playerId !== playerId); });
    touch(b);
    return true;
  }

  function markReady(battleId, playerId, ready = true) {
    const b = get(battleId); if (!b) return false;
    const p = b.players.find(x => x.id === playerId); if (!p) return false;
    p.ready = !!ready;
    pushLog(b, `${p.name}이(가) 준비 완료했습니다`, 'system');
    touch(b);
    return true;
  }

  function allReady(b) {
    const teams = new Set(b.players.map(p => p.team));
    if (teams.size !== 2) return false;
    return b.players.every(p => p.ready);
  }

  function start(battleId) {
    const b = get(battleId);
    if (!b || b.status !== 'waiting') return null;
    if (!allReady(b)) {
      pushLog(b, '모든 플레이어가 준비되면 시작할 수 있습니다', 'notice');
      touch(b);
      return null;
    }
    b.status = 'active';
    b.round = 1;

    // ✅ 하드리밋: "전투 시작 시점"부터 1시간
    b.hardLimitAt = now() + 60 * 60 * 1000;

    // 선공 결정: 팀 평균 민첩 + d10
    const A = b.players.filter(p => p.team === 'A');
    const B = b.players.filter(p => p.team === 'B');
    const avgA = A.reduce((s, p) => s + (p.stats?.agility ?? 0), 0) / Math.max(1, A.length);
    const avgB = B.reduce((s, p) => s + (p.stats?.agility ?? 0), 0) / Math.max(1, B.length);
    const rA = d10(), rB = d10();
    const sA = Math.floor(avgA) + rA, sB = Math.floor(avgB) + rB;
    const first = (sA === sB) ? (Math.random() < 0.5 ? 'A' : 'B') : (sA > sB ? 'A' : 'B');

    b.currentTeam   = first;
    b.nextFirstTeam = first;
    b.selectionDone = { A: false, B: false };

    pushLog(b, `선공 결정: A팀(민첩 ${Math.floor(avgA)} + ${rA} = ${sA}) vs B팀(민첩 ${Math.floor(avgB)} + ${rB} = ${sB})`, 'system');
    pushLog(b, `${first}팀이 선공입니다!`, 'system');
    pushLog(b, '전투가 시작되었습니다!', 'system');
    pushLog(b, `${b.round}라운드 시작`, 'system');

    startSelectPhase(b, first);
    touch(b);
    return { b };
  }

  function startSelectPhase(b, team) {
    if (b.status !== 'active') return;
    b.phase = (team === 'A') ? 'A_select' : 'B_select';
    b.currentTeam = team;
    b.choices[team] = [];

    const alive = sortByInitiative(b.players.filter(p => p.team === team && p.hp > 0));
    b.turnCursor = { team, order: alive.map(p => p.id), index: 0, playerId: alive[0]?.id || null };
    b.phaseEndsAt = now() + TEAM_SELECT_MS;

    pushLog(b, `=== ${team}팀 선택 페이즈 시작 ===`, team === 'A' ? 'teamA' : 'teamB');
    touch(b);

    // ✅ 선택 시간 제한(5분) 초과 시 자동 진행(pass)
    const capturedPhase = b.phase;
    setTimeout(() => {
      if (b.status !== 'active') return;
      if (b.phase !== capturedPhase || b.currentTeam !== team) return;

      if (!b.selectionDone[team]) {
        const aliveIds = new Set(b.players.filter(x => x.team === team && x.hp > 0).map(x => x.id));
        const chosenIds = new Set(b.choices[team].map(c => c.playerId));
        for (const id of aliveIds) {
          if (!chosenIds.has(id)) b.choices[team].push({ playerId: id, type: 'pass', targetId: null, raw: {} });
        }
        b.selectionDone[team] = true;
        pushLog(b, `[${team}] 시간 초과 — 자동 진행(pass)`, team === 'A' ? 'teamA' : 'teamB');
        touch(b);
        finishSelectOrNext(b);
      }
    }, TEAM_SELECT_MS + 10);
  }

  // 선택(의도만 저장, 의도 로그만 송출)
  function playerAction(battleId, playerId, action) {
    const b = get(battleId);
    if (!b || b.status !== 'active') return null;
    if (!(b.phase === 'A_select' || b.phase === 'B_select')) return null;

    const p = b.players.find(x => x.id === playerId);
    if (!p || p.hp <= 0) return null;
    const team = teamOf(p);
    if (team !== b.currentTeam) return null;

    // 동일 플레이어 기존 의도 제거 후 갱신
    b.choices[team] = b.choices[team].filter(c => c.playerId !== p.id);

    let target = null;
    if (action?.targetId) target = b.players.find(x => x.id === action.targetId) || null;

    const intent = {
      playerId: p.id,
      type: action?.type, // attack|defend|dodge|item|pass
      targetId: target?.id || null,
      raw: { ...action }
    };
    b.choices[team].push(intent);

    // 의도 로그
    if (intent.type === 'attack') {
      pushLog(b, `→ ${p.name}이(가) ${target?.name ?? '대상'}에게 공격`, team === 'A' ? 'teamA' : 'teamB');
    } else if (intent.type === 'defend') {
      pushLog(b, `→ ${p.name}이(가) 방어를 준비`, team === 'A' ? 'teamA' : 'teamB');
    } else if (intent.type === 'dodge') {
      pushLog(b, `→ ${p.name}이(가) 회피를 준비`, team === 'A' ? 'teamA' : 'teamB');
    } else if (intent.type === 'item') {
      const itemName =
        (intent.raw.item === 'dittany' || intent.raw.item === 'ditany') ? '디터니' :
        (intent.raw.item === 'attackBooster') ? '공격 보정기' :
        (intent.raw.item === 'defenseBooster') ? '방어 보정기' : '아이템';
      const tgtName = intent.raw.targetId ? (b.players.find(x => x.id === intent.raw.targetId)?.name ?? '대상') : '자신/팀원';
      pushLog(b, `→ ${p.name}이(가) ${itemName} 사용 예정 (${tgtName})`, team === 'A' ? 'teamA' : 'teamB');
    } else if (intent.type === 'pass') {
      pushLog(b, `→ ${p.name}이(가) 패스`, team === 'A' ? 'teamA' : 'teamB');
    } else {
      pushLog(b, `→ ${p.name} 행동 선택`, team === 'A' ? 'teamA' : 'teamB');
    }

    // 커서 진행(표시용)
    if (b.turnCursor?.playerId === p.id) {
      b.turnCursor.index++;
      const nextId = b.turnCursor.order[b.turnCursor.index] || null;
      b.turnCursor.playerId = nextId;
    }

    // 완료 판정
    const aliveIds  = new Set(b.players.filter(x => x.team === team && x.hp > 0).map(x => x.id));
    const chosenIds = new Set(b.choices[team].map(c => c.playerId));
    const done = [...aliveIds].every(id => chosenIds.has(id));

    if (done && !b.selectionDone[team]) {
      b.selectionDone[team] = true;
      pushLog(b, `[${team}] ${team}팀 선택 완료`, team === 'A' ? 'teamA' : 'teamB');
      touch(b);
      finishSelectOrNext(b);
    } else {
      touch(b);
    }
    return { b, result: { queued: true } };
  }

  // 선공 팀 → 후공 팀 → 해석
  function finishSelectOrNext(b) {
    if (b.status !== 'active') return;
    if (!(b.phase === 'A_select' || b.phase === 'B_select')) return;

    const first  = b.nextFirstTeam || 'A';
    const second = first === 'A' ? 'B' : 'A';

    if (b.currentTeam === first) {
      if (!b.selectionDone[second]) {
        startSelectPhase(b, second);
        return;
      }
    }
    if (b.selectionDone.A && b.selectionDone.B) startResolve(b);
  }

  function startResolve(b) {
    if (b.status !== 'active') return;
    b.phase = 'resolve';
    b.currentTeam = null;
    b.turnCursor = null;
    b.phaseEndsAt = now() + RESOLVE_WINDOW_MS;

    pushLog(b, '라운드 해석', 'result');
    touch(b);

    const first  = b.nextFirstTeam || 'A';
    const second = first === 'A' ? 'B' : 'A';

    const allIntents = [...(b.choices.A || []), ...(b.choices.B || [])];

    // ✅ 방어/회피/방어보정기 '최초 1회' 적용 제어용(라운드 단위)
    const once = {
      dodgeTried: new Set(),      // targetId: 첫 회피 판정 시도 여부(성공/실패 불문)
      defendTried: new Set(),     // targetId: 첫 방어 판정 시도 여부(성공/실패 불문)
      defBoostApplied: new Set(), // targetId: 방어보정 배수 사용 여부(첫 방어 1회만)
    };

    // 방어 보정기 예정자 집합(의도로 방어를 선택한 경우에만 의미 있게 적용)
    const defBoostIntended = new Set();

    // 아이템 선처리: 소비 + 즉시효과(치유/공격보정 즉시공격/방어보정 '준비')
    for (const it of allIntents) {
      if (it.type !== 'item') continue;
      const actor = b.players.find(p => p.id === it.playerId);
      if (!actor || actor.hp <= 0) continue;
      const kind = it.raw?.item;

      if (kind === 'dittany' || kind === 'ditany') {
        if ((actor.items.dittany ?? 0) > 0) {
          actor.items.dittany -= 1;
          const tgt = it.raw?.targetId ? (b.players.find(p => p.id === it.raw.targetId) || actor) : actor;
          if (tgt.hp > 0) {
            const heal = 10; // 고정 10
            tgt.hp = Math.min(tgt.maxHp, tgt.hp + heal);
            pushLog(b, `→ ${actor.name}이(가) 디터니 사용 — ${tgt.name} HP +${heal} → HP ${tgt.hp}`, 'result');
          }
        } else {
          pushLog(b, `→ ${actor.name}이(가) 디터니 사용 실패(재고 없음)`, 'result');
        }
      } else if (kind === 'defenseBooster') {
        if ((actor.items.defenseBooster ?? 0) > 0) {
          actor.items.defenseBooster -= 1;
          const hasDefend = allIntents.some(c => c.playerId === actor.id && c.type === 'defend');
          if (hasDefend) {
            defBoostIntended.add(actor.id);
            pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용 — 방어 강화(첫 피격 1회)`, 'result');
          } else {
            if (!it.raw?.targetId || it.raw.targetId === actor.id) {
              defBoostIntended.add(actor.id);
              pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용 — 방어 강화(자기 적용, 첫 피격 1회)`, 'result');
            } else {
              pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용(방어 의도 없음)`, 'result');
            }
          }
        } else {
          pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용 실패(재고 없음)`, 'result');
        }
      } else if (kind === 'attackBooster') {
        if ((actor.items.attackBooster ?? 0) > 0) {
          actor.items.attackBooster -= 1;
          const tgt = it.raw?.targetId ? (b.players.find(p => p.id === it.raw.targetId) || null) : null;
          if (tgt && tgt.hp > 0) {
            resolveSingleAttack(b, actor, tgt, /*useAtkBoost*/true, defBoostIntended, allIntents, once);
          } else {
            pushLog(b, `→ ${actor.name}이(가) 공격 보정기 사용(대상 부재)`, 'result');
          }
        } else {
          pushLog(b, `→ ${actor.name}이(가) 공격 보정기 사용 실패(재고 없음)`, 'result');
        }
      }
    }

    // 선/후 팀 순으로 의도 실행(일반 공격/방어/회피/패스)
    resolveTeamByOrder(b, first,  defBoostIntended, allIntents, once);
    resolveTeamByOrder(b, second, defBoostIntended, allIntents, once);

    // 라운드 종료(오버레이 헤더)
    pushLog(b, `=== ${b.round}라운드 종료 ===`, 'result');

    // ✅ 해석 오버레이 표시 시간 보장 후, 종료/다음 라운드 판정
    const finalize = () => {
      if (b.status !== 'active') return;

      // 하드리밋: 생존 HP 합산 종료
      if (now() >= b.hardLimitAt) {
        endByHpSum(b);
        touch(b);
        return;
      }

      // 전멸/승부 판정
      if (!bothAlive(b)) {
        const win = teamAlive(b, 'A') ? 'A' : teamAlive(b, 'B') ? 'B' : null;
        if (win) {
          pushLog(b, `${win}팀 승리!`, 'result');
          b.status = 'ended'; b.phase = 'idle'; b.turnCursor = null; b.phaseEndsAt = null;
          touch(b);
          return;
        }
      }

      // 다음 라운드 세팅
      b.round += 1;
      b.nextFirstTeam = (b.nextFirstTeam === 'A') ? 'B' : 'A';
      b.selectionDone = { A: false, B: false };
      b.phase = 'inter';
      b.phaseEndsAt = now() + ROUND_BREAK_MS;
      pushLog(b, '5초 후 다음 라운드 시작...', 'system');
      touch(b);

      setTimeout(() => {
        if (b.status !== 'active') return;
        // 혹시 시스템 시간이 역행/정지한 경우 보정
        if (now() < b.phaseEndsAt) {
          setTimeout(() => {
            if (b.status !== 'active') return;
            pushLog(b, `${b.round}라운드 시작`, 'system');
            startSelectPhase(b, b.nextFirstTeam);
          }, Math.max(0, b.phaseEndsAt - now()));
          return;
        }
        pushLog(b, `${b.round}라운드 시작`, 'system');
        startSelectPhase(b, b.nextFirstTeam);
      }, ROUND_BREAK_MS);
    };

    setTimeout(finalize, RESOLVE_WINDOW_MS);
  }

  // 단일 공격 처리(집중공격 규칙 포함)
  function resolveSingleAttack(b, actor, target, useAtkBoost, defBoostIntended, allIntents, once) {
    if (!actor || !target || actor.hp <= 0 || target.hp <= 0) return;

    // 최종공격력 = 공격 × (보정기면×2) + d10
    const finalAttack = (actor.stats?.attack ?? 0) * (useAtkBoost ? 2 : 1) + d10();

    // 회피: 대상이 'dodge' 선택 + 아직 첫 시도 전이면 1회 판정
    const hasDodgeIntent = allIntents.some(c => c.playerId === target.id && c.type === 'dodge');
    if (hasDodgeIntent && !once.dodgeTried.has(target.id)) {
      once.dodgeTried.add(target.id); // 성공/실패 관계없이 소모
      const dodgeScore = (target.stats?.agility ?? 0) + d10();
      if (dodgeScore >= finalAttack) {
        pushLog(b, `→ ${actor.name}의 공격을 ${target.name}이(가) 회피`, 'result');
        return;
      }
    }

    // 치명타: 행운 기반 최대 10%
    const luck = (actor.stats?.luck ?? 0);
    const critChance = Math.min(0.10, Math.max(0, luck) * 0.02);
    const isCrit = Math.random() < critChance;
    const attackValue = isCrit ? (finalAttack * 2) : finalAttack;

    // 방어: 대상이 'defend' 선택했거나, 자기에게 방어보정기를 쓴 경우를 허용
    const hasDefendIntent = allIntents.some(c => c.playerId === target.id && c.type === 'defend');
    const canDefend = hasDefendIntent || defBoostIntended.has(target.id);
    let damage = attackValue;

    if (canDefend && !once.defendTried.has(target.id)) {
      once.defendTried.add(target.id); // 첫 방어 시도 소모

      // 방어 보정기 배수는 첫 방어 1회만 ×2
      const useDefBoost = defBoostIntended.has(target.id) && !once.defBoostApplied.has(target.id);
      const defMul = useDefBoost ? 2 : 1;
      if (useDefBoost) once.defBoostApplied.add(target.id);

      const defenseValue = (target.stats?.defense ?? 0) * defMul + d10();
      damage = Math.max(1, attackValue - defenseValue);
    }
    // 두 번째 이후의 공격은 방어/보정기 적용 없음(정면 피해)

    target.hp = clamp(target.hp - damage, 0, target.maxHp);
    pushLog(b, `→ ${actor.name}이(가) ${target.name}에게 ${isCrit ? '치명타 ' : ''}공격 (피해 ${damage}) → HP ${target.hp}`, 'result');
  }

  // 팀 해석(이니시 순) – attack/defend/dodge/pass
  function resolveTeamByOrder(b, team, defBoostIntended, allIntents, once) {
    const intents = (b.choices[team] || []).slice();
    if (!intents.length) return;

    const order = sortByInitiative(
      intents.map(c => b.players.find(p => p.id === c.playerId)).filter(Boolean)
    ).map(p => p.id);

    for (const pid of order) {
      const intent = intents.find(c => c.playerId === pid);
      if (!intent) continue;

      const actor = b.players.find(p => p.id === pid);
      if (!actor || actor.hp <= 0) continue;

      if (intent.type === 'attack') {
        const tgt = intent.targetId ? b.players.find(p => p.id === intent.targetId) : null;
        if (tgt && tgt.hp > 0)
          resolveSingleAttack(b, actor, tgt, /*useAtkBoost*/false, defBoostIntended, allIntents, once);
      } else if (intent.type === 'defend') {
        pushLog(b, `→ ${actor.name}이(가) 방어 태세`, 'result');
      } else if (intent.type === 'dodge') {
        pushLog(b, `→ ${actor.name}이(가) 회피 태세`, 'result');
      } else if (intent.type === 'item') {
        // 아이템은 이미 위에서 처리/소비됨
      } else if (intent.type === 'pass') {
        pushLog(b, `→ ${actor.name}이(가) 행동을 생략`, 'result');
      }
    }
    b.choices[team] = [];
  }

  // 1시간 종료 시 HP 합산 승부
  function endByHpSum(b) {
    const sumA = b.players.filter(p => p.team === 'A' && p.hp > 0).reduce((s, p) => s + p.hp, 0);
    const sumB = b.players.filter(p => p.team === 'B' && p.hp > 0).reduce((s, p) => s + p.hp, 0);
    pushLog(b, `시간 종료 — 생존 HP 합산: A=${sumA}, B=${sumB}`, 'result');
    if (sumA === sumB) pushLog(b, '무승부 처리', 'result');
    else pushLog(b, `${sumA > sumB ? 'A' : 'B'}팀 승리!`, 'result');
    b.status = 'ended'; b.phase = 'idle'; b.turnCursor = null; b.phaseEndsAt = null;
  }

  function end(battleId) {
    const b = get(battleId); if (!b) return null;
    b.status = 'ended'; b.phase = 'idle'; b.turnCursor = null; b.phaseEndsAt = null;
    touch(b);
    return b;
  }

  function authByToken(battleId, token) {
    const b = get(battleId); if (!b) return null;
    return b.players.find(p => p.token === token) || null;
  }

  return {
    setLogger, setUpdate,
    size, get, snapshot,
    create, addPlayer, removePlayer,
    markReady, start, playerAction,
    end, authByToken,
  };
}
