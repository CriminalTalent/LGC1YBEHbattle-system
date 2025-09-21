// PYXIS 배틀 시스템 - 소켓 핸들러 (중복 방지)
const BattleEngine = require('./battle-engine');

class SocketHandler {
  constructor(io) {
    this.io = io;
    this.battleEngine = new BattleEngine();
    this.lastBroadcast = new Map(); // 중복 브로드캐스트 방지
    this.setupHandlers();
  }

  setupHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[SOCKET] 클라이언트 연결: ${socket.id}`);

      let currentBattle = null;
      let currentPlayerId = null;
      let displayName = null;
      let joinedRole = null;
      let joinedTeamAB = null;

      // 방 입장
      socket.on('join', ({ battleId }) => {
        if (!battleId) return;

        const battle = this.battleEngine.get(battleId);
        if (!battle) {
          socket.emit('error', { message: '전투를 찾을 수 없습니다' });
          return;
        }

        currentBattle = battleId;
        socket.join(`battle_${battleId}`);

        // 현재 상태 전송
        const snapshot = this.battleEngine.snapshot(battleId);
        if (snapshot) {
          socket.emit('battleUpdate', snapshot);
          socket.emit('battle:update', snapshot);
        }
      });

      // 전투 생성
      socket.on('createBattle', ({ mode = '2v2' }, callback = () => {}) => {
        try {
          const battle = this.battleEngine.create(mode);
          currentBattle = battle.id;
          socket.join(`battle_${battle.id}`);

          callback({ ok: true, battleId: battle.id, battle });

          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${mode} 전투가 생성되었습니다`
          });

          this.broadcastBattleUpdate(battle);
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 전투 시작
      socket.on('startBattle', ({ battleId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          if (!id) return callback({ ok: false, error: 'battleId required' });

          const started = this.battleEngine.start(id);
          if (!started) {
            return callback({ ok: false, error: '전투를 시작할 수 없습니다' });
          }

          const battle = this.battleEngine.get(id);
          callback({ ok: true });

          this.broadcastBattleUpdate(battle);
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 전투 일시정지
      socket.on('pauseBattle', ({ battleId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const battle = this.battleEngine.get(id);
          if (!battle) return callback({ ok: false, error: 'not found' });

          battle.status = 'paused';
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: '전투가 일시정지되었습니다'
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 전투 재개
      socket.on('resumeBattle', ({ battleId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const battle = this.battleEngine.get(id);
          if (!battle) return callback({ ok: false, error: 'not found' });

          battle.status = 'active';
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: '전투가 재개되었습니다'
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 전투 종료
      socket.on('endBattle', ({ battleId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const battle = this.battleEngine.get(id);
          if (!battle) return callback({ ok: false, error: 'not found' });

          battle.status = 'ended';
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: '전투가 종료되었습니다'
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 플레이어 추가
      socket.on('addPlayer', ({ battleId, player }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const addedPlayer = this.battleEngine.addPlayer(id, player);
          if (!addedPlayer) {
            return callback({ ok: false, error: '플레이어 추가에 실패했습니다' });
          }

          const battle = this.battleEngine.get(id);
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${addedPlayer.name}이(가) ${addedPlayer.team}팀에 입장했습니다`
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true, player: addedPlayer });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 플레이어 제거 (양쪽 이벤트 동일 처리)
      socket.on('deletePlayer', ({ battleId, playerId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const removedPlayer = this.battleEngine.removePlayer(id, playerId);
          if (!removedPlayer) {
            return callback({ ok: false, error: '플레이어를 찾을 수 없습니다' });
          }

          const battle = this.battleEngine.get(id);
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${removedPlayer.name}이(가) 퇴장했습니다`
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      socket.on('removePlayer', ({ battleId, playerId }, callback = () => {}) => {
        // deletePlayer와 동일 처리 (서버 내부에서 직접 처리)
        try {
          const id = battleId || currentBattle;
          const removedPlayer = this.battleEngine.removePlayer(id, playerId);
          if (!removedPlayer) {
            return callback({ ok: false, error: '플레이어를 찾을 수 없습니다' });
          }

          const battle = this.battleEngine.get(id);
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${removedPlayer.name}이(가) 퇴장했습니다`
          });

          this.broadcastBattleUpdate(battle);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 플레이어 인증
      socket.on('playerAuth', ({ battleId, name, token, team }, callback) => {
        try {
          const battle = this.battleEngine.get(battleId);
          if (!battle) {
            socket.emit('authError', { error: 'not found' });
            return callback?.({ ok: false, error: 'not found' });
          }

          let player = null;
          // 토큰으로 인증 시도
          if (token) {
            player = battle.players.find(p => p.token === token);
          }
          // 이름으로 인증 시도
          if (!player && name) {
            player = battle.players.find(p => p.name === name);
          }

          if (!player) {
            socket.emit('authError', { error: 'auth failed' });
            return callback?.({ ok: false, error: 'auth failed' });
          }

          currentBattle = battleId;
          currentPlayerId = player.id;
          displayName = player.name;
          joinedRole = 'player';
          joinedTeamAB = player.team;

          socket.join(`battle_${battleId}`);

          const payload = {
            ok: true,
            playerId: player.id,
            name: player.name,
            team: player.team
          };

          socket.emit('authSuccess', payload);
          socket.emit('auth:success', payload);
          callback?.(payload);

          // 입장 로그
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${player.name} 입장`
          });

          this.broadcastBattleUpdate(battle);
        } catch (error) {
          callback?.({ ok: false, error: error.message });
        }
      });

      // 관전자 인증
      socket.on('spectatorAuth', ({ battleId, otp, name }, callback) => {
        try {
          const battle = this.battleEngine.get(battleId);
          if (!battle) {
            return callback?.({ ok: false, error: 'not found' });
          }

          // OTP 검증 (실제 구현에서는 별도 저장소 사용)
          if (battle.spectatorOtp !== otp) {
            return callback?.({ ok: false, error: 'invalid otp' });
          }

          currentBattle = battleId;
          displayName = name || '관전자';
          joinedRole = 'spectator';

          socket.join(`battle_${battleId}`);
          callback?.({ ok: true });

          // 입장 로그
          battle.logs.push({
            ts: Date.now(),
            type: 'system',
            message: `${displayName} 관전 입장`
          });

          this.broadcastBattleUpdate(battle);
        } catch (error) {
          callback?.({ ok: false, error: error.message });
        }
      });

      // 플레이어 준비 완료 (양쪽 이벤트 동일 처리)
      socket.on('player:ready', ({ battleId, playerId }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const result = this.battleEngine.markReady(id, playerId, true);
          if (!result) {
            return callback({ ok: false, error: '준비 상태 변경 실패' });
          }

          const battle = this.battleEngine.get(id);
          const player = battle?.players.find(p => p.id === playerId);
          if (battle && player) {
            battle.logs.push({
              ts: Date.now(),
              type: 'system',
              message: `${player.name} 준비완료`
            });

            this.broadcastBattleUpdate(battle);
          }

          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      socket.on('playerReady', ({ battleId, playerId, ready = true }, callback = () => {}) => {
        // player:ready와 동일 처리(루프백 emit 대신 직접 처리하도록 유지)
        try {
          const id = battleId || currentBattle;
          const result = this.battleEngine.markReady(id, playerId, !!ready);
          if (!result) {
            return callback({ ok: false, error: '준비 상태 변경 실패' });
          }

          const battle = this.battleEngine.get(id);
          const player = battle?.players.find(p => p.id === playerId);
          if (battle && player) {
            battle.logs.push({
              ts: Date.now(),
              type: 'system',
              message: `${player.name} 준비완료`
            });
            this.broadcastBattleUpdate(battle);
          }

          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 플레이어 행동 (양쪽 이벤트 동일 처리)
      socket.on('player:action', ({ battleId, playerId, action }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          const result = this.battleEngine.playerAction(id, playerId, action);
          if (!result) {
            return callback({ ok: false, error: '행동 처리 실패' });
          }

          // 성공 응답 (양쪽 이벤트 모두 발송)
          socket.emit('actionSuccess', { ok: true, result: result.result });
          socket.emit('player:action:success', { ok: true, result: result.result });

          this.broadcastBattleUpdate(result.b);
          callback({ ok: true, result: result.result });
        } catch (error) {
          socket.emit('actionError', { error: error.message });
          callback({ ok: false, error: error.message });
        }
      });

      socket.on('playerAction', ({ battleId, playerId, action }, callback = () => {}) => {
        // player:action과 동일 처리(루프백 emit 대신 직접 처리)
        try {
          const id = battleId || currentBattle;
          const result = this.battleEngine.playerAction(id, playerId, action);
          if (!result) {
            return callback({ ok: false, error: '행동 처리 실패' });
          }

          socket.emit('actionSuccess', { ok: true, result: result.result });
          socket.emit('player:action:success', { ok: true, result: result.result });

          this.broadcastBattleUpdate(result.b);
          callback({ ok: true, result: result.result });
        } catch (error) {
          socket.emit('actionError', { error: error.message });
          callback({ ok: false, error: error.message });
        }
      });

      // 채팅 메시지 (단일 이벤트 수신, 양쪽 이벤트 발송)
      socket.on('chatMessage', ({ battleId, name, message }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          if (!id) return callback({ ok: false, error: 'no battle' });

          const chatData = {
            name: name || displayName || '익명',
            message: String(message || '').slice(0, 500),
            ts: Date.now() // 일관된 타임스탬프 키 사용
          };

          // 중복 방지를 위한 단일 브로드캐스트
          this.broadcastChat(id, chatData);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 응원 메시지 (관전자 전용)
      socket.on('spectator:cheer', ({ battleId, message, name }, callback = () => {}) => {
        try {
          const id = battleId || currentBattle;
          if (!id) return callback({ ok: false, error: 'no battle' });

          const cheerMessage = String(message || '').trim();
          if (!cheerMessage) return callback({ ok: false, error: 'empty message' });

          const cheerData = {
            name: name || displayName || '관전자',
            message: cheerMessage,
            type: 'cheer', // 관전자 클라이언트의 필터와 일치
            ts: Date.now()
          };

          // 응원은 채팅에만 표시 (로그에는 기록하지 않음)
          this.broadcastChat(id, cheerData);
          callback({ ok: true });
        } catch (error) {
          callback({ ok: false, error: error.message });
        }
      });

      // 연결 해제
      socket.on('disconnect', () => {
        console.log(`[SOCKET] 클라이언트 연결 해제: ${socket.id}`);

        if (currentBattle && displayName) {
          const battle = this.battleEngine.get(currentBattle);
          if (battle) {
            battle.logs.push({
              ts: Date.now(),
              type: 'system',
              message: `${displayName} 연결 해제`
            });

            this.broadcastBattleUpdate(battle);
          }
        }
      });
    });
  }

  // 배틀 업데이트 브로드캐스트 (중복 방지)
  broadcastBattleUpdate(battle) {
    const battleId = battle.id;
    const snapshot = this.battleEngine.snapshot(battleId);
    if (!snapshot) return;

    // 중복 방지를 위한 시간 체크
    const now = Date.now();
    const lastTime = this.lastBroadcast.get(`update_${battleId}`) || 0;

    if (now - lastTime < 100) return; // 100ms 내 중복 방지
    this.lastBroadcast.set(`update_${battleId}`, now);

    // 양쪽 이벤트 발송
    this.io.to(`battle_${battleId}`).emit('battleUpdate', snapshot);
    this.io.to(`battle_${battleId}`).emit('battle:update', snapshot);
  }

  // 로그 브로드캐스트 (중복 방지)
  broadcastLog(battleId, logData) {
    const logKey = `log_${battleId}_${logData.message}`;
    const now = Date.now();
    const lastTime = this.lastBroadcast.get(logKey) || 0;

    if (now - lastTime < 1000) return; // 1초 내 같은 메시지 중복 방지
    this.lastBroadcast.set(logKey, now);

    // 양쪽 이벤트 발송
    this.io.to(`battle_${battleId}`).emit('battle:log', logData);
    this.io.to(`battle_${battleId}`).emit('battleLog', logData);
  }

  // 채팅 브로드캐스트 (중복 방지)
  broadcastChat(battleId, chatData) {
    const keyBase = `${chatData.name}_${chatData.message}_${chatData.type || 'chat'}`;
    const chatKey = `chat_${battleId}_${keyBase}`;
    const now = Date.now();
    const lastTime = this.lastBroadcast.get(chatKey) || 0;

    if (now - lastTime < 1000) return; // 1초 내 같은 메시지 중복 방지
    this.lastBroadcast.set(chatKey, now);

    // 양쪽 이벤트 발송
    this.io.to(`battle_${battleId}`).emit('chatMessage', chatData);
    this.io.to(`battle_${battleId}`).emit('battle:chat', chatData);
  }

  // 메모리 정리 (주기적으로 호출)
  cleanup() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5분

    for (const [key, timestamp] of this.lastBroadcast) {
      if (now - timestamp > maxAge) {
        this.lastBroadcast.delete(key);
      }
    }
  }
}

module.exports = SocketHandler;
