// packages/battle-server/public/assets/js/notifications.js
/* PYXIS Notifications
   - 데스크톱 알림 + 사운드
   - 초기화: window.PyxisNotify.init({ socket, enabled?, volume? })
   - 기본 수신 이벤트: battle:update, battle:log, battle:started, battle:ended, turn:start, turn:end
   - 플레이어 턴 감지: window.__PYXIS_PLAYER_ID 값을 사용
   - 이모지 사용 금지
   - 팀 표기는 A/B만 사용 (내부 값이 다른 문자열이어도 A/B로 정규화)
*/
(function () {
  "use strict";

  const TITLE_PREFIX = "PYXIS";

  const Notify = {
    socket: null,
    audio: null,
    enabled: true,
    volume: 0.6,
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
  Notify.init = function ({ socket, enabled = true, volume = 0.6 } = {}) {
    this.socket = socket || null;
    this.enabled = !!enabled;
    this.volume = clamp(Number(volume), 0, 1);

    // 데스크톱 알림 권한 확인/요청
    if (!("Notification" in window)) {
      console.warn("[PYXIS Notify] Notification API not supported.");
    } else if (Notification.permission === "default") {
      // 사용자 제스처 문맥이 아닐 수 있으니, 거절되어도 무시
      try { Notification.requestPermission(); } catch (_) {}
    }

    // 오디오 준비
    try {
      const audio = new Audio("/assets/notify.mp3");
      audio.volume = this.volume;
      this.audio = audio;
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

  // ----------------------------------
  // Socket bindings
  // ----------------------------------
  function bindSocketEvents(socket) {
    // 전투 상태 스냅샷 갱신
    socket.on("battle:update", (b) => {
      if (!b || typeof b !== "object") return;

      const battleId = b.id || b.battleId || null;
      const status = b.status || "waiting";
      const currentPlayerId = b.current || b.currentPlayerId || null;

      // 전투 시작/종료 등 상태 전이 알림
      handleStatusTransition.call(this, battleId, status);

      // 내 턴 알림 (update 이벤트만으로도 처리 시도)
      const meId = window.__PYXIS_PLAYER_ID || null;
      if (meId && currentPlayerId && currentPlayerId === meId) {
        // 턴 안내는 너무 자주 울릴 수 있으니 스로틀
        this._throttledShow("당신의 턴입니다", "지금 행동하세요.", 1500);
      }

      // 내부 최신값 저장
      this._last.battleId = battleId;
      this._last.status = status;
      this._last.currentPlayerId = currentPlayerId;
    });

    // 명시적 턴 시작 이벤트가 있는 경우 우선 사용
    socket.on("turn:start", (p) => {
      const meId = window.__PYXIS_PLAYER_ID || null;
      const pid = p && (p.playerId || p.id);
      if (meId && pid && meId === pid) {
        this._throttledShow("당신의 턴입니다", "지금 행동하세요.", 800);
      }
    });

    // 전투 시작/종료 이벤트
    socket.on("battle:started", (p) => {
      const msg =
        (p && p.message) ||
        "전투가 시작되었습니다.";
      this.show("전투 시작", msg);
      if (p && p.battle && p.battle.id) {
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
      switch (type) {
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
          // 시스템 로그는 너무 잦을 수 있어 표시만 조건부
          if (shouldShowSystem(message)) {
            this._throttledShow("알림", message, 800);
          }
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

  // 팀 표기 통일(A/B)
  function normalizeTeam(raw) {
    const s = String(raw || "").toLowerCase();
    if (!s) return null;
    if (s === "a" || s === "phoenix" || s === "team_a" || s === "team-a") return "A";
    if (s === "b" || s === "eaters"  || s === "team_b" || s === "team-b" || s === "death") return "B";
    // 미지정/알 수 없음
    return null;
  }

  function shouldShowSystem(message = "") {
    // 너무 일반적인 메시지는 생략
    const m = String(message);
    if (!m) return false;
    const low = m.toLowerCase();
    if (low.includes("연결되었습니다") || low.includes("접속")) return false;
    return true;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, isFinite(n) ? n : min));
  }

  // 사운드 + 데스크톱 알림
  Notify.show = function (title, body) {
    if (!this.enabled) return;

    // 페이지가 백그라운드일 때는 알림 우선
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

  function formatTitle(title) {
    const t = String(title || "").trim();
    return t ? `${TITLE_PREFIX} · ${t}` : TITLE_PREFIX;
  }

  // ----------------------------------
  // Export
  // ----------------------------------
  window.PyxisNotify = Notify;
})();
