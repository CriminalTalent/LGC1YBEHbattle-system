// packages/battle-server/public/assets/js/notifications.js
/* PYXIS Notifications
   - 데스크톱 알림 + 사운드
   - 초기화: window.PyxisNotify.init({ socket, enabled?, volume?, backgroundOnly? })
   - 기본 수신 이벤트: battle:update, battle:log, battle:started, battle:ended, turn:start
   - 플레이어 턴 감지: window.__PYXIS_PLAYER_ID 값을 사용
   - 이모지 사용 금지
   - 팀 표기는 A/B만 사용 (내부 값은 정규화)
*/
(function () {
  "use strict";

  const TITLE_PREFIX = "PYXIS";

  const Notify = {
    socket: null,
    audio: null,
    enabled: true,
    volume: 0.6,
    backgroundOnly: true, // 탭이 백그라운드일 때만 알림/사운드 (기본 on)
    // 중복/스팸 방지용 내부 상태
    _last: {
      battleId: null,
      status: null,
      currentPlayerId: null,
      lastShownAt: 0
    }
  };

  // ----------------------------------
  // Public API
  // ----------------------------------
  Notify.init = function ({ socket, enabled = true, volume = 0.6, backgroundOnly = true } = {}) {
    this.socket = socket || null;
    this.enabled = !!enabled;
    this.volume = clamp(Number(volume), 0, 1);
    this.backgroundOnly = !!backgroundOnly;

    // 데스크톱 알림 권한 확인/요청
    if (!("Notification" in window)) {
      console.warn("[PYXIS Notify] Notification API not supported.");
    } else if (Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (_) {}
    }

    // 오디오 준비 + 사용자 제스처 해제 처리
    try {
      const audio = new Audio("/assets/notify.mp3");
      audio.volume = this.volume;
      this.audio = audio;
      unlockAudioOnGesture(audio);
    } catch (e) {
      console.warn("[PYXIS Notify] Audio init failed", e);
      this.audio = null;
    }

    if (!socket) return;
    bindSocketEvents.call(this, socket);
  };

  Notify.setEnabled = function (on) {
    this.enabled = !!on;
  };

  Notify.setVolume = function (vol) {
    this.volume = clamp(Number(vol), 0, 1);
    if (this.audio) this.audio.volume = this.volume;
  };

  Notify.setBackgroundOnly = function (on) {
    this.backgroundOnly = !!on;
  };

  // ----------------------------------
  // Socket bindings
  // ----------------------------------
  function bindSocketEvents(socket) {
    // 전투 상태 스냅샷 갱신
    socket.on("battle:update", (b = {}) => {
      if (typeof b !== "object") return;

      const battleId = b.id || b.battleId || null;
      const status = b.status || "waiting";

      // 다양한 스냅샷 형태에서 현재 플레이어 id 추출
      const currentPlayerId =
        b.current?.id ||
        b.currentPlayerId ||
        b.currentTurn?.currentPlayer?.id ||
        b.currentTurn?.playerId ||
        null;

      // 전투 시작/종료 등 상태 전이 알림
      handleStatusTransition.call(this, battleId, status);

      // 내 턴 알림 (update 이벤트만으로도 처리)
      const meId = window.__PYXIS_PLAYER_ID || null;
      if (meId && currentPlayerId && currentPlayerId === meId) {
        this._throttledShow("당신의 턴입니다", "지금 행동하세요.", 1500);
      }

      // 내부 최신값 저장
      this._last.battleId = battleId;
      this._last.status = status;
      this._last.currentPlayerId = currentPlayerId;
    });

    // 명시적 턴 시작 이벤트가 있는 경우
    socket.on("turn:start", (p = {}) => {
      const meId = window.__PYXIS_PLAYER_ID || null;
      const pid = p.playerId || p.id || null;
      if (meId && pid && meId === pid) {
        this._throttledShow("당신의 턴입니다", "지금 행동하세요.", 800);
      }
    });

    // 전투 시작/종료 이벤트
    socket.on("battle:started", (p = {}) => {
      const msg = p.message || "전투가 시작되었습니다.";
      this.show("전투 시작", msg);
      if (p.battle && p.battle.id) {
        this._last.battleId = p.battle.id;
        this._last.status = "active";
      }
    });

    socket.on("battle:ended", (p = {}) => {
      const winnerAB = normalizeTeam(p.winner);
      const msg = p.message
        ? p.message
        : (typeof winnerAB === "string"
            ? `${winnerAB}팀의 승리입니다.`
            : "전투가 종료되었습니다.");
      this.show("전투 종료", msg);
      this._last.status = "ended";
    });

    // 로그 이벤트(타입 기반 간단 알림)
    socket.on("battle:log", ({ type, message } = {}) => {
      if (!message) return;
      switch (String(type || "").toLowerCase()) {
        case "attack":
          this._throttledShow("공격", message, 600);
          break;
        case "defend":
        case "defense":
          this._throttledShow("방어", message, 600);
          break;
        case "evade":
        case "dodge":
          this._throttledShow("회피", message, 600);
          break;
        case "cheer":
          this._throttledShow("응원", message, 600);
          break;
        case "system":
          if (shouldShowSystem(message)) this._throttledShow("알림", message, 800);
          break;
        default:
          // 기타 타입은 무시
          break;
      }
    });
  }

  // ----------------------------------
  // Helpers
  // ----------------------------------
  function handleStatusTransition(battleId, status) {
    const prevStatus = this._last.status;
    if (prevStatus === status) return;

    if (status === "active") {
      this.show("전투 시작", "전투가 시작되었습니다.");
    } else if (status === "paused") {
      this.show("일시정지", "전투가 일시정지되었습니다.");
    } else if (status === "ended") {
      this.show("전투 종료", "전투가 종료되었습니다.");
    } else if (status === "waiting") {
      this.show("대기", "전투가 곧 시작됩니다.");
    }
  }

  // 팀 표기 통일(A/B) — 다양한 내부 표기를 수렴
  function normalizeTeam(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return null;

    // 영문/기호
    if (["a", "team_a", "team-a", "phoenix", "order", "phoenix_order"].includes(s)) return "A";
    if (["b", "team_b", "team-b", "eaters", "death", "death_eaters"].includes(s)) return "B";

    // 한글(불사조 기사단 / 죽음을 먹는 자)
    if (s.includes("불사조")) return "A";
    if (s.includes("죽음") || s.includes("먹는 자")) return "B";

    return null;
  }

  function shouldShowSystem(message = "") {
    const m = String(message).toLowerCase();
    if (!m) return false;
    if (m.includes("연결되었습니다") || m.includes("접속")) return false;
    return true;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, isFinite(n) ? n : min));
  }

  function formatTitle(title) {
    const t = String(title || "").trim();
    return t ? `${TITLE_PREFIX} · ${t}` : TITLE_PREFIX;
  }

  // 사용자 제스처로 오디오 잠금 해제
  function unlockAudioOnGesture(audio) {
    if (!audio) return;
    const unlock = () => {
      try {
        audio.muted = true;
        const p = audio.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = false;
            remove();
          }).catch(remove);
        } else {
          remove();
        }
      } catch (_) { remove(); }
    };
    const remove = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true, passive: true });
  }

  // 사운드 + 데스크톱 알림
  Notify.show = function (title, body) {
    if (!this.enabled) return;

    // 포그라운드에서 울리기 싫다면 차단
    if (this.backgroundOnly && document.visibilityState === "visible") return;

    // 데스크톱 알림
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(formatTitle(title), {
          body: body || "",
          icon: "/assets/icon.png"
        });
        setTimeout(() => n.close(), 4000);
      } catch (_) {}
    }

    // 사운드
    if (this.audio) {
      try {
        this.audio.currentTime = 0;
        const p = this.audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {}
    }
  };

  // 간단 스로틀 포함 알림
  Notify._throttledShow = function (title, body, ms = 800) {
    const now = Date.now();
    if (now - (this._last.lastShownAt || 0) < ms) return;
    this._last.lastShownAt = now;
    this.show(title, body);
  };

  // ----------------------------------
  // Export
  // ----------------------------------
  window.PyxisNotify = Notify;
})();
