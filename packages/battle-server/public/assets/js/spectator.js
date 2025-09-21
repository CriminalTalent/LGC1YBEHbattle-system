// packages/battle-server/public/assets/js/spectator.js
// PYXIS 배틀 시스템 - 관전자 페이지 (개선된 버전)
(function() {
  'use strict';

  let socket = null;
  let currentBattleId = null;
  let spectatorName = null;
  let battleData = null;
  let connected = false;

  // 고정 응원 멘트
  const cheerMessages = [
    '멋지다!',
    '이겨라!',
    '살아서 돌아와!',
    '화이팅!',
    '죽으면 나한테 죽어!',
    '힘내요!'
  ];

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

    // 채팅 수신 (중복 방지) - 관전자는 수신만
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

    // 응원 메시지 수신 (채팅에만 표시)
    socket.on('spectator:cheer', () => {
      // 응원은 채팅으로만 표시되므로 별도 처리 불필요
    });
    socket.on('cheerMessage', () => {
      // 호환성 유지
    });

    return socket;
  }

  // URL에서 인증 정보 추출 및 자동 로그인
  function autoLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const battleId = urlParams.get('battle');
    const otp = urlParams.get('otp');

    if (!battleId || !otp) {
      showNameInput(battleId, otp);
      return;
    }

    // 이름 입력 받기
    const name = prompt('관전자 이름을 입력하세요:', '관전자');
    if (!name) return;

    spectatorName = name;
    currentBattleId = battleId;

    const s = initSocket();

    // 방 입장
    s.emit('join', { battleId });

    // 관전자 인증
    s.emit('spectatorAuth', { battleId, otp, name }, (response) => {
      if (!response || !response.ok) {
        alert('관전자 인증 실패: ' + (response?.error || '알 수 없는 오류'));
      } else {
        console.log('관전자 인증 성공');
        hideNameInput();
      }
    });
  }

  // 이름 입력 UI 표시
  function showNameInput(battleId, otp) {
    const overlay = $('#nameInputOverlay');
    if (overlay) {
      overlay.style.display = 'flex';

      $('#nameSubmitBtn').onclick = () => {
        const nameInput = $('#spectatorNameInput');
        const name = nameInput.value.trim();

        if (!name) {
          alert('이름을 입력하세요');
          return;
        }

        if (!battleId || !otp) {
          alert('유효하지 않은 링크입니다');
          return;
        }

        spectatorName = name;
        currentBattleId = battleId;

        const s = initSocket();
        s.emit('join', { battleId });
        s.emit('spectatorAuth', { battleId, otp, name }, (response) => {
          if (!response || !response.ok) {
            alert('관전자 인증 실패: ' + (response?.error || '알 수 없는 오류'));
          } else {
            hideNameInput();
          }
        });
      };
    }
  }

  // 이름 입력 UI 숨기기
  function hideNameInput() {
    const overlay = $('#nameInputOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  // UI 업데이트
  function updateUI(battle) {
    updateBattleStatus(battle);
    updateTeamContainers(battle);
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

  // 팀 컨테이너 업데이트
  function updateTeamContainers(battle) {
    const teamA = battle.players.filter(p => p.team === 'A');
    const teamB = battle.players.filter(p => p.team === 'B');

    updateTeamContainer('#teamAContainer', teamA, 'A');
    updateTeamContainer('#teamBContainer', teamB, 'B');
  }

  // 개별 팀 컨테이너 업데이트
  function updateTeamContainer(containerId, players, teamLetter) {
    const container = $(containerId);
    if (!container) return;

    let html = `<h3>${teamLetter}팀</h3>`;
    html += '<div class="team-players">';

    players.forEach(player => {
      const hpPercent = (player.hp / player.maxHp) * 100;
      let hpClass = 'hp-high';
      if (hpPercent <= 30) hpClass = 'hp-low';
      else if (hpPercent <= 60) hpClass = 'hp-medium';

      html += `
        <div class="spectator-player ${player.hp <= 0 ? 'dead' : ''}">
          <div class="player-avatar-spectator">
            <img src="${player.avatar || '/uploads/avatars/default.svg'}" 
                 alt="${player.name}" 
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="player-info-spectator">
            <div class="player-name">${player.name}</div>
            <div class="hp-container-spectator">
              <div class="hp-bar-spectator">
                <div class="hp-fill ${hpClass}" style="width: ${hpPercent}%"></div>
              </div>
              <div class="hp-text-spectator">${player.hp}/${player.maxHp}</div>
            </div>
            <div class="stats-spectator">
              공:${player.stats.attack} 방:${player.stats.defense} 
              민:${player.stats.agility} 행:${player.stats.luck}
            </div>
            <div class="items-spectator">
              디터니:${player.items.dittany || player.items.ditany || 0}
              공격:${player.items.attackBooster || player.items.attack_boost || 0}
              방어:${player.items.defenseBooster || player.items.defense_boost || 0}
            </div>
            ${player.ready ? '<div class="ready-indicator">준비완료</div>' : ''}
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
        <div class="turn-display">
          <div class="turn-number">${turn.turnNumber || 0}턴</div>
          <div class="current-team">${turn.currentTeam || ''}팀 차례</div>
          <div class="phase">${phaseText}</div>
          <div class="time-left">${turn.timeLeftSec || 0}초 남음</div>
        </div>
      `;
    }
  }

  // 현재 플레이어 초상화 업데이트
  function updateCurrentPlayerAvatar(battle) {
    const avatarEl = $('#currentPlayerAvatar');
    const nameEl = $('#currentPlayerName');

    if (battle.currentTurn && battle.currentTurn.currentPlayer) {
      const currentPlayer = battle.players.find(p => p.id === battle.currentTurn.currentPlayer.id);

      if (currentPlayer) {
        if (avatarEl) {
          avatarEl.src = currentPlayer.avatar || '/uploads/avatars/default.svg';
          avatarEl.onerror = () => {
            avatarEl.src = '/uploads/avatars/default.svg';
          };
        }

        if (nameEl) {
          nameEl.textContent = currentPlayer.name;
        }
      }
    } else {
      if (avatarEl) {
        avatarEl.src = '/uploads/avatars/default.svg';
      }
      if (nameEl) {
        nameEl.textContent = '대기 중';
      }
    }
  }

  // 응원 버튼 생성
  function createCheerButtons() {
    const container = $('#cheerButtons');
    if (!container) return;

    let html = '<h4>응원하기</h4>';
    html += '<div class="cheer-button-grid">';

    cheerMessages.forEach(message => {
      html += `<button class="cheer-btn" onclick="sendCheer('${message}')">${message}</button>`;
    });

    html += '</div>';
    container.innerHTML = html;
  }

  // 응원 전송
  function sendCheer(message) {
    if (!currentBattleId || !spectatorName) return;

    const s = initSocket();
    s.emit('spectator:cheer', {
      battleId: currentBattleId,
      name: spectatorName,
      message: message
    }, (response) => {
      if (!response || !response.ok) {
        console.error('응원 전송 실패:', response?.error);
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

  // 채팅 추가 (응원 포함)
  function addChat(data) {
    const container = $('#chatContainer');
    if (!container) return;

    const chatDiv = document.createElement('div');
    chatDiv.className = 'chat-entry';

    // 응원 메시지인지 확인
    if (data.message && data.message.startsWith('[응원]')) {
      chatDiv.classList.add('cheer-message');
    }

    const time = new Date().toLocaleTimeString();
    chatDiv.innerHTML = `
      <span class="chat-time">${time}</span>
      <span class="chat-name">${data.name}:</span>
      <span class="chat-message">${data.message}</span>
    `;

    container.appendChild(chatDiv);
    container.scrollTop = container.scrollHeight;
  }

  // 이벤트 리스너 등록
  function setupEventListeners() {
    // 이름 입력 엔터키
    $('#spectatorNameInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        $('#nameSubmitBtn').click();
      }
    });
  }

  // 전역 함수로 노출 (HTML에서 호출용)
  window.sendCheer = sendCheer;

  // 초기화
  function init() {
    console.log('관전자 페이지 초기화 중...');
    setupEventListeners();
    createCheerButtons();
    autoLogin();
    console.log('관전자 페이지 초기화 완료');
  }

  // DOM 로드 후 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
