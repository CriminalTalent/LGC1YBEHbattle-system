/* ESM BattleEngine
 * - 선택 페이즈: '의도 로그'만 송출
 * - 해석 페이즈(resolve): 수치 적용 + '결과 로그' 일괄 송출
 * - 팀당 선택 제한: 5분
 * - 선후공: 라운드마다 교대
 * - 팀 내부 실행 순서: 민첩 내림차순, 동률 시 이름 오름차순(ABC)
 * - 전투 하드리밋: 1시간 (시간 종료 시 생존 HP 합산 승자)
 * - 아이템: 1회용(디터니 고정10, 공격 보정기 1회 강화공격, 방어 보정기 방어×2)
 * - 회피/방어는 '선택했을 때만' 적용 (자동 없음)
 */

import { randomUUID } from 'node:crypto';

const now = () => Date.now();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const TEAM_SELECT_MS   = 5 * 60 * 1000; // 팀당 5분
const ROUND_BREAK_MS   = 5_000;         // 라운드 간 5초
const RESOLVE_WINDOW_MS= 3_000;         // 해석 표시용

const d10 = () => 1 + Math.floor(Math.random() * 10);
const teamOf = (p) => (p?.team === 'B' ? 'B' : 'A');

function sortByInitiative(players) {
  return [...players].sort((a, b) => {
    const ag = (b.stats?.agility ?? 0) - (a.stats?.agility ?? 0);
    if (ag !== 0) return ag;
    return (a.name || '').localeCompare((b.name || ''), 'ko-KR');
  });
}

