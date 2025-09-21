// packages/battle-server/src/engine/dice.js
// 주사위 모듈 - D10과 D20 지원
// (오탈자/문법/중복 점검만 수행, 로직/흐름 변경 없음)

 /**
  * D10 주사위 굴리기 (1-10)
  * @returns {number} 1부터 10까지의 랜덤 숫자
  */
export function d10() {
  return Math.floor(Math.random() * 10) + 1;
}

/**
 * D20 주사위 굴리기 (1-20) - 전투 계산용
 * @returns {number} 1부터 20까지의 랜덤 숫자
 */
export function d20() {
  return Math.floor(Math.random() * 20) + 1;
}

/**
 * D6 주사위 굴리기 (1-6) - 기본 주사위
 * @returns {number} 1부터 6까지의 랜덤 숫자
 */
export function d6() {
  return Math.floor(Math.random() * 6) + 1;
}

/**
 * 일반적인 주사위 굴리기
 * @param {number} sides - 주사위 면 수 (기본값: 6)
 * @returns {number} 1부터 sides까지의 랜덤 숫자
 */
export function dice(sides = 6) {
  if (sides <= 0) return 1;
  return Math.floor(Math.random() * sides) + 1;
}

/**
 * 여러 주사위 굴리기
 * @param {number} count - 주사위 개수 (기본값: 1)
 * @param {number} sides - 주사위 면 수 (기본값: 6)
 * @returns {number[]} 각 주사위 결과가 담긴 배열
 */
export function roll(count = 1, sides = 6) {
  if (count <= 0) return [1];
  if (sides <= 0) return Array(count).fill(1);

  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(dice(sides));
  }
  return results;
}

/**
 * 여러 주사위 굴리고 합계 반환
 * @param {number} count - 주사위 개수 (기본값: 1)
 * @param {number} sides - 주사위 면 수 (기본값: 6)
 * @returns {number} 모든 주사위 결과의 합
 */
export function rollSum(count = 1, sides = 6) {
  return roll(count, sides).reduce((sum, val) => sum + val, 0);
}

/**
 * 주사위 굴리고 가장 높은 값 반환
 * @param {number} count - 주사위 개수 (기본값: 1)
 * @param {number} sides - 주사위 면 수 (기본값: 6)
 * @returns {number} 가장 높은 주사위 결과
 */
export function rollMax(count = 1, sides = 6) {
  return Math.max(...roll(count, sides));
}

/**
 * 주사위 굴리고 가장 낮은 값 반환
 * @param {number} count - 주사위 개수 (기본값: 1)
 * @param {number} sides - 주사위 면 수 (기본값: 6)
 * @returns {number} 가장 낮은 주사위 결과
 */
export function rollMin(count = 1, sides = 6) {
  return Math.min(...roll(count, sides));
}

/**
 * 확률 체크 (백분율)
 * @param {number} percent - 성공 확률 (0-100)
 * @returns {boolean} 성공 여부
 */
export function chance(percent) {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return Math.random() * 100 < percent;
}

/**
 * 동전 던지기
 * @returns {boolean} true면 앞면, false면 뒷면
 */
export function coinFlip() {
  return Math.random() < 0.5;
}

/**
 * 배열에서 무작위 요소 선택
 * @param {Array} array - 선택할 배열
 * @returns {*} 무작위로 선택된 요소
 */
export function randomChoice(array) {
  if (!Array.isArray(array) || array.length === 0) return null;
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * 범위 내에서 무작위 정수 생성
 * @param {number} min - 최솟값 (포함)
 * @param {number} max - 최댓값 (포함)
 * @returns {number} min과 max 사이의 무작위 정수
 */
export function randomInt(min, max) {
  min = Math.floor(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 범위 내에서 무작위 실수 생성
 * @param {number} min - 최솟값 (포함)
 * @param {number} max - 최댓값 (미포함)
 * @returns {number} min과 max 사이의 무작위 실수
 */
export function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * 가중치가 있는 무작위 선택
 * @param {Object.<string, number>} weights - {값: 가중치} 형태의 객체
 * @returns {string|null} 가중치에 따라 선택된 값
 */
export function weightedChoice(weights) {
  const entries = Object.entries(weights);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);

  if (totalWeight <= 0) return null;

  let random = Math.random() * totalWeight;

  for (const [value, weight] of entries) {
    random -= weight;
    if (random <= 0) {
      return value;
    }
  }

  return entries[entries.length - 1][0];
}

/**
 * 주사위 결과 시뮬레이션 (테스트용)
 * @param {Function} diceFunc - 주사위 함수
 * @param {number} [iterations=10000] - 시뮬레이션 횟수
 * @returns {{total:number, results:Object, average:number}} 결과 통계
 */
export function simulate(diceFunc, iterations = 10000) {
  const results = {};

  for (let i = 0; i < iterations; i++) {
    const result = diceFunc();
    results[result] = (results[result] || 0) + 1;
  }

  const average =
    Object.entries(results).reduce((sum, [val, count]) => sum + (parseInt(val, 10) * count), 0) /
    iterations;

  return {
    total: iterations,
    results,
    average,
  };
}
