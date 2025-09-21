// packages/battle-server/public/assets/js/player.js
// PYXIS 배틀 시스템 - 플레이어 페이지 (개선된 버전)
(function() {
  'use strict';

  let socket = null;
  let currentBattleId = null;
  let currentPlayerId = null;
  let currentPlayerData = null;
  let battleData = null;
  let connected = false;

  // DOM 헬퍼
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 소켓 초기화
  function initSocket() {
    if (socket && connected) return socket;

    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      timeout: 5000
    });

    socket.on('connect', () => {
      console.log('소켓 연결됨');
      connected = true;
    });

    socket.on('disconnect', () => {
      console.log('소켓 연결 해제됨');
      connected = false;
    });

    // 배틀 업데이트 (중복 방지)
    let lastUpdateTime = 0;
    const handleBattleUpdate = (data) => {
      const now = Date.now();
      if (now - lastUpdateTime < 100) return; // 100ms 내 중복 방지
      lastUpdateTime = now;

      if (data && data.id) {
        battleData = data;
        updateUI(data);
      }
    };

    socket.on('battleUpdate', handleBattleUpdate);
    socket.on('battle:update', handleBattleUpdate);

    // 인증 성공
    socket.on('authSuccess', (data) => {
      if (data.ok) {
        currentPlayerId = data.playerId;
        currentPlayerData = data;
        console.log('인증 성공:', data);
      }
    });

    socket.on('auth:success', (data) => {
      if (data.ok) {
        currentPlayerId = data.playerId;
        currentPlayerData = data;
        console.log('인증 성공 (호환):', data);
      }
    });

    // 인증 실패
    socket.on('authError', (data) => {
      alert('인증 실패: ' + (data.error || '알 수 없는 오류'));
    });

    // 행동 성공
    socket.on('actionSuccess', (data) => {
      console.log('행동 성공:', data);
      disableActionButtons(false);
    });

    socket.on('player:action:success', (data) => {
      console.log('행동 성공 (호환):', data);
      disableActionButtons(false);
    });

    // 행동 실패
    socket.on('actionError', (data) => {
      alert('행동 실패: ' + (data.error || '알 수 없는 오류'));
      disableActionButtons(false);
    });

    // 로그 수신 (중복 방지)
    let lastLogMessage = '';
    let lastLogTime = 0;

    const handleLog = (data) => {
      const now = Date.now();
      if (data.message === lastLogMessage && (now - lastLogTime) < 1000) {
        return;
      }
      lastLogMessage = data.message;
      lastLogTime = now;
      addLog(data);
    };

    socket.on('battle:log', handleLog);
    socket.on('battleLog', handleLog);

    // 채팅 수신 (중복 방지)
    let lastChatMessage = '';
    let lastChatTime = 0;

    const handleChat = (data) => {
      const now = Date.now();
      const messageKey = `${data.name}:${data.message}`;
      if (messageKey === lastChatMessage && (now - lastChatTime) < 1000) {
        return;
      }
      lastChatMessage = messageKey;
      lastChatTime = now;
      addChat(data);
    };

    socket.on('chatMessage', handleChat);
    socket.on('battle:chat', handleChat);

    return socket;
  }

  // URL에서 인증 정보 추출 및 자동 로그인
  function autoLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const battleId = urlParams.get('battle');
    const token = urlParams.get('token');
    const name = urlParams.get('name');

    if (!battleId) {
      alert('전투 ID가 필요합니다');
      return;
    }

    currentBattleId = battleId;
    const s = initSocket();

    // 방 입장
    s.emit('join', { battleId });

    // 인증 시도
    s.emit('playerAuth', {
      battleId,
      token,
      name
    }, (response) => {
      if (!response || !response.ok) {
        alert('로그인 실패: ' + (response?.error || '알 수 없는 오류'));
      }
    });
  }

  // UI 업데이트
  function updateUI(battle) {
    updateBattleStatus(battle);
    updatePlayerInfo(battle);
    updateTeamInfo(battle);
    updateActionButtons(battle);
    updateTurnInfo(battle);
    updateCurrentPlayerAvatar(battle);
  }

  // 전투 상태 업데이트
  function updateBattleStatus(battle) {
    const statusEl = $('#battleStatus');
    if (statusEl) {
      let statusText = '';
      switch (battle.status) {
        case 'waiting': statusText = '대기 중'; break;
        case 'active': statusText = '진행 중'; break;
        case 'paused': statusText = '일시정지'; break;
        case 'ended': statusText = '종료됨'; break;
        default: statusText = battle.status;
      }
      statusEl.textContent = statusText;
    }
  }

  // 플레이어 정보 업데이트
  function updatePlayerInfo(battle) {
    const player = battle.players.find(p => p.id === currentPlayerId);
    if (!player) return;

    // 초상화
    const avatarEl = $('#playerAvatar');
    if (avatarEl) {
      avatarEl.src = player.avatar || '/uploads/avatars/default.svg';
      avatarEl.onerror = () => {
        avatarEl.src = '/uploads/avatars/default.svg';
      };
    }

    // 이름
    const nameEl = $('#playerName');
    if (nameEl) {
      nameEl.textContent = player.name;
    }

    // HP 바
    const hpBarEl = $('#playerHpBar');
    const hpTextEl = $('#playerHpText');
    if (hpBarEl && hpTextEl) {
      const hpPercent = (player.hp / player.maxHp) * 100;
      hpBarEl.style.width = `${hpPercent}%`;
      hpTextEl.textContent = `${player.hp}/${player.maxHp}`;

      // HP 색상
      if (hpPercent > 60) {
        hpBarEl.className = 'hp-bar hp-high';
      } else if (hpPercent > 30) {
        hpBarEl.className = 'hp-bar hp-medium';
      } else {
        hpBarEl.className = 'hp-bar hp-low';
      }
    }

    // 스탯
    const statsEl = $('#playerStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat">공격: ${player.stats.attack}</div>
        <div class="stat">방어: ${player.stats.defense}</div>
        <div class="stat">민첩: ${player.stats.agility}</div>
        <div class="stat">행운: ${player.stats.luck}</div>
      `;
    }

    // 아이템
    const itemsEl = $('#playerItems');
    if (itemsEl) {
      const dittany = player.items.dittany || player.items.ditany || 0;
      const attackBooster = player.items.attackBooster || player.items.attack_boost || 0;
      const defenseBooster = player.items.defenseBooster || player.items.defense_boost || 0;

      itemsEl.innerHTML = `
        <div class="item">디터니: ${dittany}</div>
        <div class="item">공격보정: ${attackBooster}</div>
        <div class="item">방어보정: ${defenseBooster}</div>
      `;
    }

    // 준비 완료 버튼
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

  // 팀 정보 업데이트
  function updateTeamInfo(battle) {
    const myPlayer = battle.players.find(p => p.id === currentPlayerId);
    if (!myPlayer) return;

    const myTeam = myPlayer.team;
    const teamA = battle.players.filter(p => p.team === 'A');
    const teamB = battle.players.filter(p => p.team === 'B');

    // A팀 표시
    updateTeamContainer('#teamAContainer', teamA, myTeam === 'A');

    // B팀 표시
    updateTeamContainer('#teamBContainer', teamB, myTeam === 'B');
  }

  // 팀 컨테이너 업데이트
  function updateTeamContainer(containerId, players, isMyTeam) {
    const container = $(containerId);
    if (!container) return;

    const teamLetter = containerId.includes('A') ? 'A' : 'B';

    let html = `<h3>${teamLetter}팀 ${isMyTeam ? '(내 팀)' : '(상대팀)'}</h3>`;
    html += '<div class="team-players">';

    players.forEach(player => {
      const hpPercent = (player.hp / player.maxHp) * 100;
      const isCurrentPlayer = player.id === currentPlayerId;

      html += `
        <div class="team-player ${isCurrentPlayer ? 'current-player' : ''}">
          <div class="player-avatar-small">
            <img src="${player.avatar || '/uploads/avatars/default.svg'}" 
                 alt="${player.name}" 
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="player-summary">
            <div class="player-name">${player.name}</div>
            <div class="hp-container">
              <div class="hp-bar-small">
                <div class="hp-fill" style="width: ${hpPercent}%"></div>
              </div>
              <div class="hp-text-small">${player.hp}/${player.maxHp}</div>
            </div>
            <div class="stats-small">
              ${player.stats.attack}/${player.stats.defense}/${player.stats.agility}/${player.stats.luck}
            </div>
          </div>
        </div>
      `;
    });

    html += '</div>';
    container.innerHTML = html;
  }

  // 턴 정보 업데이트
  function updateTurnInfo(battle) {
    const turnInfoEl = $('#turnInfo');
    if (turnInfoEl && battle.currentTurn) {
      const turn = battle.currentTurn;
      let phaseText = '';

      switch (turn.phase) {
        case 'waiting': phaseText = '대기 중'; break;
        case 'team_action': phaseText = '행동 페이즈'; break;
        case 'processing': phaseText = '결과 처리 중'; break;
        case 'switching': phaseText = '팀 교체 중'; break;
        default: phaseText = turn.phase || '';
      }

      turnInfoEl.innerHTML = `
        <div class="turn-number">${turn.turnNumber || 0}턴</div>
        <div class="current-team">${turn.currentTeam || ''}팀 턴</div>
        <div class="phase">${phaseText}</div>
        <div class="time-left">${turn.timeLeftSec || 0}초 남음</div>
      `;
    }
  }

  // 현재 플레이어 초상화 업데이트
  function updateCurrentPlayerAvatar(battle) {
    const avatarEl = $('#currentPlayerAvatar');
    if (avatarEl && battle.currentTurn && battle.currentTurn.currentPlayer) {
      const current = battle.players.find(p => p.id === battle.currentTurn.currentPlayer.id);
      if (current) {
        avatarEl.src = current.avatar || '/uploads/avatars/default.svg';
        avatarEl.onerror = () => {
          avatarEl.src = '/uploads/avatars/default.svg';
        };
      }
    }
  }

  // 액션 버튼 상태 업데이트
  function updateActionButtons(battle) {
    const myPlayer = battle.players.find(p => p.id === currentPlayerId);
    if (!myPlayer) return;

    const isMyTurn = battle.currentTurn && battle.currentTurn.currentTeam === myPlayer.team;
    const isActive = battle.status === 'active';
    const isAlive = myPlayer.hp > 0;

    // 이미 행동했는지 확인 (실제로는 서버에서 확인해야 함)
    const hasActed = false; // TODO: 서버에서 수신 시 반영

    const canAct = isActive && isMyTurn && isAlive && !hasActed;

    // 모든 액션 버튼 비활성화/활성화
    $$('.action-btn').forEach(btn => {
      btn.disabled = !canAct;
    });

    // 아이템 버튼 개별 체크
    const dittanyBtn = $('#btnItemDittany');
    if (dittanyBtn) {
      const hasDittany = (myPlayer.items.dittany || myPlayer.items.ditany || 0) > 0;
      dittanyBtn.disabled = !canAct || !hasDittany;
    }
  }

  // 액션 버튼 비활성화/활성화
  function disableActionButtons(disabled = true) {
    $$('.action-btn').forEach(btn => {
      btn.disabled = disabled;
    });
  }

  // 준비 완료
  function markReady() {
    if (!currentBattleId || !currentPlayerId) return;

    const s = initSocket();
    s.emit('player:ready', {
      battleId: currentBattleId,
      playerId: currentPlayerId
    }, (response) => {
      if (!response || !response.ok) {
        alert('준비 완료 실패: ' + (response?.error || '알 수 없는 오류'));
      }
    });
  }

  // 공격
  function attack() {
    showTargetSelection('attack');
  }

  // 방어
  function defend() {
    performAction({ type: 'defend' });
  }

  // 회피
  function dodge() {
    performAction({ type: 'dodge' });
  }

  // 아이템 사용
  function useItem(itemType) {
    if (itemType === 'dittany') {
      performAction({ type: 'item', item: 'dittany' });
    }
  }

  // 패스
  function pass() {
    performAction({ type: 'pass' });
  }

  // 대상 선택 오버레이 표시
  function showTargetSelection(actionType) {
    if (!battleData) return;

    const myPlayer = battleData.players.find(p => p.id === currentPlayerId);
    if (!myPlayer) return;

    const enemies = battleData.players.filter(p =>
      p.team !== myPlayer.team && p.hp > 0
    );

    if (enemies.length === 0) {
      alert('공격할 대상이 없습니다');
      return;
    }

    const overlay = $('#targetOverlay');
    const container = $('#targetContainer');

    if (!overlay || !container) return;

    let html = '<h3>공격 대상 선택</h3>';
    html += '<div class="target-list">';

    enemies.forEach(enemy => {
      html += `
        <div class="target-option" onclick="selectTarget('${enemy.id}', '${actionType}')">
          <div class="target-avatar">
            <img src="${enemy.avatar || '/uploads/avatars/default.svg'}" 
                 alt="${enemy.name}" 
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="target-info">
            <div class="target-name">${enemy.name}</div>
            <div class="target-hp">HP: ${enemy.hp}/${enemy.maxHp}</div>
          </div>
        </div>
      `;
    });

    html += '</div>';
    html += '<button onclick="closeTargetSelection()">취소</button>';

    container.innerHTML = html;
    overlay.style.display = 'flex';
  }

  // 대상 선택
  function selectTarget(targetId, actionType) {
    closeTargetSelection();
    performAction({
      type: actionType,
      targetId: targetId
    });
  }

  // 대상 선택 오버레이 닫기
  function closeTargetSelection() {
    const overlay = $('#targetOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  // 행동 수행
  function performAction(action) {
    if (!currentBattleId || !currentPlayerId) return;

    disableActionButtons(true);

    const s = initSocket();
    s.emit('player:action', {
      battleId: currentBattleId,
      playerId: currentPlayerId,
      action: action
    }, (response) => {
      if (!response || !response.ok) {
        alert('행동 실패: ' + (response?.error || '알 수 없는 오류'));
        disableActionButtons(false);
      }
    });
  }

  // 로그 추가
  function addLog(data) {
    const container = $('#logContainer');
    if (!container) return;

    const logDiv = document.createElement('div');
    logDiv.className = 'log-entry';

    // 타입별 스타일링
    if (data.type === 'battle' || data.type === 'round') {
      logDiv.classList.add('log-battle');
    } else if (data.type === 'error') {
      logDiv.classList.add('log-error');
    } else if (data.type === 'system') {
      logDiv.classList.add('log-system');
    }

    const time = new Date(data.ts || Date.now()).toLocaleTimeString();
    logDiv.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-message">${data.message}</span>
    `;

    container.appendChild(logDiv);
    container.scrollTop = container.scrollHeight;
  }

  // 채팅 추가
  function addChat(data) {
    const container = $('#chatContainer');
    if (!container) return;

    const chatDiv = document.createElement('div');
    chatDiv.className = 'chat-entry';

    const time = new Date().toLocaleTimeString();
    chatDiv.innerHTML = `
      <span class="chat-time">${time}</span>
      <span class="chat-name">${data.name}:</span>
      <span class="chat-message">${data.message}</span>
    `;

    container.appendChild(chatDiv);
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
      message: message
    }, (response) => {
      if (response?.ok) {
        input.value = '';
      }
    });
  }

  // 이벤트 리스너 등록
  function setupEventListeners() {
    // 준비 완료
    $('#btnReady')?.addEventListener('click', markReady);

    // 액션 버튼들
    $('#btnAttack')?.addEventListener('click', attack);
    $('#btnDefend')?.addEventListener('click', defend);
    $('#btnDodge')?.addEventListener('click', dodge);
    $('#btnItemDittany')?.addEventListener('click', () => useItem('dittany'));
    $('#btnPass')?.addEventListener('click', pass);

    // 채팅
    $('#btnSendChat')?.addEventListener('click', sendChat);
    $('#chatMsg')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendChat();
      }
    });

    // 오버레이 클릭 시 닫기
    $('#targetOverlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'targetOverlay') {
        closeTargetSelection();
      }
    });
  }

  // 전역 함수로 노출 (HTML에서 호출용)
  window.selectTarget = selectTarget;
  window.closeTargetSelection = closeTargetSelection;

  // 초기화
  function init() {
    console.log('플레이어 페이지 초기화 중...');
    setupEventListeners();
    autoLogin();
    console.log('플레이어 페이지 초기화 완료');
  }

  // DOM 로드 후 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