export function createBattleStore() {
  const battles = new Map();

  let onLog = null;     // (battleId, entry)
  let onUpdate = null;  // (battleId) => void
  const setLogger = fn => { onLog = typeof fn === 'function' ? fn : null; };
  const setUpdate = fn => { onUpdate = typeof fn === 'function' ? fn : null; };

  const pushLog = (b, message, type='system') => {
    const entry = { ts: now(), type, message };
    b.logs.push(entry);
    if (onLog) onLog(b.id, entry);
  };
  const touch = b => { if (onUpdate) onUpdate(b.id); };

  const size = () => battles.size;
  const get  = id => battles.get(id) || null;

  function snapshot(id) {
    const b = battles.get(id);
    if (!b) return null;
    const timeLeftSec = Math.max(0, Math.ceil(((b.phaseEndsAt || now()) - now())/1000));
    const currentPlayer = b.turnCursor?.playerId
      ? b.players.find(p=>p.id===b.turnCursor.playerId) || null
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

  const teamAlive = (b, t) => b.players.some(p => p.team===t && p.hp>0);
  const bothAlive = (b) => teamAlive(b,'A') && teamAlive(b,'B');

  function create(mode='2v2') {
    const id = randomUUID();
    const b = {
      id, mode,
      status: 'waiting',         // waiting|active|paused|ended
      phase: 'idle',             // idle|A_select|B_select|resolve|inter
      round: 0,
      currentTeam: null,
      nextFirstTeam: null,
      selectionDone: { A:false, B:false },
      players: [],
      choices: { A:[], B:[] },
      logs: [],
      createdAt: now(),
      hardLimitAt: now() + 60*60*1000, // 1시간
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
      name: player.name || `P${b.players.length+1}`,
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
    const idx = b.players.findIndex(p=>p.id===playerId);
    if (idx === -1) return false;
    b.players.splice(idx,1);
    ['A','B'].forEach(t => { b.choices[t] = b.choices[t].filter(c=>c.playerId!==playerId); });
    touch(b);
    return true;
  }

  function markReady(battleId, playerId, ready=true) {
    const b = get(battleId); if (!b) return false;
    const p = b.players.find(x=>x.id===playerId); if (!p) return false;
    p.ready = !!ready;
    pushLog(b, `${p.name}이(가) 준비 완료했습니다`, 'system');
    touch(b);
    return true;
  }

  function allReady(b) {
    const teams = new Set(b.players.map(p=>p.team));
    if (teams.size !== 2) return false;
    return b.players.every(p=>p.ready);
  }

  function start(battleId) {
    const b = get(battleId);
    if (!b || b.status!=='waiting') return null;
    if (!allReady(b)) {
      pushLog(b, '모든 플레이어가 준비되면 시작할 수 있습니다', 'notice');
      touch(b);
      return null;
    }
    b.status = 'active';
    b.round = 1;

    // 선공 결정: 팀 평균 민첩 + d10
    const A = b.players.filter(p=>p.team==='A');
    const B = b.players.filter(p=>p.team==='B');
    const avgA = A.reduce((s,p)=>s+(p.stats?.agility ?? 0),0)/Math.max(1,A.length);
    const avgB = B.reduce((s,p)=>s+(p.stats?.agility ?? 0),0)/Math.max(1,B.length);
    const rA = d10(), rB = d10();
    const sA = Math.floor(avgA)+rA, sB = Math.floor(avgB)+rB;
    const first = (sA===sB) ? (Math.random()<0.5?'A':'B') : (sA>sB?'A':'B');

    b.currentTeam   = first;
    b.nextFirstTeam = first;
    b.selectionDone = {A:false,B:false};

    pushLog(b, `선공 결정: A팀(민첩 ${Math.floor(avgA)} + ${rA} = ${sA}) vs B팀(민첩 ${Math.floor(avgB)} + ${rB} = ${sB})`, 'system');
    pushLog(b, `${first}팀이 선공입니다!`, 'system');
    pushLog(b, '전투가 시작되었습니다!', 'system');
    pushLog(b, `${b.round}라운드 시작`, 'system');

    startSelectPhase(b, first);
    touch(b);
    return { b };
  }

  function startSelectPhase(b, team) {
    if (b.status!=='active') return;
    b.phase = (team==='A') ? 'A_select' : 'B_select';
    b.currentTeam = team;
    b.choices[team] = [];

    const alive = sortByInitiative(b.players.filter(p=>p.team===team && p.hp>0));
    b.turnCursor = { team, order: alive.map(p=>p.id), index:0, playerId: alive[0]?.id || null };
    b.phaseEndsAt = now() + TEAM_SELECT_MS;

    pushLog(b, `=== ${team}팀 선택 페이즈 시작 ===`, team==='A'?'teamA':'teamB');
    touch(b);
  }

  // 선택(의도만 저장, 의도 로그만 송출)
  function playerAction(battleId, playerId, action) {
    const b = get(battleId);
    if (!b || b.status!=='active') return null;
    if (!(b.phase==='A_select' || b.phase==='B_select')) return null;

    const p = b.players.find(x=>x.id===playerId);
    if (!p || p.hp<=0) return null;
    const team = teamOf(p);
    if (team !== b.currentTeam) return null;

    b.choices[team] = b.choices[team].filter(c=>c.playerId!==p.id);

    let target = null;
    if (action?.targetId) target = b.players.find(x=>x.id===action.targetId) || null;

    const intent = {
      playerId: p.id,
      type: action?.type,      // attack|defend|dodge|item|pass
      targetId: target?.id || null,
      raw: { ...action }
    };
    b.choices[team].push(intent);

    // 의도 로그
    if (intent.type==='attack') {
      pushLog(b, `→ ${p.name}이(가) ${target?.name ?? '대상'}에게 공격`, team==='A'?'teamA':'teamB');
    } else if (intent.type==='defend') {
      pushLog(b, `→ ${p.name}이(가) 방어를 준비`, team==='A'?'teamA':'teamB');
    } else if (intent.type==='dodge') {
      pushLog(b, `→ ${p.name}이(가) 회피를 준비`, team==='A'?'teamA':'teamB');
    } else if (intent.type==='item') {
      const itemName =
        (intent.raw.item==='dittany'||intent.raw.item==='ditany') ? '디터니' :
        (intent.raw.item==='attackBooster') ? '공격 보정기' :
        (intent.raw.item==='defenseBooster') ? '방어 보정기' : '아이템';
      const tgtName = intent.raw.targetId ? (b.players.find(x=>x.id===intent.raw.targetId)?.name ?? '대상') : '자신/팀원';
      pushLog(b, `→ ${p.name}이(가) ${itemName} 사용 예정 (${tgtName})`, team==='A'?'teamA':'teamB');
    } else if (intent.type==='pass') {
      pushLog(b, `→ ${p.name}이(가) 패스`, team==='A'?'teamA':'teamB');
    } else {
      pushLog(b, `→ ${p.name} 행동 선택`, team==='A'?'teamA':'teamB');
    }

    // 커서 진행(표시용)
    if (b.turnCursor?.playerId===p.id) {
      b.turnCursor.index++;
      const nextId = b.turnCursor.order[b.turnCursor.index] || null;
      b.turnCursor.playerId = nextId;
    }

    // 완료 판정
    const aliveIds  = new Set(b.players.filter(x=>x.team===team && x.hp>0).map(x=>x.id));
    const chosenIds = new Set(b.choices[team].map(c=>c.playerId));
    const done = [...aliveIds].every(id=>chosenIds.has(id));

    if (done && !b.selectionDone[team]) {
      b.selectionDone[team] = true;
      pushLog(b, `[${team}] ${team}팀 선택 완료`, team==='A'?'teamA':'teamB');
      touch(b);
      finishSelectOrNext(b);
    } else {
      touch(b);
    }
    return { b, result: { queued:true } };
  }

  // 선공 팀 → 후공 팀 → 해석
  function finishSelectOrNext(b) {
    if (b.status!=='active') return;
    if (!(b.phase==='A_select' || b.phase==='B_select')) return;

    const first  = b.nextFirstTeam || 'A';
    const second = first==='A' ? 'B' : 'A';

    if (b.currentTeam === first) {
      if (!b.selectionDone[second]) {
        startSelectPhase(b, second);
        return;
      }
    }
    if (b.selectionDone.A && b.selectionDone.B) startResolve(b);
  }

  function startResolve(b) {
    if (b.status!=='active') return;
    b.phase = 'resolve';
    b.currentTeam = null;
    b.turnCursor = null;
    b.phaseEndsAt = now() + RESOLVE_WINDOW_MS;

    pushLog(b, '라운드 해석', 'result');
    touch(b);

    const first  = b.nextFirstTeam || 'A';
    const second = first==='A' ? 'B' : 'A';

    const allIntents = [...(b.choices.A||[]), ...(b.choices.B||[])];

    // === 1) 아이템 선처리: 회복/방어만 '우선 적용', 공격보정기는 '공격 페이즈'로 이월 ===
    const defBoost = new Set();            // 방어 보정기 적용자(해당 라운드 방어×2)
    const atkBoostMap = new Map();         // playerId -> { targetId }
    for (const it of allIntents) {
      if (it.type !== 'item') continue;
      const actor = b.players.find(p=>p.id===it.playerId);
      if (!actor || actor.hp<=0) continue;
      const kind = it.raw?.item;

      if (kind==='dittany' || kind==='ditany') {
        if ((actor.items.dittany ?? 0) > 0) {
          actor.items.dittany -= 1;
          const tgt = it.raw?.targetId ? (b.players.find(p=>p.id===it.raw.targetId) || actor) : actor;
          if (tgt.hp>0) {
            const heal = 10; // 고정 10
            tgt.hp = Math.min(tgt.maxHp, tgt.hp + heal);
            pushLog(b, `→ ${actor.name}이(가) 디터니 사용 — ${tgt.name} HP +${heal} → HP ${tgt.hp}`, 'result');
          }
        } else {
          pushLog(b, `→ ${actor.name}이(가) 디터니 사용 실패(재고 없음)`, 'result');
        }
      } else if (kind==='defenseBooster') {
        if ((actor.items.defenseBooster ?? 0) > 0) {
          actor.items.defenseBooster -= 1;
          const hasDefend = allIntents.some(c=>c.playerId===actor.id && c.type==='defend');
          if (hasDefend) {
            defBoost.add(actor.id);
            pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용 — 방어 강화`, 'result');
          } else {
            pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용(방어 의도 없음)`, 'result');
          }
        } else {
          pushLog(b, `→ ${actor.name}이(가) 방어 보정기 사용 실패(재고 없음)`, 'result');
        }
      } else if (kind==='attackBooster') {
        // 공격은 '공격 페이즈'에서 처리되도록 큐에 적재 (아이템은 즉시 소모)
        if ((actor.items.attackBooster ?? 0) > 0) {
          actor.items.attackBooster -= 1;
          const tgt = it.raw?.targetId ? (b.players.find(p=>p.id===it.raw.targetId) || null) : null;
          atkBoostMap.set(actor.id, { targetId: tgt?.id || null });
          pushLog(b, `→ ${actor.name}이(가) 공격 보정기 사용 — 강화공격 대기`, 'result');
        } else {
          pushLog(b, `→ ${actor.name}이(가) 공격 보정기 사용 실패(재고 없음)`, 'result');
        }
      }
    }

    // === 2) 비피해 행동(방어/회피) 먼저 확정 로그 ===
    resolveTeamNonDamage(b, first,  allIntents);
    resolveTeamNonDamage(b, second, allIntents);

    // === 3) 공격 페이즈: (a) 강화공격(보정기) → (b) 일반 공격, 둘 다 팀/이니시 순 ===
    resolveTeamBoostedAttacks(b, first,  atkBoostMap, defBoost, allIntents);
    resolveTeamBoostedAttacks(b, second, atkBoostMap, defBoost, allIntents);

    resolveTeamNormalAttacks(b, first,  defBoost, allIntents);
    resolveTeamNormalAttacks(b, second, defBoost, allIntents);

    // 라운드 종료/판정
    pushLog(b, `=== ${b.round}라운드 종료 ===`, 'result');

    if (now() >= b.hardLimitAt) {
      endByHpSum(b); touch(b); return;
    }
    if (!bothAlive(b)) {
      const win = teamAlive(b,'A') ? 'A' : teamAlive(b,'B') ? 'B' : null;
      if (win) {
        pushLog(b, `${win}팀 승리!`, 'result');
        b.status='ended'; b.phase='idle'; b.turnCursor=null; b.phaseEndsAt=null;
        touch(b); return;
      }
    }

    // 다음 라운드 세팅
    b.round += 1;
    b.nextFirstTeam = (b.nextFirstTeam==='A') ? 'B' : 'A';
    b.selectionDone = {A:false,B:false};
    b.phase = 'inter';
    b.phaseEndsAt = now() + ROUND_BREAK_MS;
    pushLog(b, '5초 후 다음 라운드 시작...', 'system');
    touch(b);

    setTimeout(() => {
      if (b.status!=='active') return;
      pushLog(b, `${b.round}라운드 시작`, 'system');
      startSelectPhase(b, b.nextFirstTeam);
    }, 50);
  }

  // === 비피해 행동(방어/회피) 로그만 확정 ===
  function resolveTeamNonDamage(b, team, allIntents) {
    const intents = (b.choices[team] || []).filter(x => x.type==='defend' || x.type==='dodge');
    if (!intents.length) return;
    const order = sortByInitiative(
      intents.map(c => b.players.find(p=>p.id===c.playerId)).filter(Boolean)
    ).map(p=>p.id);

    for (const pid of order) {
      const intent = intents.find(c=>c.playerId===pid);
      const actor = b.players.find(p=>p.id===pid);
      if (!intent || !actor || actor.hp<=0) continue;
      if (intent.type==='defend') pushLog(b, `→ ${actor.name}이(가) 방어 태세`, 'result');
      if (intent.type==='dodge')  pushLog(b, `→ ${actor.name}이(가) 회피 태세`, 'result');
    }
  }

  // === 강화공격(공격 보정기) 먼저 처리 ===
  function resolveTeamBoostedAttacks(b, team, atkBoostMap, defBoostSet, allIntents) {
    const intents = (b.choices[team] || []);
    const boostedActors = intents
      .map(c => b.players.find(p=>p.id===c.playerId))
      .filter(p => p && atkBoostMap.has(p.id) && p.hp>0);

    if (!boostedActors.length) return;

    const order = sortByInitiative(boostedActors).map(p=>p.id);
    for (const pid of order) {
      const actor = b.players.find(p=>p.id===pid);
      const targetId = atkBoostMap.get(pid)?.targetId || null;
      const tgt = targetId ? b.players.find(p=>p.id===targetId) : null;
      if (!actor || actor.hp<=0) continue;
      if (!tgt || tgt.hp<=0) continue;
      resolveSingleAttack(b, actor, tgt, /*useAtkBoost*/true, defBoostSet, allIntents);
    }
    // 한 라운드 사용 종료
    order.forEach(pid => atkBoostMap.delete(pid));
  }

  // === 일반 공격 처리 ===
  function resolveTeamNormalAttacks(b, team, defBoostSet, allIntents) {
    const intents = (b.choices[team] || []).filter(x => x.type==='attack');
    if (!intents.length) return;

    const order = sortByInitiative(
      intents.map(c => b.players.find(p=>p.id===c.playerId)).filter(Boolean)
    ).map(p=>p.id);

    for (const pid of order) {
      const intent = intents.find(c=>c.playerId===pid);
      const actor  = b.players.find(p=>p.id===pid);
      if (!intent || !actor || actor.hp<=0) continue;
      const tgt = intent.targetId ? b.players.find(p=>p.id===intent.targetId) : null;
      if (tgt && tgt.hp>0) resolveSingleAttack(b, actor, tgt, /*useAtkBoost*/false, defBoostSet, allIntents);
    }
    // 소모
    const arr = b.choices[team] || [];
    b.choices[team] = arr.filter(x => x.type!=='attack');
  }

  // 단일 공격 처리: 회피/방어는 '의도했을 때만' 적용 + 치명타 상한 10%
  function resolveSingleAttack(b, actor, target, useAtkBoost, defBoostSet, allIntents) {
    if (!actor || !target || actor.hp<=0 || target.hp<=0) return;

    // 최종공격력 = 공격 × (보정기면×2) + d10
    const finalAttack = (actor.stats?.attack ?? 0) * (useAtkBoost ? 2 : 1) + d10();

    // 회피: 대상이 'dodge' 선택한 경우에만 판정
    const hasDodge = allIntents.some(c => c.playerId===target.id && c.type==='dodge');
    if (hasDodge) {
      const dodgeScore = (target.stats?.agility ?? 0) + d10();
      if (dodgeScore >= finalAttack) {
        pushLog(b, `→ ${actor.name}의 공격을 ${target.name}이(가) 회피`, 'result');
        return;
      }
    }

    // 치명타: 행운 기반 최대 10%
    const luck = (actor.stats?.luck ?? 0);
    const critChance = Math.min(0.10, Math.max(0, luck) * 0.02);
    const crit = Math.random() < critChance;

    const attackValue = crit ? (finalAttack * 2) : finalAttack;

    // 방어: 대상이 'defend' 선택한 경우에만 방어값 차감
    let damage = attackValue;
    const hasDefend = allIntents.some(c => c.playerId===target.id && c.type==='defend');
    if (hasDefend) {
      const defMul = defBoostSet.has(target.id) ? 2 : 1;
      const defenseValue = (target.stats?.defense ?? 0) * defMul + d10();
      damage = Math.max(1, attackValue - defenseValue);
    }

    target.hp = clamp(target.hp - damage, 0, target.maxHp);
    pushLog(b, `→ ${actor.name}이(가) ${target.name}에게 ${crit ? '치명타 ' : ''}공격 (피해 ${damage}) → HP ${target.hp}`, 'result');
  }

  // 1시간 종료 시 HP 합산 승부
  function endByHpSum(b) {
    const sumA = b.players.filter(p=>p.team==='A'&&p.hp>0).reduce((s,p)=>s+p.hp,0);
    const sumB = b.players.filter(p=>p.team==='B'&&p.hp>0).reduce((s,p)=>s+p.hp,0);
    pushLog(b, `시간 종료 — 생존 HP 합산: A=${sumA}, B=${sumB}`, 'result');
    if (sumA===sumB) pushLog(b, '무승부 처리', 'result');
    else pushLog(b, `${sumA>sumB?'A':'B'}팀 승리!`, 'result');
    b.status='ended'; b.phase='idle'; b.turnCursor=null; b.phaseEndsAt=null;
  }

  function end(battleId) {
    const b = get(battleId); if (!b) return null;
    b.status='ended'; b.phase='idle'; b.turnCursor=null; b.phaseEndsAt=null;
    touch(b);
    return b;
  }

  function authByToken(battleId, token) {
    const b = get(battleId); if (!b) return null;
    return b.players.find(p=>p.token===token) || null;
  }

  return {
    setLogger, setUpdate,
    size, get, snapshot,
    create, addPlayer, removePlayer,
    markReady, start, playerAction,
    end, authByToken,
  };
}
