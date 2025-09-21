// PYXIS 배틀 시스템 - 관리자 페이지
// (오탈자/중복/문법만 정리하여 보수, 기존 로직/흐름 유지)
(function () {
  'use strict';

  let socket = null;
  let currentBattleId = null;
  let connected = false;

  // DOM 헬퍼
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 소켓 초기화
  function initSocket() {
    if (socket && connected) return socket;

    // ✅ 클라이언트 초기화 방식 보수: 경로는 path 옵션으로 지정
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      timeout: 5000,
    });

    socket.on('connect', () => {
      console.log('소켓 연결됨');
      connected = true;
    });

    socket.on('disconnect', () => {
      console.log('소켓 연결 해제됨');
      connected = false;
    });

    // 배틀 업데이트 (단일 핸들러로 통합)
    socket.on('battleUpdate', handleBattleUpdate);
    socket.on('battle:update', handleBattleUpdate);

    // 로그 수신 (중복 방지)
    let lastLogMessage = '';
    let lastLogTime = 0;

    socket.on('battle:log', (data) => {
      const now = Date.now();
      const msg = data?.message ?? '';
      if (msg === lastLogMessage && now - lastLogTime < 1000) return; // 1초 내 같은 메시지 중복 방지
      lastLogMessage = msg;
      lastLogTime = now;
      addLog(data);
    });

    socket.on('battleLog', (data) => {
      const now = Date.now();
      const msg = data?.message ?? '';
      if (msg === lastLogMessage && now - lastLogTime < 1000) return;
      lastLogMessage = msg;
      lastLogTime = now;
      addLog(data);
    });

    // 채팅 수신 (중복 방지)
    let lastChatMessage = '';
    let lastChatTime = 0;

    socket.on('chatMessage', (data) => {
      const now = Date.now();
      const messageKey = `${data?.name || ''}:${data?.message || ''}`;
      if (messageKey === lastChatMessage && now - lastChatTime < 1000) return;
      lastChatMessage = messageKey;
      lastChatTime = now;
      addChat(data);
    });

    socket.on('battle:chat', (data) => {
      const now = Date.now();
      const messageKey = `${data?.name || ''}:${data?.message || ''}`;
      if (messageKey === lastChatMessage && now - lastChatTime < 1000) return;
      lastChatMessage = messageKey;
      lastChatTime = now;
      addChat(data);
    });

    return socket;
  }

  // 배틀 업데이트 처리 (중복 방지)
  let lastUpdateTime = 0;
  function handleBattleUpdate(data) {
    const now = Date.now();
    if (now - lastUpdateTime < 100) return; // 100ms 내 중복 방지
    lastUpdateTime = now;

    if (data && data.id) {
      currentBattleId = data.id;
      updateBattleInfo(data);
      updatePlayerList(data.players || []);

      // 로그 업데이트
      if (Array.isArray(data.logs)) {
        const logContainer = $('#logContainer');
        if (logContainer) {
          const existingLogs = $$('.log-entry').length;
          if (data.logs.length > existingLogs) {
            const newLogs = data.logs.slice(existingLogs);
            newLogs.forEach((log) => addLog(log));
          }
        }
      }
    }
  }

  // 전투 생성
  function createBattle() {
    const mode = $('#battleMode')?.value || '2v2';
    const s = initSocket();

    s.emit('createBattle', { mode }, (response) => {
      if (response && response.ok) {
        console.log('전투 생성 성공:', response);
        currentBattleId = response.battleId || response.id;
        $('#currentBattleId') && ($('#currentBattleId').textContent = currentBattleId);

        if (currentBattleId) {
          s.emit('join', { battleId: currentBattleId });
        }
      } else {
        alert('전투 생성 실패: ' + (response?.error || '알 수 없는 오류'));
      }
    });
  }

  // 전투 시작
  function startBattle() {
    if (!currentBattleId) {
      alert('전투 ID가 필요합니다');
      return;
    }

    const s = initSocket();
    s.emit('startBattle', { battleId: currentBattleId }, (response) => {
      if (!response || !response.ok) {
        alert('전투 시작 실패: ' + (response?.error || '알 수 없는 오류'));
      }
    });
  }

  // 전투 일시정지
  function pauseBattle() {
    if (!currentBattleId) return;
    const s = initSocket();
    s.emit('pauseBattle', { battleId: currentBattleId });
  }

  // 전투 재개
  function resumeBattle() {
    if (!currentBattleId) return;
    const s = initSocket();
    s.emit('resumeBattle', { battleId: currentBattleId });
  }

  // 전투 종료
  function endBattle() {
    if (!currentBattleId) return;
    const s = initSocket();
    s.emit('endBattle', { battleId: currentBattleId });
  }

  // 전투 참가자 추가
  async function addPlayer() {
    if (!currentBattleId) {
      alert('전투를 먼저 생성하세요');
      return;
    }

    const name = $('#playerName')?.value?.trim();
    const team = $('#playerTeam')?.value;
    const hp = parseInt($('#playerHp')?.value, 10) || 100;
    const attack = parseInt($('#playerAttack')?.value, 10) || 1;
    const defense = parseInt($('#playerDefense')?.value, 10) || 1;
    const agility = parseInt($('#playerAgility')?.value, 10) || 1;
    const luck = parseInt($('#playerLuck')?.value, 10) || 1;

    const dittany = parseInt($('#itemDittany')?.value, 10) || 0;
    const attackBooster = parseInt($('#itemAttackBooster')?.value, 10) || 0;
    const defenseBooster = parseInt($('#itemDefenseBooster')?.value, 10) || 0;

    if (!name) {
      alert('이름을 입력하세요');
      return;
    }

    let avatarUrl = '/uploads/avatars/default.svg';

    // 이미지 업로드 처리
    const fileInput = $('#avatarFile');
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      try {
        const formData = new FormData();
        formData.append('avatar', fileInput.files[0]);

        const response = await fetch('/api/upload/avatar', {
          method: 'POST',
          body: formData,
        });

        if (response.ok) {
          const result = await response.json();
          if (result?.ok && result.url) avatarUrl = result.url;
        } else {
          console.error('이미지 업로드 실패');
        }
      } catch (error) {
        console.error('이미지 업로드 오류:', error);
      }
    }

    const playerData = {
      name,
      team,
      hp,
      maxHp: hp,
      stats: { attack, defense, agility, luck },
      items: {
        dittany,
        ditany: dittany, // 호환성
        attackBooster,
        attack_boost: attackBooster, // 호환성
        defenseBooster,
        defense_boost: defenseBooster, // 호환성
      },
      avatar: avatarUrl,
    };

    const s = initSocket();
    s.emit(
      'addPlayer',
      {
        battleId: currentBattleId,
        player: playerData,
      },
      (response) => {
        if (response && response.ok) {
          console.log('전투 참가자 추가 성공');
          // 폼 리셋
          $('#playerForm')?.reset();
          if ($('#avatarFile')) $('#avatarFile').value = '';
        } else {
          alert('전투 참가자 추가 실패: ' + (response?.error || '알 수 없는 오류'));
        }
      },
    );
  }

  // 전투 참가자 제거
  function removePlayer(playerId) {
    if (!currentBattleId || !playerId) return;

    const s = initSocket();
    s.emit(
      'deletePlayer',
      {
        battleId: currentBattleId,
        playerId,
      },
      (response) => {
        if (!response || !response.ok) {
          alert('전투 참가자 제거 실패: ' + (response?.error || '알 수 없는 오류'));
        }
      },
    );
  }

  // 링크 생성 - URL을 pyxisbattlesystem.monster로 변경
  function generateLinks() {
    if (!currentBattleId) {
      alert('전투 ID가 필요합니다');
      return;
    }

    // 주 API 시도
    fetch(`/api/admin/battles/${currentBattleId}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.ok !== false) {
          displayLinks(data);
        } else {
          throw new Error(data?.error || 'API 호출 실패');
        }
      })
      .catch((error) => {
        console.warn('주 API 실패, 호환 API 시도:', error);

        // 호환 API 시도
        fetch(`/api/battles/${currentBattleId}/links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok !== false) {
              displayLinks(data);
            } else {
              alert('링크 생성 실패: ' + (data?.error || '알 수 없는 오류'));
            }
          })
          .catch((err) => {
            alert('링크 생성 실패: ' + err.message);
          });
      });
  }

  // 링크 표시 - 도메인을 pyxisbattlesystem.monster로 변경
  function displayLinks(data) {
    const container = $('#linkContainer');
    if (!container) return;

    // 서버 응답: { ok, links } 또는 { ok, spectator, players } 모두 허용
    const payload = data?.links || data;
    const spectator = payload?.spectator;
    const players = payload?.players;

    const baseUrl = 'https://pyxisbattlesystem.monster';

    // 절대/상대 URL 보정
    const toAbsolute = (u) => {
      if (!u) return '';
      return /^https?:\/\//i.test(u) ? u : `${baseUrl}${u.startsWith('/') ? '' : '/'}${u}`;
    };

    let html = '<div class="link-section">';

    // 관전자 링크
    if (spectator) {
      const spectatorUrl = spectator.url
        ? toAbsolute(spectator.url)
        : `${baseUrl}/spectator?battle=${encodeURIComponent(currentBattleId)}&otp=${encodeURIComponent(
            spectator.otp || '',
          )}`;

      html += `
        <div class="link-item">
          <h4>관전자 링크</h4>
          <p>OTP: <code>${spectator.otp || ''}</code></p>
          <div class="link-url">
            <input type="text" value="${spectatorUrl}" readonly onclick="this.select()">
            <button onclick="copyLink('${spectatorUrl}')">복사</button>
          </div>
        </div>
      `;
    }

    // 전투 참가자 링크들
    if (Array.isArray(players)) {
      html += '<div class="player-links"><h4>전투 참가자 링크</h4>';

      players.forEach((player) => {
        const playerUrl = player.url
          ? toAbsolute(player.url)
          : `${baseUrl}/player?battle=${encodeURIComponent(currentBattleId)}&token=${encodeURIComponent(
              player.token || '',
            )}`;

        html += `
          <div class="player-link-item">
            <span class="player-info">${player.name || '이름 없음'} (${player.team || '-' }팀)</span>
            <div class="link-url">
              <input type="text" value="${playerUrl}" readonly onclick="this.select()">
              <button onclick="copyLink('${playerUrl}')">복사</button>
            </div>
          </div>
        `;
      });

      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // 배틀 정보 업데이트
  function updateBattleInfo(battle) {
    if ($('#currentBattleId')) {
      $('#currentBattleId').textContent = battle.id || '없음';
    }
    if ($('#battleStatus')) {
      $('#battleStatus').textContent = battle.status || 'waiting';
    }
    if ($('#battleMode') && battle.mode) {
      $('#battleMode').value = battle.mode;
    }

    // 턴 정보 표시
    if (battle.currentTurn) {
      const turnInfo = `${battle.currentTurn.turnNumber || 0}턴 - ${
        battle.currentTurn.currentTeam || 'N/A'
      }팀 턴`;
      if ($('#turnInfo')) {
        $('#turnInfo').textContent = turnInfo;
      }
    }
  }

  // 전투 참가자 목록 업데이트
  function updatePlayerList(players) {
    const container = $('#playerList');
    if (!container) return;

    let html = '';

    // A팀과 B팀으로 분리
    const teamA = (players || []).filter((p) => p.team === 'A');
    const teamB = (players || []).filter((p) => p.team === 'B');

    html += '<div class="team-section">';
    html += '<h3>A팀</h3>';
    html += '<div class="team-players">';

    teamA.forEach((player) => {
      html += `
        <div class="player-card">
          <div class="player-avatar">
            <img src="${player.avatar || '/uploads/avatars/default.svg'}"
                 alt="${player.name || ''}"
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="player-info">
            <div class="player-name">${player.name || ''}</div>
            <div class="player-hp">HP: ${player.hp}/${player.maxHp}</div>
            <div class="player-stats">
              공격:${player.stats?.attack ?? '-'} 방어:${player.stats?.defense ?? '-'}
              민첩:${player.stats?.agility ?? '-'} 행운:${player.stats?.luck ?? '-'}
            </div>
            <div class="player-items">
              디터니:${player.items?.dittany || player.items?.ditany || 0}
              공격보정:${player.items?.attackBooster || player.items?.attack_boost || 0}
              방어보정:${player.items?.defenseBooster || player.items?.defense_boost || 0}
            </div>
            <div class="player-ready ${player.ready ? 'ready' : 'not-ready'}">
              ${player.ready ? '준비완료' : '준비중'}
            </div>
          </div>
          <button class="remove-btn" onclick="removePlayer('${player.id}')">제거</button>
        </div>
      `;
    });

    html += '</div></div>';

    html += '<div class="team-section">';
    html += '<h3>B팀</h3>';
    html += '<div class="team-players">';

    teamB.forEach((player) => {
      html += `
        <div class="player-card">
          <div class="player-avatar">
            <img src="${player.avatar || '/uploads/avatars/default.svg'}"
                 alt="${player.name || ''}"
                 onerror="this.src='/uploads/avatars/default.svg'">
          </div>
          <div class="player-info">
            <div class="player-name">${player.name || ''}</div>
            <div class="player-hp">HP: ${player.hp}/${player.maxHp}</div>
            <div class="player-stats">
              공격:${player.stats?.attack ?? '-'} 방어:${player.stats?.defense ?? '-'}
              민첩:${player.stats?.agility ?? '-'} 행운:${player.stats?.luck ?? '-'}
            </div>
            <div class="player-items">
              디터니:${player.items?.dittany || player.items?.ditany || 0}
              공격보정:${player.items?.attackBooster || player.items?.attack_boost || 0}
              방어보정:${player.items?.defenseBooster || player.items?.defense_boost || 0}
            </div>
            <div class="player-ready ${player.ready ? 'ready' : 'not-ready'}">
              ${player.ready ? '준비완료' : '준비중'}
            </div>
          </div>
          <button class="remove-btn" onclick="removePlayer('${player.id}')">제거</button>
        </div>
      `;
    });

    html += '</div></div>';
    container.innerHTML = html;
  }

  // 로그 추가
  function addLog(data = {}) {
    const container = $('#logContainer');
    if (!container) return;

    const logDiv = document.createElement('div');
    logDiv.className = 'log-entry';

    // 타입별 스타일링 (기존 클래스명 유지)
    const t = data.type;
    if (t === 'battle' || t === 'round') {
      logDiv.classList.add('log-battle');
    } else if (t === 'error') {
      logDiv.classList.add('log-error');
    } else if (t === 'system') {
      logDiv.classList.add('log-system');
    }

    const time = new Date(data.ts || Date.now()).toLocaleTimeString();
    const message = String(data.message || '');

    logDiv.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-message">${message}</span>
    `;

    container.appendChild(logDiv);
    container.scrollTop = container.scrollHeight;
  }

  // 채팅 추가
  function addChat(data = {}) {
    const container = $('#chatContainer');
    if (!container) return;

    const chatDiv = document.createElement('div');
    chatDiv.className = 'chat-entry';

    const time = new Date().toLocaleTimeString();
    const name = String(data.name || '익명');
    const message = String(data.message || '');

    chatDiv.innerHTML = `
      <span class="chat-time">${time}</span>
      <span class="chat-name">${name}:</span>
      <span class="chat-message">${message}</span>
    `;

    container.appendChild(chatDiv);
    container.scrollTop = container.scrollHeight;
  }

  // 클립보드 복사
  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => alert('링크가 복사되었습니다'))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      alert('링크가 복사되었습니다');
    } catch (err) {
      alert('복사 실패');
    }
    document.body.removeChild(textarea);
  }

  // 링크 복사
  function copyLink(url) {
    copyToClipboard(url);
  }

  // 채팅 전송
  function sendChat() {
    const input = $('#chatMsg');
    const message = input?.value?.trim();

    if (!message || !currentBattleId) return;

    const s = initSocket();
    s.emit(
      'chatMessage',
      {
        battleId: currentBattleId,
        name: '관리자',
        message,
      },
      (response) => {
        if (response?.ok && input) input.value = '';
      },
    );
  }

  // 이벤트 리스너 등록
  function setupEventListeners() {
    // 전투 제어 버튼들
    $('#btnCreate')?.addEventListener('click', createBattle);
    $('#btnStart')?.addEventListener('click', startBattle);
    $('#btnPause')?.addEventListener('click', pauseBattle);
    $('#btnResume')?.addEventListener('click', resumeBattle);
    $('#btnEnd')?.addEventListener('click', endBattle);

    // 전투 참가자 관리
    $('#btnAddPlayer')?.addEventListener('click', addPlayer);

    // 링크 생성
    $('#btnGenPlayerLinks')?.addEventListener('click', generateLinks);
    $('#btnGenSpectatorLink')?.addEventListener('click', generateLinks);

    // 채팅
    $('#btnSend')?.addEventListener('click', sendChat);
    $('#chatMsg')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }

  // 전역 함수로 노출 (HTML에서 호출용)
  window.removePlayer = removePlayer;
  window.copyLink = copyLink;

  // 초기화
  function init() {
    console.log('관리자 페이지 초기화 중...');
    initSocket();
    setupEventListeners();

    // URL에서 battleId 확인
    const urlParams = new URLSearchParams(window.location.search);
    const battleIdFromUrl = urlParams.get('battle');
    if (battleIdFromUrl) {
      currentBattleId = battleIdFromUrl;
      if ($('#currentBattleId')) $('#currentBattleId').textContent = battleIdFromUrl;
      socket?.emit('join', { battleId: currentBattleId });
    }

    console.log('관리자 페이지 초기화 완료');
  }

  // DOM 로드 후 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
