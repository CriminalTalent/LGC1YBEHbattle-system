// packages/battle-server/public/assets/js/player.js
// PYXIS 배틀 시스템 - 플레이어 페이지 (A/B 내부 표기 유지, 화면 표기는 불사조/죽먹자)
// - 팀 표기: 화면에는 '불사조 기사단' / '죽음을 먹는 자' 고정
// - 스냅샷 호환: battle:update / battleUpdate 둘 다, currentTurn 형태 다양성 대응
// - 타이머: 서버 값으로 동기화 후 1초 단위 로컬 감산
// - 알림 연동: window.__PYXIS_PLAYER_ID 설정 + PyxisNotify 사용(있을 때)
// - 이모지/특수문자 사용 금지

(function () {
  'use strict';

  let socket = null;
  let currentBattleId = null;
  let currentPlayerId = null;
  let currentPlayerData = null;
  let battleData = null;
  let connected = false;

  let lastUpdateTime = 0;
  let lastLogMessage = '';
  let lastLogTime = 0;
  let lastChatKey = '';
  let lastChatTime = 0;

  // 타이머
  let timerLeft = 0;
  let timerTick = null;

  // DOM 헬퍼
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => (s == null ? '' : String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  // 팀 표기 (화면용)
  function teamLabelAB(ab) {
    return ab === 'A' ? '불사조 기사단' : ab === 'B' ? '죽음을 먹는 자' : (ab || '');
  }

  // 소켓 초기화
  function initSocket() {
    if (socket && connected) return socket;

    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      timeout: 5000
    });

    socket.on('connect', () => {
      connected = true;
      // 알림 모듈 연결(있으면)
      if (window.PyxisNotify && typeof window.PyxisNotify.init === 'function') {
        window.PyxisNotify.init({ socket, enabled: true, backgroundOnly: true });
      }
    });

    socket.on('disconnect', () => {
      connected = false;
      clearInterval(timerTick);
    });

    // 배틀 업데이트 (중복 방지)
    const handleBattleUpdate = (data) => {
      const now = Date.now();
      if (now - lastUpdateTime < 100) return; // 100ms 내 중복 방지
      lastUpdateTime = now;

      if (data && (data.id || data.battleId)) {
        battleData = normalizeBattleSnapshot(data);
        updateUI(battleData);
      }
    };

    socket.on('battleUpdate', handleBattleUpdate);
    socket.on('battle:update', handleBattleUpdate);

    // 인증 성공(여러 형태 호환)
    const onAuthSuccess = (data = {}) => {
      if (data.ok !== false) {
        currentPlayerId   = data.playerId || data.id || data.player?.id || currentPlayerId;
        currentPlayerData = data.player || data;
        // 알림에서 내 턴 감지용
        window.__PYXIS_PLAYER_ID = currentPlayerId;
      }
    };
    socket.on('authSuccess', onAuthSuccess);
    socket.on('auth:success', onAuthSuccess);

    // 인증 실패
    socket.on('authError', (data = {}) => {
      alert('인증 실패: ' + (data.error || '알 수 없는 오류'));
    });

    // 행동 성공/실패
    const onActionDone = () => disableActionButtons(true); // 성공 후 반복 행동 방지(라운드 전환 시 재활성화)
    const onActionFail = (data = {}) => {
      alert('행동 실패: ' + (data.error || '알 수 없는 오류'));
      disableActionButtons(false);
    };
    socket.on('actionSuccess', onActionDone);
    socket.on('player:action:success', onActionDone);
    socket.on('actionError', onActionFail);

    // 로그 수신 (중복 방지)
    const handleLog = (data = {}) => {
      const now = Date.now();
      const msg = data.message || '';
      if (msg === lastLogMessage && (now - lastLogTime) < 1000) return;
      lastLogMessage = msg;
      lastLogTime = now;
      addLog(data);
    };
    socket.on('battle:log', handleLog);
    socket.on('battleLog', handleLog);

    // 채팅 수신 (중복 방지)
    const handleChat = (data = {}) => {
      const now = Date.now();
      const key = `${data.name || ''}:${data.message || ''}`;
      if (key === lastChatKey && (now - lastChatTime) < 1000) return;
      lastChatKey = key; lastChatTime = now;
      addChat(data);
    };
    socket.on('chatMessage', handleChat);
    socket.on('battle:chat', handleChat);

    // 전투 종료 시 UI 잠금(오버레이가 있다면 그것만 표시)
    const onEnded = () => {
      disableActionButtons(true);
      $('#btnReady') && ($('#btnReady').disabled = true);
      clearInterval(timerTick);
    };
    socket.on('battle:ended', onEnded);
    socket.on('battleEnded', onEnded);

    return socket;
  }

  // 다양한 스냅샷을 안전하게 정규화
  function normalizeBattleSnapshot(b) {
    const id = b.id || b.battleId;
    const status = b.status || 'waiting';
    const players = Array.isArray(b.players) ? b.players : [];
    // currentTurn 정규화
    const ct = b.currentTurn || {};
    const currentPlayer =
      ct.currentPlayer ||
      (ct.playerId && players.find(p => p.id === ct.playerId)) ||
      null;

    const currentTeam =
      ct.currentTeam ||
      (currentPlayer && currentPlayer.team) ||
      (b.phase === 'A_select' ? 'A' : b.phase === 'B_select' ? 'B' : null);

    const timeLeftSec =
      Number.isFinite(ct.timeLeftSec) ? ct.timeLeftSec :
      Number.isFinite(b.timeLeftSec)  ? b.timeLeftSec :
      0;

    const phase =
      ct.phase || b.phase || 'waiting';

    const turnNumber =
      ct.turnNumber || b.turnNumber || 0;

    return {
      id, status, players,
      currentTurn: { currentPlayer, currentTeam, timeLeftSec, phase, turnNumber },
      phase // 루트에도 남아 있을 수 있어 유지
    };
  }

  // URL에서 인증 정보 추출 및 자동 로그인
  function autoLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const battleId = urlParams.get('battle');
    const token    = urlParams.get('token');
    const name     = urlParams.get('name');

    if (!battleId) {
      alert('전투 ID가 필요합니다');
      return;
    }

    currentBattleId = battleId;
    const s = initSocket();

    // 방 입장
    s.emit('join', { battleId });

    // 인증 시도
    s.emit('playerAuth', { battleId, token, name }, (res) => {
      if (!res || !res.ok) {
        alert('로그인 실패: ' + (res?.error || '알 수 없는 오류'));
      } else {
        onAuthSuccess(res);
      }
    });
  }

  // UI 업데이트
  function updateUI(battle) {
    updateBattleStatus(battle);
    updatePlayerInfo(battle);
    updateTeamInfo(battle);
    updateTurnInfo(battle);
    updateCurrentPlayerAvatar(battle);
    updateActionButtons(battle);
    syncTimer(battle);
  }

  // 전투 상태
  function updateBattleStatus(battle) {
    const statusEl = $('#battleStatus');
    if (!statusEl) return;
    const m = {
      waiting: '대기 중',
      active : '진행 중',
      paused : '일시정지',
      ended  : '종료됨'
    };
    statusEl.textContent = m[battle.status] || battle.status || '';
  }

  // 내 정보
  function updatePlayerInfo(battle) {
    if (!currentPlayerId) return;
    const player = battle.players.find(p => p.id === currentPlayerId);
    if (!player) return;

    // 초상화
    const avatarEl = $('#playerAvatar');
    if (avatarEl) {
      avatarEl.src = player.avatar || '/uploads/avatars/default.svg';
      avatarEl.onerror = () => { avatarEl.src = '/uploads/avatars/default.svg'; };
    }

    // 이름
    $('#playerName') && ($('#playerName').textContent = player.name || '');

    // HP
    const hpBarEl  = $('#playerHpBar');
    const hpTextEl = $('#playerHpText');
    const maxHp = Math.max(1, player.maxHp || 100);
    const hp    = Math.max(0, player.hp);
    const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));

    if (hpBarEl && hpTextEl) {
      hpBarEl.style.width = `${hpPercent}%`;
      hpTextEl.textContent = `${hp}/${maxHp}`;
      hpBarEl.className = 'hp-bar ' + (hpPercent > 60 ? 'hp-high' : hpPercent > 30 ? 'hp-medium' : 'hp-low');
    }

    // 스탯
    const st = player.stats || {};
    const statsEl = $('#playerStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat">공격: ${st.attack ?? 0}</div>
        <div class="stat">방어: ${st.defense ?? 0}</div>
        <div class="stat">민첩: ${st.agility ?? 0}</div>
        <div class="stat">행운: ${st.luck ?? 0}</div>
      `;
    }

    // 아이템
    const it = player.items || {};
    const itemsEl = $('#playerItems');
    if (itemsEl) {
      const dittany        = it.dittany ?? it.ditany ?? 0;
      const attackBooster  = it.attackBooster ?? it.attack_boost ?? 0;
      const defenseBooster = it.defenseBooster ?? it.defense_boost ?? 0;
      itemsEl.innerHTML = `
        <div class="item">디터니: ${dittany}</div>
        <div class="item">공격 보정기: ${attackBooster}</div>
        <div class="item">방어 보정기: ${defenseBooster}</div>
      `;
    }

    // 준비 버튼
    const readyBtn = $('#btnReady');
    if (readyBtn) {
      if (player.ready) {
        readyBtn.textContent = '준비완료';
        readyBtn.disabled = true;
        readyBtn.classList.add('ready');
      } else {
        readyBtn.textContent = '준비 완료';
        readyBtn.disabled = false;
        readyBtn.classList.remove('ready');
      }
    }
  }

  // 팀 정보(표시는 불사조/죽먹자)
  function updateTeamInfo(battle) {
    if (!currentPlayerId) return;
    const me = battle.players.find(p => p.id === currentPlayerId);
    if (!me) return;

    const teamA = battle.players.filter(p => p.team === 'A');
    const teamB = battle.players.filter(p => p.team === 'B');

    updateTeamContainer('#teamAContainer', teamA, me.team === 'A', 'A');
    updateTeamContainer('#teamBContainer', teamB, me.team === 'B', 'B');
  }

  function updateTeamContainer(containerId, players, isMyTeam, ab) {
    const container = $(containerId);
    if (!container) return;

    const title = `${teamLabelAB(ab)} ${isMyTeam ? '(내 팀)' : '(상대팀)'}`;
    let html = `<h3>${title}</h3><div class="team-players">`;

    players.forEach(player => {
      const maxHp = Math.max(1, player.maxHp || 100);
      const hp    = Math.max(0, player.hp);
      const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));
      const isSelf = player.id === currentPlayerId;

      html += `
        <div class="team-player ${isSelf ? 'current-player' : ''}">
          <div class="player-avatar-small">
            <img src="${esc(player.avatar || '/uploads/avatars/default.svg')}"
                 alt="${esc(player.name || '')}"
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="player-summary">
            <div class="player-name">${esc(player.name || '')}</div>
            <div class="hp-container">
              <div class="hp-bar-small"><div class="hp-fill" style="width:${hpPercent}%"></div></div>
              <div class="hp-text-small">${hp}/${maxHp}</div>
            </div>
            <div class="stats-small">
              ${(player.stats?.attack ?? 0)}/${(player.stats?.defense ?? 0)}/${(player.stats?.agility ?? 0)}/${(player.stats?.luck ?? 0)}
            </div>
          </div>
        </div>
      `;
    });

    html += '</div>';
    container.innerHTML = html;
  }

  // 턴/페이즈/타이머(서버 값 기반)
  function updateTurnInfo(battle) {
    const turnInfoEl = $('#turnInfo');
    if (!turnInfoEl) return;

    const t = battle.currentTurn || {};
    const phase = t.phase || battle.phase || 'waiting';

    // 페이즈 표기(팀 이름 변환)
    const phaseText =
      phase === 'A_select' ? `${teamLabelAB('A')} 선택 중` :
      phase === 'B_select' ? `${teamLabelAB('B')} 선택 중` :
      phase === 'resolve'  ? '라운드 해석 중' :
      phase === 'inter'    ? '다음 라운드 대기' :
      phase === 'team_action' ? '행동 페이즈' :
      phase === 'processing'  ? '결과 처리 중' :
      phase === 'switching'   ? '팀 교체 중' : '대기 중';

    const teamText = t.currentTeam ? `${teamLabelAB(t.currentTeam)} 턴` : '';
    const numText  = `${t.turnNumber || 0}턴`;
    const timeText = `${t.timeLeftSec || 0}초 남음`;

    turnInfoEl.innerHTML = `
      <div class="turn-number">${numText}</div>
      <div class="current-team">${teamText}</div>
      <div class="phase">${phaseText}</div>
      <div class="time-left" id="timeLeftText">${timeText}</div>
    `;
  }

  // 현재 플레이어 초상화
  function updateCurrentPlayerAvatar(battle) {
    const avatarEl = $('#currentPlayerAvatar');
    if (!avatarEl) return;

    const cur = battle.currentTurn?.currentPlayer;
    if (cur && cur.avatar) {
      avatarEl.src = cur.avatar;
      avatarEl.onerror = () => { avatarEl.src = '/uploads/avatars/default.svg'; };
    } else {
      avatarEl.src = '/uploads/avatars/default.svg';
    }
  }

  // 내 턴 판단(개인 턴/팀 턴/선택 페이즈 모두 대응)
  function isMyTurn(battle) {
    if (!currentPlayerId) return false;
    const me = battle.players.find(p => p.id === currentPlayerId);
    if (!me) return false;

    const t = battle.currentTurn || {};
    const phase = t.phase || battle.phase || '';

    // 개인 턴이 명시되면 그것을 우선
    if (t.currentPlayer && t.currentPlayer.id) {
      return t.currentPlayer.id === currentPlayerId;
    }
    // 선택 페이즈는 팀 단위
    if (phase === 'A_select') return me.team === 'A';
    if (phase === 'B_select') return me.team === 'B';
    // 그 외엔 currentTeam 기준
    if (t.currentTeam) return t.currentTeam === me.team;

    return false;
  }

  // 액션 버튼 상태
  function updateActionButtons(battle) {
    const me = battle.players.find(p => p.id === currentPlayerId);
    if (!me) return;

    const alive   = me.hp > 0;
    const active  = battle.status === 'active';
    const myturn  = isMyTurn(battle);
    const hasActed = false; // 필요 시 서버 플래그와 동기화

    const canAct = active && alive && myturn && !hasActed;

    $$('.action-btn').forEach(btn => { btn.disabled = !canAct; });

    // 아이템별 가용성
    const it = me.items || {};
    const dittanyBtn = $('#btnItemDittany');
    if (dittanyBtn) {
      const hasDittany = (it.dittany ?? it.ditany ?? 0) > 0;
      dittanyBtn.disabled = !canAct || !hasDittany;
    }
  }

  // 액션 버튼 비활성/활성
  function disableActionButtons(disabled = true) {
    $$('.action-btn').forEach(btn => { btn.disabled = disabled; });
  }

  // 타이머 동기화 + 로컬 카운트다운
  function syncTimer(battle) {
    clearInterval(timerTick);
    const t = Math.max(0, battle?.currentTurn?.timeLeftSec | 0);

    // inter 페이즈 최소 5초 보장(표시만)
    const phase = battle?.currentTurn?.phase || battle?.phase;
    timerLeft = (phase === 'inter' && t < 5) ? 5 : t;

    drawTime(timerLeft);
    timerTick = setInterval(() => {
      if (timerLeft > 0) {
        timerLeft -= 1;
        drawTime(timerLeft);
      }
    }, 1000);
  }

  function drawTime(sec) {
    const el = $('#timeLeftText');
    if (el) el.textContent = `${sec}초 남음`;
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, '0');
    $('#timerDisplay') && ($('#timerDisplay').textContent = `${mm}:${ss}`);
    $('#timerSeconds') && ($('#timerSeconds').textContent = `${sec}초`);
  }

  // 준비 완료
  function markReady() {
    if (!currentBattleId || !currentPlayerId) return;
    const s = initSocket();
    s.emit('player:ready', { battleId: currentBattleId, playerId: currentPlayerId }, (res) => {
      if (!res || !res.ok) alert('준비 완료 실패: ' + (res?.error || '알 수 없는 오류'));
    });
  }

  // 액션들
  function attack() { showTargetSelection('attack'); }
  function defend() { performAction({ type: 'defend' }); }
  function dodge()  { performAction({ type: 'dodge'  }); }
  function pass()   { performAction({ type: 'pass'   }); }

  // 아이템: 현재 디터니만 직행(자기 자신 대상 or 서버 해석)
  function useItem(itemType) {
    if (itemType === 'dittany' || itemType === 'ditany') {
      performAction({ type: 'item', item: 'dittany' });
    }
  }

  // 대상 선택 오버레이
  function showTargetSelection(actionType) {
    if (!battleData || !currentPlayerId) return;

    const me = battleData.players.find(p => p.id === currentPlayerId);
    if (!me) return;

    const enemies = battleData.players.filter(p => p.team !== me.team && p.hp > 0);
    if (enemies.length === 0) { alert('공격할 대상이 없습니다'); return; }

    const overlay = $('#targetOverlay');
    const container = $('#targetContainer');
    if (!overlay || !container) return;

    let html = '<h3>공격 대상 선택</h3><div class="target-list">';
    enemies.forEach(e => {
      html += `
        <div class="target-option" onclick="selectTarget('${e.id}', '${actionType}')">
          <div class="target-avatar">
            <img src="${esc(e.avatar || '/uploads/avatars/default.svg')}"
                 alt="${esc(e.name || '')}"
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="target-info">
            <div class="target-name">${esc(e.name || '')}</div>
            <div class="target-hp">HP: ${e.hp}/${e.maxHp}</div>
          </div>
        </div>
      `;
    });
    html += '</div><button class="overlay-cancel" onclick="closeTargetSelection()">취소</button>';

    container.innerHTML = html;
    overlay.style.display = 'flex';
  }

  function selectTarget(targetId, actionType) {
    closeTargetSelection();
    performAction({ type: actionType, targetId });
  }

  function closeTargetSelection() {
    const overlay = $('#targetOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  // 행동 수행
  function performAction(action) {
    if (!currentBattleId || !currentPlayerId) return;

    disableActionButtons(true);
    const s = initSocket();
    s.emit('player:action', {
      battleId: currentBattleId,
      playerId: currentPlayerId,
      action
    }, (res) => {
      if (!res || !res.ok) {
        alert('행동 실패: ' + (res?.error || '알 수 없는 오류'));
        disableActionButtons(false);
      }
    });
  }

  // 로그
  function addLog(data = {}) {
    const container = $('#logContainer');
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'log-entry';

    const t = String(data.type || '').toLowerCase();
    if (t === 'battle' || t === 'round') div.classList.add('log-battle');
    else if (t === 'error') div.classList.add('log-error');
    else if (t === 'system') div.classList.add('log-system');

    const time = new Date(data.ts || Date.now()).toLocaleTimeString('ko-KR', { hour12:false });
    div.innerHTML = `<span class="log-time">${time}</span><span class="log-message">${esc(data.message || '')}</span>`;

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // 채팅
  function addChat(data = {}) {
    const container = $('#chatContainer');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-entry';
    const time = new Date().toLocaleTimeString('ko-KR', { hour12:false });
    div.innerHTML = `
      <span class="chat-time">${time}</span>
      <span class="chat-name">${esc(data.name || '익명')}:</span>
      <span class="chat-message">${esc(data.message || '')}</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // 채팅 전송
  function sendChat() {
    const input = $('#chatMsg');
    const message = input?.value?.trim();
    if (!message || !currentBattleId) return;

    const s = initSocket();
    s.emit('chatMessage', {
      battleId: currentBattleId,
      name: currentPlayerData?.name || '전투 참가자',
      message
    }, (res) => {
      if (res?.ok && input) input.value = '';
    });
  }

  // 이벤트 리스너
  function setupEventListeners() {
    // 준비 완료
    $('#btnReady')?.addEventListener('click', markReady);

    // 액션
    $('#btnAttack')?.addEventListener('click', attack);
    $('#btnDefend')?.addEventListener('click', defend);
    $('#btnDodge') ?.addEventListener('click', dodge);
    $('#btnItemDittany')?.addEventListener('click', () => useItem('dittany'));
    $('#btnPass')  ?.addEventListener('click', pass);

    // 채팅
    $('#btnSendChat')?.addEventListener('click', sendChat);
    $('#chatMsg')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    // 오버레이
    $('#targetOverlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'targetOverlay') closeTargetSelection();
    });

    // 전역 노출
    window.selectTarget = selectTarget;
    window.closeTargetSelection = closeTargetSelection;
  }

  // 초기화
  function init() {
    setupEventListeners();
    autoLogin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
