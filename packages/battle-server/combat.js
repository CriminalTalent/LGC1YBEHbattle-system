// packages/battle-server/combat.js
// PYXIS Combat Resolver (ESM) - D10/60% 성공률/완전 수정판
//
// 최종 적용된 룰
// - 모든 주사위 D10(1~10)
// - 공격/방어 보정기 성공률 60%
// - 치명타: D10 ≥ (10 - luck/2)
// - 방어보정기: 해당 '턴'에 방어(defend)했을 때만 효과 부여
// - attack_boost: 성공 시 그 즉시 1회 공격(공격력 ×2 + d10)
//
// 지원 액션: attack, defend, dodge, item, pass
// 호환: attack_boost/defense_boost 와 attackBooster/defenseBooster 모두 인식

/* =========================
 * 유틸
 * ========================= */
function d10() { return Math.floor(Math.random() * 10) + 1; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

function readStats(p){
  const s = p?.stats || {};
  const cv = (v, d)=> clamp(Number.isFinite(+v)? Math.floor(+v): d, 1, 5);
  return {
    attack:  cv(s.attack, 3),
    defense: cv(s.defense, 3),
    agility: cv(s.agility, 3),
    luck:    cv(s.luck,   2),
  };
}

function ensureEffects(battle) {
  if (!Array.isArray(battle.effects)) battle.effects = [];
}

/* 탐색 */
function findAny(battle, id) {
  return (battle.players || []).find(p => p && p.id === id) || null;
}
function findAlive(battle, id) {
  const p = findAny(battle, id);
  return p && p.hp > 0 ? p : null;
}
function findAliveOpponent(battle, actor) {
  const opponents = (battle.players || []).filter(p => 
    p && p.id !== actor.id && p.team !== actor.team && p.hp > 0
  );
  return opponents[Math.floor(Math.random() * opponents.length)] || null;
}

/* 치명타: D10 ≥ (10 - luck/2) */
function isCrit(luck, roll = null) {
  const r = roll !== null ? roll : d10();
  const threshold = 10 - Math.floor(luck / 2);
  return r >= threshold;
}

/* =========================
 * 방어태세 관리 (라운드별)
 * ========================= */
function getDefendFlatAndConsumeIfAny(battle, playerId) {
  ensureEffects(battle);
  const idx = battle.effects.findIndex(e => 
    e.type === 'defendPosture' && e.playerId === playerId
  );
  if (idx >= 0) {
    const flat = battle.effects[idx].flat || 0;
    battle.effects.splice(idx, 1); // 1회 소모
    return flat;
  }
  return 0;
}

function hasDefendPosture(battle, playerId) {
  ensureEffects(battle);
  return battle.effects.some(e => 
    e.type === 'defendPosture' && e.playerId === playerId
  );
}

function addOrBoostDefendPosture(battle, playerId, boost) {
  ensureEffects(battle);
  const idx = battle.effects.findIndex(e => 
    e.type === 'defendPosture' && e.playerId === playerId
  );
  if (idx >= 0) {
    battle.effects[idx].flat = (battle.effects[idx].flat || 0) + boost;
    return true;
  }
  return false;
}

/* =========================
 * 아이템 관리
 * ========================= */
function getItemCount(items, ...keys) {
  let total = 0;
  for (const k of keys) {
    total += Number(items?.[k] || 0);
  }
  return total;
}

function consumeItem(items, ...keys) {
  for (const k of keys) {
    if ((items?.[k] || 0) > 0) {
      items[k] -= 1;
      return true;
    }
  }
  return false;
}

/* =========================
 * 핵심 액션 해석
 * ========================= */
export function resolveAction(battle, actor, action) {
  const logs = [];
  const updates = { hp: {} };

  if (!actor || actor.hp <= 0) {
    logs.push({ type:"system", message:"사망한 플레이어는 행동할 수 없습니다" });
    return { logs, updates, turnEnded: false };
  }

  ensureEffects(battle);

  const kind = action?.type || 'pass';
  const targetId = action?.targetId || null;

  // 패스
  if (kind === "pass") {
    logs.push({ type:"battle", message:`${actor.name} 패스` });
    return { logs, updates, turnEnded: true };
  }

  // 방어 태세
  if (kind === "defend") {
    // +2 방어태세 부여
    battle.effects.push({
      type: 'defendPosture',
      playerId: actor.id,
      flat: 2
    });
    logs.push({ type:"battle", message:`${actor.name} 방어 태세` });
    return { logs, updates, turnEnded: true };
  }

  // 회피 태세
  if (kind === "dodge") {
    battle.effects.push({
      type: 'dodgePosture', 
      playerId: actor.id
    });
    logs.push({ type:"battle", message:`${actor.name} 회피 태세` });
    return { logs, updates, turnEnded: true };
  }

  // 아이템 사용
  if (kind === "item") {
    const item = action?.item || '';
    const inv = actor.items || {};

    const key = item === "dittany" ? "dittany" :
                item === "ditany" ? "dittany" :
                item === "attackBooster" ? "attack_boost" :
                item === "attack_boost" ? "attack_boost" :
                item === "defenseBooster" ? "defense_boost" :
                item === "defense_boost" ? "defense_boost" :
                null;

    if (key === "dittany") {
      if (getItemCount(inv, 'dittany', 'ditany') <= 0) {
        logs.push({ type:"system", message:"디터니가 없습니다" });
        return { logs, updates, turnEnded: true };
      }
      consumeItem(inv, 'dittany', 'ditany');

      const target = targetId ? findAny(battle, targetId) : actor;
      if (!target) {
        logs.push({ type:"system", message:"디터니 대상이 없습니다 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }
      if (target.hp <= 0) {
        logs.push({ type:"system", message:"사망자에게는 디터니를 사용할 수 없습니다 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }

      const oldHp = target.hp;
      target.hp = clamp(target.hp + 10, 0, target.maxHp || 100);
      updates.hp[target.id] = target.hp;

      logs.push({
        type:"item",
        message:`${actor.name}이(가) ${target.name}에게 디터니 사용 (+${target.hp - oldHp}) → HP ${target.hp}`
      });
      return { logs, updates, turnEnded: true };
    }

    if (key === "attack_boost") {
      if (getItemCount(inv, 'attack_boost', 'attackBooster') <= 0) {
        logs.push({ type:"system", message:"공격 보정기가 없습니다" });
        return { logs, updates, turnEnded: true };
      }
      consumeItem(inv, 'attack_boost', 'attackBooster');

      if (!targetId) {
        logs.push({ type:"system", message:"공격 보정기는 적 대상이 필요합니다 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }
      const target = findAny(battle, targetId);
      if (!target || target.team === actor.team || target.hp <= 0) {
        logs.push({ type:"system", message:"올바른 적 대상을 선택하세요 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }

      // 성공 60%
      const success = Math.random() < 0.60;
      if (!success) {
        logs.push({ type:"item", message:`공격 보정기 실패 (아이템 소모됨)` });
        return { logs, updates, turnEnded: true };
      }

      // 즉시 1회 '보정 공격': 공격력 ×2 + d10, 회피 판정 없음
      const as = readStats(actor);
      const ds = readStats(target);

      const atkRoll = d10();
      const attackScore = Math.floor(as.attack * 2) + atkRoll;

      // 방어태세 가산 적용(있으면) + 기본 방어력
      const defendFlat = getDefendFlatAndConsumeIfAny(battle, target.id);
      const defenseValue = ds.defense + defendFlat;

      let raw = attackScore - defenseValue;
      if (isCrit(as.luck, atkRoll)) raw *= 2;

      const dmg = Math.max(0, raw);
      const oldHp = target.hp;
      target.hp = clamp(oldHp - dmg, 0, target.maxHp||100);
      updates.hp[target.id] = target.hp;

      logs.push({
        type:"item",
        message:`공격 보정기 성공! ${actor.name} → ${target.name} ${dmg} 피해${defendFlat?` / 방어태세 +${defendFlat}`:''}`
      });
      return { logs, updates, turnEnded: true };
    }

    if (key === "defense_boost") {
      if (getItemCount(inv, 'defense_boost', 'defenseBooster') <= 0) {
        logs.push({ type:"system", message:"방어 보정기가 없습니다" });
        return { logs, updates, turnEnded: true };
      }
      consumeItem(inv, 'defense_boost', 'defenseBooster');

      // "해당 턴 방어했을 때만" 사용 가능(효과 부여)
      if (!hasDefendPosture(battle, actor.id)) {
        logs.push({ type:"item", message:"방어하지 않은 턴에는 방어 보정기를 사용할 수 없습니다 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }

      const success = Math.random() < 0.60;
      if (!success) {
        logs.push({ type:"item", message:"방어 보정기 실패 (아이템 소모됨)" });
        return { logs, updates, turnEnded: true };
      }

      // 현재 보유한 방어태세에 +2 추가
      const ok = addOrBoostDefendPosture(battle, actor.id, 2);
      if (ok) logs.push({ type:"item", message:`방어 보정기 성공: 이번 방어태세 +2 추가` });
      else logs.push({ type:"item", message:`방어 보정기 사용 조건 불일치(내부 상태)` });
      return { logs, updates, turnEnded: true };
    }

    logs.push({ type:"system", message:"지원하지 않는 아이템" });
    return { logs, updates, turnEnded: true };
  }

  // 일반 공격(회피 없음)
  if (kind === "attack") {
    let target = null;
    if (targetId) {
      const c = findAny(battle, targetId);
      target = (c && c.hp > 0 && c.team !== actor.team) ? c : null;
    }
    if (!target) target = findAliveOpponent(battle, actor);
    if (!target) {
      logs.push({ type:"system", message:"공격 대상이 없음" });
      return { logs, updates, turnEnded:true };
    }

    const as = readStats(actor);
    const ds = readStats(target);

    const atkRoll = d10();
    const attackScore = as.attack + atkRoll;

    // 방어태세 가산 적용(있으면) + 기본 방어력
    const defendFlat = getDefendFlatAndConsumeIfAny(battle, target.id);
    const defenseValue = ds.defense + defendFlat;

    let raw = attackScore - defenseValue;
    if (isCrit(as.luck, atkRoll)) raw *= 2;

    const dmg = Math.max(0, raw);
    const oldHp = target.hp;
    target.hp = clamp(oldHp - dmg, 0, target.maxHp||100);
    updates.hp[target.id] = target.hp;

    logs.push({
      type:"battle",
      message:`${actor.name} → ${target.name} ${dmg} 피해${defendFlat?` / 방어태세 +${defendFlat}`:''}`
    });
    return { logs, updates, turnEnded:true };
  }

  // 그 외
  logs.push({ type:"system", message:"알 수 없는 행동" });
  return { logs, updates, turnEnded:false };
}

export default { resolveAction };
