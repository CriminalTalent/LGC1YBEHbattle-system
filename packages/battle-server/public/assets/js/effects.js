/* PYXIS Effects.js
   - 전투 UI 보조 애니메이션 / 시각 효과 컨트롤러
   - /assets/css/effects.css 와 연동
   - 이모지 금지 (유니코드 장식은 CSS로만)
   - 팀 표기는 규정대로 A/B만 사용
*/
(function () {
  "use strict";

  var BANNER_ID = "pyxis-result-banner";

  var Effects = {
    init: function () {
      try {
        this.ensureBanner();
        this.bindCheerButtons();
        this.observeTimeline();
        this.twinkleStars();
        this.bindCardHover();
        this.bindButtonShimmer();
        this.applyBackdropBlur();
      } catch (e) {
        // 효과는 보조 기능이므로 실패해도 앱 동작에 영향 주지 않음
        if (window && window.console) console.debug("[effects] init error:", e);
      }
    },

    /* ─────────────────────────────
     * 기본 인터랙션
     * ───────────────────────────── */
    bindCheerButtons: function () {
      var buttons = document.querySelectorAll(".cheer-btn");
      buttons.forEach(function (btn) {
        btn.addEventListener("click", function () {
          btn.classList.add("shimmer");
          setTimeout(function () { btn.classList.remove("shimmer"); }, 1500);
        });
      });
    },

    observeTimeline: function () {
      var timeline =
        document.getElementById("timelineFeed") ||
        document.getElementById("battleLog") ||
        document.getElementById("log");
      if (!timeline || !("MutationObserver" in window)) return;

      var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node && node.nodeType === 1) {
              node.classList.add("tl-flash");
              setTimeout(function () { node.classList.remove("tl-flash"); }, 1200);
            }
          });
        });
      });

      observer.observe(timeline, { childList: true });
    },

    twinkleStars: function () {
      var stars = document.querySelectorAll(".twinkle-star");
      stars.forEach(function (star) {
        setInterval(function () {
          star.classList.add("twinkle");
          setTimeout(function () { star.classList.remove("twinkle"); }, 1200 + Math.random() * 800);
        }, 2000 + Math.random() * 2000);
      });
    },

    bindCardHover: function () {
      var cards = document.querySelectorAll(".battle-card, .info-card, .card");
      cards.forEach(function (card) {
        card.addEventListener("mouseenter", function () { card.classList.add("lift"); });
        card.addEventListener("mouseleave", function () { card.classList.remove("lift"); });
      });
    },

    bindButtonShimmer: function () {
      var buttons = document.querySelectorAll(".shimmer-btn, .premium-btn, .btn");
      buttons.forEach(function (btn) {
        btn.addEventListener("mouseenter", function () { btn.classList.add("shimmer"); });
        btn.addEventListener("mouseleave", function () { btn.classList.remove("shimmer"); });
      });
    },

    applyBackdropBlur: function () {
      var panels = document.querySelectorAll(".glass, .battle-card, .info-card, .modal, .backdrop-blur");
      panels.forEach(function (el) { el.classList.add("backdrop-blur"); });
    },

    /* ─────────────────────────────
     * 배너
     * ───────────────────────────── */
    ensureBanner: function () {
      if (document.getElementById(BANNER_ID)) return;
      var el = document.createElement("div");
      el.id = BANNER_ID;
      el.className = "pyxis-banner";
      document.body.appendChild(el);
    },

    showResultBanner: function (text, type, holdMs) {
      var el = document.getElementById(BANNER_ID);
      if (!el) return;
      el.textContent = String(text || "");
      el.className = "pyxis-banner show " + (type || "info");
      clearTimeout(this._bannerTimer);
      this._bannerTimer = setTimeout(function () {
        el.className = "pyxis-banner";
      }, Math.max(holdMs || 1400, 1200));
    },

    /* ─────────────────────────────
     * 로그 꾸미기
     * ───────────────────────────── */
    tagLog: function (div, kind) {
      if (!div) return;
      div.classList.add("log-item");
      if (kind) div.classList.add(kind);
    },

    /* ─────────────────────────────
     * 규정 이벤트 배너(팀 표기 A/B 고정)
     * ───────────────────────────── */
    bannerFirst: function (teamAB) {
      var t = teamAB === "A" ? "A" : teamAB === "B" ? "B" : "?";
      this.showResultBanner("선공: " + t + "팀", "first");
    },
    bannerKill: function (name) {
      this.showResultBanner(String(name || "") + " 사망", "kill");
    },
    bannerWin: function (teamAB) {
      var t = teamAB === "A" ? "A" : teamAB === "B" ? "B" : "?";
      this.showResultBanner(t + "팀 승리", "win", 2000);
    },
    bannerResolve: function () {
      this.showResultBanner("라운드 해석", "resolve");
    },
    bannerCommit: function (teamAB) {
      var t = teamAB === "A" ? "A" : teamAB === "B" ? "B" : "?";
      this.showResultBanner("커밋 시작: " + t + "팀", "commit");
    },

    /* ─────────────────────────────
     * 룰 보조 배너
     * ───────────────────────────── */
    bannerCritical: function (attackerName) {
      this.showResultBanner(String(attackerName || "") + " 치명타", "critical");
    },
    bannerDodgeSuccess: function (defenderName) {
      this.showResultBanner(String(defenderName || "") + " 회피 성공", "dodge");
    },
    bannerDefendSuccess: function (defenderName) {
      this.showResultBanner(String(defenderName || "") + " 방어 성공", "defend");
    },
    bannerUseItem: function (playerName, itemName) {
      this.showResultBanner(String(playerName || "") + " " + String(itemName || "") + " 사용", "item");
    }
  };

  window.PyxisEffects = Effects;
  window.addEventListener("DOMContentLoaded", function () { Effects.init(); });
})();
