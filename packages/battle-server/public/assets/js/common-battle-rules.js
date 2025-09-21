// packages/battle-server/public/assets/js/common-battle-rules.js
// PYXIS 공통 전투 룰 (브라우저) - D10 + 60% 성공률 적용판
// - 스탯: 각 1~5 / HP 최대 100
// - 아이템(1회용)
//    • 공격 보정기: 60% 성공 → 해당 '공격 시도 1회'에 한해 공격력 ×2 로 계산
//    • 방어 보정기: 60% 성공 → '다음 피격 1회' 방어력 ×2 로 계산
//    • 디터니(ditany): +10 HP(즉시)
// - 치명타: D10 ≥ (10 - luck/2) → 최종 피해 ×2
// - 방어: 피해 = max(0, (공격치 - 방어치) × (치명타?2:1))
// - 회피: 수비측 (민첩 + D10) ≥ 공격치 → 피해 0

;(function initPyxisRules (root) {
  const RULES = {
    ATK_BOOSTER_SUCCESS: 0.60,  // 60% 성공률
    DEF_BOOSTER_SUCCESS: 0.60,  // 60% 성공률
    DEF_MULT_ON_HIT: 2,         // 방어 보정기 성공 시, 다음 피격 1회 방어력 ×2
    MAX_HP: 100
  };

  // ---------- 유틸 ----------
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function rollD10() { return Math.floor(Math.random() * 10) + 1; }  // D10으로 변경
  function toInt(v, fb=0){ const n = parseInt(v,10); return Number.isNaN(n)?fb:n; }

  // ---------- 스탯 읽기 ----------
  function readStats(entity) {
    const s = entity?.stats || entity || {};
    const attack  = clamp(toInt(s.attack  ?? s.atk, 3), 1, 5);
    const defense = clamp(toInt(s.defense ?? s.def, 3), 1, 5);
    const agility = clamp(toInt(s.agility ?? s.dex, 3), 1, 5);
    const luck    = clamp(toInt(s.luck    ?? s.luk, 2), 1, 5);
    return { attack, defense, agility, luck };
  }

  // ---------- 크리티컬 (D10 기준) ----------
  function isCritical(attackerLuck) {
    const th = 10 - Math.floor(attackerLuck / 2);  // D10 기준으로 변경
    const d  = rollD10();  // D10 사용
    return { crit: d >= th, roll: d, threshold: th };
  }

  // ---------- 아이템 판정 ----------
  function tryAttackBooster() {
    const ok = Math.random() < RULES.ATK_BOOSTER_SUCCESS;  // 60% 성공률
    return { success: ok, mult: ok ? 2 : 1 }; // 공격력 ×2(그 행동 1회)
  }

  function tryDefenseBooster() {
    const ok = Math.random() < RULES.DEF_BOOSTER_SUCCESS;  // 60% 성공률
    return { success: ok, mult: ok ? RULES.DEF_MULT_ON_HIT : 1 }; // 다음 피격 1회 방어력 ×2
  }

  // 철자 통일: ditany (+10 HP)
  function useDitany(hp, maxHp = RULES.MAX_HP) {
    return clamp(hp + 10, 0, maxHp);
  }
  // 이전 이름 호환
  const useDittany = useDitany;

  // ---------- 수치 계산 ----------
  // 공격 수치 = (공격 스탯 × (공보 성공?2:1)) + D10
  function computeAttackScore(attacker, { useAtkBooster=false }={}) {
    const { attack, luck } = readStats(attacker);
    const roll = rollD10();  // D10 사용
    let atkStat = attack;
    let booster = { success:false, mult:1 };
    if (useAtkBooster) {
      booster = tryAttackBooster();
      atkStat = Math.floor(atkStat * booster.mult);
    }
    const score = atkStat + roll;
    const { crit } = isCritical(luck);
    return { score, roll, crit, boosterUsed: !useAtkBooster, boosterSuccess: booster.success };
  }

  // 방어 수치 = (방어 스탯 × defenseMult)
  function computeDefenseValue(defender, { defenseMult=1 }={}) {
    const { defense } = readStats(defender);
    return { value: Math.floor(defense * (defenseMult || 1)) };
  }

  // ---------- 해석 ----------
  // 방어 해석: damage = max(0, (atkScore - defValue) × (crit?2:1))
  // opts.useAtkBooster: 공격 보정기 사용 여부
  // opts.defenseMult: 방어 보정기 성공 시 2(그 외 1)
  function resolveDefense(attacker, defender, opts={}) {
    const atk = computeAttackScore(attacker, { useAtkBooster: !!opts.useAtkBooster });
    const defMult = opts.defenseMult || 1; // 방어 보정기 성공 시 2
    const def = computeDefenseValue(defender, { defenseMult: defMult });

    let raw = atk.score - def.value;
    if (atk.crit) raw *= 2;

    const damage = Math.max(0, raw);
    return {
      damage,
      defended: damage === 0,
      attackDetail: atk,
      defenseDetail: { ...def, mult: defMult }
    };
  }

  // 회피: (민첩 + D10) ≥ atk.score → 0
  // 디자인상 회피 선택 시 방어 수치/보정기는 적용되지 않음(실패해도 미적용).
  function resolveDodge(attacker, defender, opts={}) {
    const atk = computeAttackScore(attacker, { useAtkBooster: !!opts.useAtkBooster });
    const { agility } = readStats(defender);
    const dodgeRoll = rollD10();  // D10 사용
    const dodgeScore = agility + dodgeRoll;
    const dodged = dodgeScore >= atk.score;

    let damage = 0;
    if (!dodged) {
      let raw = atk.score;
      if (atk.crit) raw *= 2;
      damage = Math.max(0, raw);
    }
    return { damage, dodged, attackDetail: atk, dodgeRoll, dodgeScore };
  }

  // (선택) 명중 판정 유틸
  function optionalHitCheck(attacker, defender) {
    const { luck } = readStats(attacker);
    const { agility } = readStats(defender);
    const hitRoll = rollD10();    // D10 사용
    const dodgeRoll = rollD10();  // D10 사용
    const hitScore = luck + hitRoll;
    const dodgeScore = agility + dodgeRoll;
    const hit = hitScore > dodgeScore;
    return { hit, hitScore, dodgeScore, hitRoll, dodgeRoll };
  }

  // 팀 선공(팀원 각각 민첩+D10 합산)
  function computeTeamInitiative(teamPlayers=[]) {
    let total = 0;
    const breakdown = [];
    teamPlayers.forEach(p=>{
      const { agility } = readStats(p);
      const r = rollD10();  // D10 사용
      total += agility + r;
      breakdown.push({ name: p?.name || '', agility, roll: r, sum: agility + r });
    });
    return { total, breakdown };
  }

  // HP 적용
  function applyDamage(hp, damage, maxHp = RULES.MAX_HP) {
    return clamp(hp - Math.max(0, damage|0), 0, maxHp);
  }
  function applyHeal(hp, heal, maxHp = RULES.MAX_HP) {
    return clamp(hp + Math.max(0, heal|0), 0, maxHp);
  }

  // ---------- 공개 API ----------
  const API = {
    RULES,
    rollD10,           // rollD20 → rollD10으로 변경
    readStats,
    isCritical,
    tryAttackBooster,
    tryDefenseBooster, // 성공 시 mult:2 (다음 피격 1회 방어력 ×2)
    useDitany,         // 표준 표기
    useDittany,        // 이전 이름 호환
    computeAttackScore,
    computeDefenseValue, // 방어력 × defenseMult
    resolveDefense,
    resolveDodge,
    optionalHitCheck,
    computeTeamInitiative,
    applyDamage,
    applyHeal,
  };

  root.PYXIS_RULES = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
