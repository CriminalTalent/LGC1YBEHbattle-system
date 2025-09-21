/* packages/battle-server/public/assets/js/socket-manager.js
   PYXIS Socket Manager (browser)
   - 서버(index.js) 이벤트와 1:1 매칭 + 구/신 이벤트 양쪽 호환
   - 관리자 새로고침 경고(leave confirm) 강제 해제
   - Admin/Player/Spectator 공용 래퍼
   - 팀 표기는 송수신 시 A/B만 사용(toAB 정규화)
   - 이모지 금지, 콘솔 로깅 강화
*/
(function (root) {
  "use strict";

  /* ──────────────────────────────────────────────
   * 강제: 새로고침/탭닫기 경고(leave confirm) 해제
   * ────────────────────────────────────────────── */
  try {
    window.onbeforeunload = null;
    window.addEventListener(
      "beforeunload",
      function (e) {
        if (e && typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
      },
      true
    );
    try { delete window.onbeforeunload; } catch (_) {}
  } catch (_) {}

  /* ──────────────────────────────────────────────
   * 유틸
   * ────────────────────────────────────────────── */
  const LOGPFX = "[PYXIS/socket]";
  const NOOP = () => {};

  function clampLen(str, n) {
    str = String(str == null ? "" : str);
    return str.length > n ? str.slice(0, n) : str;
  }
  function isFn(fn) { return typeof fn === "function"; }

  // 팀 키 정규화: 항상 'A' / 'B' 로만
  function toAB(t) {
    const s = String(t || "").toLowerCase();
    if (s === "phoenix" || s === "a" || s === "team_a" || s === "team-a") return "A";
    if (s === "eaters" || s === "b" || s === "death" || s === "team_b" || s === "team-b") return "B";
    return "";
  }

  /* ──────────────────────────────────────────────
   * 소켓 매니저
   * ────────────────────────────────────────────── */
  class SocketManager {
    constructor() {
      this.socket = null;
      this.url = undefined;

      // 이벤트 리스너 레지스트리
      this.handlers = new Map();

      // 컨텍스트
      this.ctx = {
        role: "guest",   // admin | player | spectator | guest
        battleId: null,
        playerId: null,
        name: null,
        teamAB: null,    // A/B 정규화된 팀
      };
    }

    /* -----------------------------
     * 연결
     * ----------------------------- */
    connect(url) {
      this.url = url || (root.PyxisSocket && root.PyxisSocket.url) || undefined;

      if (!root.io) {
        console.error(LOGPFX, "Socket.IO가 로드되지 않았습니다.");
        return;
      }

      const socket = root.io(this.url, {
        path: "/socket.io",
        transports: ["websocket", "polling"],
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 4000,
        timeout: 20000,
      });

      this.socket = socket;
      this._bindCore();

      return socket;
    }

    disconnect() {
      if (!this.socket) return;
      try {
        this.socket.off();
        this.socket.close();
      } catch (_) {}
      this.socket = null;
    }

    /* 내부 바인딩 */
    _bindCore() {
      const s = this.socket;
      if (!s) return;

      s.on("connect", () => {
        console.log(LOGPFX, "connected:", s.id);
        this._emitLocal("connect");
      });

      s.on("disconnect", (reason) => {
        console.log(LOGPFX, "disconnect:", reason);
        this._emitLocal("disconnect", reason);
      });

      s.on("error", (err) => {
        console.error(LOGPFX, "socket error:", err);
        this._emitLocal("error", err);
      });

      // ----- 인증/오류 -----
      s.on("auth:success", (payload) => {
        console.log(LOGPFX, "auth success:", payload);
        if (payload?.role) this.ctx.role = payload.role;
        if (payload?.battleId) this.ctx.battleId = payload.battleId;
        if (payload?.playerId) this.ctx.playerId = payload.playerId;
        if (payload?.team) this.ctx.teamAB = toAB(payload.team);
        if (payload?.name) this.ctx.name = payload.name;

        // 자동 룸 조인
        if (this.ctx.battleId) {
          try { this.join(this.ctx.battleId); } catch (_) {}
        }
        this._emitLocal("auth:success", payload);
      });

      s.on("authSuccess", (payload) => {
        // 구 이벤트명도 동일 처리
        s.emit("auth:success", payload);
      });

      s.on("authError", (e) => {
        console.warn(LOGPFX, "auth error:", e);
        this._emitLocal("auth:error", e);
      });
      s.on("auth:error", (e) => {
        console.warn(LOGPFX, "auth error:", e);
        this._emitLocal("auth:error", e);
      });

      // ----- 전투 상태(신/구 혼용 수신 → 단일 로컬 이벤트로 통일) -----
      const forwardBattleUpdate = (b) => this._emitLocal("battle:update", b);
      s.on("battle:update", forwardBattleUpdate);
      s.on("battleUpdate", forwardBattleUpdate);
      s.on("battleState", forwardBattleUpdate);
      s.on("state:update", forwardBattleUpdate);

      s.on("battle:started", (b) => this._emitLocal("battle:started", b));
      s.on("battle:paused",  (b) => this._emitLocal("battle:paused",  b));
      s.on("battle:resumed", (b) => this._emitLocal("battle:resumed", b));
      s.on("battle:ended",   (b) => this._emitLocal("battle:ended",   b));

      // ----- 생성/시작 응답 (서버 이벤트명 양쪽 다 수신) -----
      const forwardCreated = (res) => this._emitLocal("battle:created", res?.battle || res);
      s.on("battle:created", forwardCreated);
      s.on("battleCreated",  forwardCreated);
      s.on("admin:created",  (payload) => forwardCreated(payload?.battle || payload));

      s.on("battleStarted", (res) => this._emitLocal("battle:started:ack", res));

      // 개별 액션 응답
      s.on("playerAdded",   (res) => this._emitLocal("player:added:ack",   res));
      s.on("playerRemoved", (res) => this._emitLocal("player:removed:ack", res));
      s.on("playerUpdated", (res) => this._emitLocal("player:updated:ack", res));
      s.on("action:success",(res) => this._emitLocal("action:success",     res));
      s.on("action:error",  (res) => this._emitLocal("action:error",       res));

      // ----- 채팅/로그(양쪽 이벤트명 호환) -----
      const fwdChat = (msg) => this._emitLocal("battle:chat", msg);
      s.on("battle:chat", fwdChat);
      s.on("chatMessage", (payload) => {
        // 문자열/객체 모두 처리
        if (typeof payload === "string") {
          fwdChat({ name: "플레이어", message: payload });
        } else {
          fwdChat({ name: payload?.name || payload?.senderName || "플레이어", message: payload?.message || "" });
        }
      });
      s.on("chat:message", (payload) => fwdChat({ name: payload?.name || payload?.senderName || "플레이어", message: payload?.message || "" }));

      s.on("battleLog", (line) => this._emitLocal("battle:log", line));
      s.on("battle:log", (line) => this._emitLocal("battle:log", line));

      // ----- 관전자 -----
      s.on("spectator:count", ({ count }) => {
        this._emitLocal("spectator:count", { count: Number(count) || 0 });
      });

      // 기타
      s.on("battleError", (e) => this._emitLocal("battle:error", e));
      s.on("pong", () => this._emitLocal("pong"));
    }

    /* 로컬 이벤트 방출/구독 */
    _emitLocal(evt, payload) {
      const list = this.handlers.get(evt);
      if (list && list.length) {
        list.forEach((fn) => {
          try { fn(payload); } catch (e) { console.error(LOGPFX, "handler error", evt, e); }
        });
      }
    }
    on(evt, handler) {
      if (!this.handlers.has(evt)) this.handlers.set(evt, []);
      this.handlers.get(evt).push(handler);
      return () => this.off(evt, handler);
    }
    once(evt, handler) {
      const off = this.on(evt, (p) => { try { handler(p); } finally { off(); } });
      return off;
    }
    off(evt, handler) {
      const arr = this.handlers.get(evt) || [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
    offAll() {
      this.handlers.clear();
    }

    /* -----------------------------
     * 공통
     * ----------------------------- */
    join(battleId) {
      const id = battleId || this.ctx.battleId;
      if (!this.socket || !id) return;
      this.socket.emit("join", { battleId: id });
    }

    sendChat(message, opt = {}) {
      if (!this.socket) return;
      const payload = {
        battleId: opt.battleId || this.ctx.battleId,
        name: clampLen(opt.name || this.ctx.name || "", 30),
        message: clampLen(message || "", 200),
        // 팀은 항상 A/B로만 송신
        team: toAB(opt.team || this.ctx.teamAB || ""),
        role: opt.role || this.ctx.role || "player",
      };
      if (!payload.battleId || !payload.message) return;
      // 구/신 이벤트 동시 전송
this.socket.emit("chatMessage", payload);
    }

    sendCheer(cheer, opt = {}) {
      if (!this.socket) return;
      const payload = {
        battleId: opt.battleId || this.ctx.battleId,
        message: clampLen(cheer || "", 100),            // 레거시 호환 위해 key는 message로도 넣자
        cheer: clampLen(cheer || "", 100),
        name: clampLen(opt.name || this.ctx.name || "", 30),
        team: toAB(opt.team || this.ctx.teamAB || ""),
      };
      if (!payload.battleId || !payload.cheer) return;
      // 신규 + 레거시 모두 발사
      this.socket.emit("cheer:send", payload);
      this.socket.emit("cheerMessage", payload);
      this.socket.emit("spectator:cheer", payload);
    }

    ping() {
      if (!this.socket) return;
      this.socket.emit("ping");
    }

    getContext() {
      return { ...this.ctx };
    }
    setContextPatch(patch = {}) {
      const next = { ...this.ctx, ...patch };
      if (patch.teamAB != null) next.teamAB = toAB(patch.teamAB);
      this.ctx = next;
      return this.getContext();
    }

    /* -----------------------------
     * 관리자
     * ----------------------------- */
    adminAuth(battleId, token) {
      if (!this.socket) return;
      this.ctx.role = "admin";
      this.ctx.battleId = battleId;
      this.socket.emit("adminAuth", { battleId, token });
    }

    createBattle(mode = "1v1") {
      if (!this.socket) return;
      this.socket.emit("createBattle", { mode });
      this.socket.emit("battle:create", { mode }); // 호환
    }

    startBattle(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("startBattle", { battleId: id });
      this.socket.emit("battle:start", { battleId: id }); // 호환
    }

    pauseBattle(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("pauseBattle", { battleId: id });
      this.socket.emit("battle:pause", { battleId: id }); // 호환
    }

    resumeBattle(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("resumeBattle", { battleId: id });
      this.socket.emit("battle:resume", { battleId: id }); // 호환
    }

    endBattle(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("endBattle", { battleId: id });
      this.socket.emit("battle:end", { battleId: id }); // 호환
    }

    addPlayer(battleId, playerData) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;

      // 팀 정규화 + 서버 규격 키(player)로 고정
      const p = { ...(playerData || {}) };
      p.team = toAB(p.team) || "A";

      const payload = { battleId: id, player: p };
      this.socket.emit("addPlayer", payload);
      this.socket.emit("admin:addPlayer", payload); // 호환
    }

    removePlayer(battleId, playerId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id || !playerId) return;
      this.socket.emit("removePlayer", { battleId: id, playerId });
      this.socket.emit("admin:removePlayer", { battleId: id, playerId }); // 호환
    }

    updatePlayer(battleId, playerId, updates) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id || !playerId) return;
      // 팀 업데이트 시에도 정규화
      const up = { ...(updates || {}) };
      if (up.team != null) up.team = toAB(up.team) || "A";
      this.socket.emit("updatePlayer", { battleId: id, playerId, updates: up });
      this.socket.emit("admin:updatePlayer", { battleId: id, playerId, updates: up }); // 호환
    }

    generatePlayerLinks(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("generatePlayerPassword", { battleId: id });
    }

    generateSpectatorUrl(battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id) return;
      this.socket.emit("generateSpectatorOtp", { battleId: id });
    }

    /* -----------------------------
     * 플레이어
     * ----------------------------- */
    playerAuth({ battleId, name, token, team }) {
      if (!this.socket) return;
      this.ctx.role = "player";
      this.ctx.battleId = battleId;
      this.ctx.name = name || null;
      this.ctx.teamAB = toAB(team);
      this.socket.emit("playerAuth", { battleId, name, token, team: this.ctx.teamAB });
    }

    playerReady(playerId, battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id || !playerId) return;
      // 신규/레거시 동시
      this.socket.emit("player:ready", { battleId: id, playerId });
      this.socket.emit("playerReady",   { battleId: id, playerId, ready: true });
    }

    playerAction(playerId, action, battleId) {
      if (!this.socket) return;
      const id = battleId || this.ctx.battleId; if (!id || !playerId || !action) return;

      // 신규this.socket.emit("player:action", { battleId: id, playerId, action });
}

    /* -----------------------------
     * 관전자
     * ----------------------------- */
    spectatorAuth({ battleId, otp, name }) {
      if (!this.socket) return;
      this.ctx.role = "spectator";
      this.ctx.battleId = battleId;
      this.ctx.name = name || null;
      this.socket.emit("spectatorAuth", { battleId, otp, name });
    }
  }

  // 싱글턴 제공
  root.PyxisSocketManager = new SocketManager();

  // 편의 노출
  root.PyxisSocketAPI = {
    connect: (url) => root.PyxisSocketManager.connect(url),
    disconnect: () => root.PyxisSocketManager.disconnect(),

    // 공통
    join: (id) => root.PyxisSocketManager.join(id),
    sendChat: (msg, opt) => root.PyxisSocketManager.sendChat(msg, opt),
    sendCheer: (msg, opt) => root.PyxisSocketManager.sendCheer(msg, opt),
    on: (evt, fn) => root.PyxisSocketManager.on(evt, fn),
    once: (evt, fn) => root.PyxisSocketManager.once(evt, fn),
    off: (evt, fn) => root.PyxisSocketManager.off(evt, fn),
    offAll: () => root.PyxisSocketManager.offAll(),
    ping: () => root.PyxisSocketManager.ping(),
    getContext: () => root.PyxisSocketManager.getContext(),
    setContextPatch: (p) => root.PyxisSocketManager.setContextPatch(p),

    // 관리자
    adminAuth: (id, token) => root.PyxisSocketManager.adminAuth(id, token),
    createBattle: (mode) => root.PyxisSocketManager.createBattle(mode),
    startBattle: (id) => root.PyxisSocketManager.startBattle(id),
    pauseBattle: (id) => root.PyxisSocketManager.pauseBattle(id),
    resumeBattle: (id) => root.PyxisSocketManager.resumeBattle(id),
    endBattle: (id) => root.PyxisSocketManager.endBattle(id),
    addPlayer: (id, data) => root.PyxisSocketManager.addPlayer(id, data),
    removePlayer: (id, pid) => root.PyxisSocketManager.removePlayer(id, pid),
    updatePlayer: (id, pid, up) => root.PyxisSocketManager.updatePlayer(id, pid, up),
    generatePlayerLinks: (id) => root.PyxisSocketManager.generatePlayerLinks(id),
    generateSpectatorUrl: (id) => root.PyxisSocketManager.generateSpectatorUrl(id),

    // 플레이어
    playerAuth: (args) => root.PyxisSocketManager.playerAuth(args),
    playerReady: (pid, id) => root.PyxisSocketManager.playerReady(pid, id),
    playerAction: (pid, action, id) => root.PyxisSocketManager.playerAction(pid, action, id),

    // 관전자
    spectatorAuth: (args) => root.PyxisSocketManager.spectatorAuth(args),
  };
})(typeof window !== "undefined" ? window : this);
