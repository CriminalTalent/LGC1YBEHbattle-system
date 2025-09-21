/* PYXIS UI Helpers (browser)
   - 관리자/플레이어/관전자 공용 헬퍼
   - PyxisNotify(알림) 연동, 없으면 자체 토스트 폴백
   - 팀 표기는 A/B만 사용
   - 이모지 금지
*/
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.UIHelpers = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // ──────────────────────────────────────────────
  // DOM 기본
  // ──────────────────────────────────────────────
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function on(el, evt, fn, opts) {
    if (!el) return () => {};
    el.addEventListener(evt, fn, opts);
    return () => el.removeEventListener(evt, fn, opts);
  }
  function once(el, evt, fn, opts) {
    return on(el, evt, function h(e){ el.removeEventListener(evt, h, opts); fn(e); }, opts);
  }
  function delegate(root, evt, selector, handler) {
    return on(root, evt, (e) => {
      const t = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (t && root.contains(t)) handler.call(t, e);
    });
  }

  function addClass(el, ...names)    { if (el) el.classList.add(...names); }
  function removeClass(el, ...names) { if (el) el.classList.remove(...names); }
  function toggleClass(el, name, f)  { if (el) el.classList.toggle(name, f); }
  function hasClass(el, name)        { return !!(el && el.classList.contains(name)); }

  // 상태/표시
  function setDisabled(el, on = true) { if (el) el.disabled = !!on; }
  function show(el)  { if (el) el.classList.remove("hidden"); }
  function hide(el)  { if (el) el.classList.add("hidden"); }
  function setVisible(el, vis) { vis ? show(el) : hide(el); }

  // 생성/조작
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    setAttrs(node, attrs);
    if (!Array.isArray(children)) children = [children];
    children.forEach(c => {
      if (c == null) return;
      if (c instanceof Node) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    });
    return node;
  }
  function elFromHTML(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html).trim();
    return tpl.content.firstChild;
  }
  function setAttrs(elm, attrs = {}) {
    if (!elm) return;
    Object.entries(attrs).forEach(([k, v]) => {
      if (v == null) return;
      if (k === "class" || k === "className") elm.className = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(elm.style, v);
      else if (k.startsWith("data-")) elm.setAttribute(k, v);
      else if (k in elm) { try { elm[k] = v; } catch { elm.setAttribute(k, v); } }
      else elm.setAttribute(k, v);
    });
  }
  function empty(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function capChildren(container, max) {
    if (!container || !max) return;
    const list = container.children;
    while (list.length > max) container.removeChild(list[0]);
  }

  // ──────────────────────────────────────────────
  // 시간/문자/수치 유틸
  // ──────────────────────────────────────────────
  function fmtTime(ts) {
    try { return new Date(Number(ts ?? Date.now())).toLocaleTimeString(); }
    catch { return ""; }
  }
  function fmtTimeAgo(ts) {
    const s = Math.floor((Date.now() - Number(ts || 0)) / 1000);
    if (!isFinite(s) || s < 0) return "방금";
    if (s < 60) return `${s}초 전`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 전`;
    const d = Math.floor(h / 24);
    return `${d}일 전`;
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (a) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[a]));
  }
  function parseQS(search = location.search) {
    return new URLSearchParams(search);
  }
  function toInt(v, d = 0) {
    const n = parseInt(v, 10);
    return isFinite(n) ? n : d;
  }
  function clamp(n, min, max) {
    const x = Number(n);
    if (!isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  // ──────────────────────────────────────────────
  // 팀 정규화/표기
  // ──────────────────────────────────────────────
  function toAB(team) {
    const s = String(team || "").toLowerCase();
    if (s === "phoenix" || s === "a" || s === "team_a" || s === "team-a") return "A";
    if (s === "eaters"  || s === "b" || s === "death"  || s === "team_b" || s === "team-b") return "B";
    return "-";
  }
  function getTeamName(key) {
    const ab = toAB(key);
    return ab === "A" ? "팀 A" : ab === "B" ? "팀 B" : "-";
  }

  // ──────────────────────────────────────────────
  // 전투 표시 유틸
  // ──────────────────────────────────────────────
  function calculateHpPercent(hp, maxHp) {
    const h = Math.max(0, Number(hp || 0));
    const m = Math.max(1, Number(maxHp || 100));
    return Math.max(0, Math.min(100, Math.round((h / m) * 100)));
  }
  function setHpBar(row, hp, maxHp) {
    if (!row) return;
    const pct = calculateHpPercent(hp, maxHp);
    const fill = row.querySelector(".hp-fill");
    const text = row.querySelector(".hp-text");
    if (fill) fill.style.width = pct + "%";
    if (text) text.textContent = `${Math.max(0, Number(hp || 0))}/${Math.max(1, Number(maxHp || 100))}`;
    row.classList.toggle("is-dead", (Number(hp || 0) <= 0));
  }

  // ──────────────────────────────────────────────
  // 로그/채팅 렌더링
  // ──────────────────────────────────────────────
  function appendLog(container, entry, max = 150) {
    if (!container || !entry) return;
    const div = document.createElement("div");
    div.className = `log-entry log-${entry.type || "system"}`;
    const ts = fmtTime(entry.t || entry.ts || Date.now());
    div.textContent = `[${ts}] ${entry.message || ""}`;
    container.appendChild(div);
    capChildren(container, max);
    container.scrollTop = container.scrollHeight;
  }
  function appendChat(container, who, msg, max = 200) {
    if (!container) return;
    const line = document.createElement("div");
    line.className = "chat-line";
    line.innerHTML = `<span class="who">${escapeHtml(who)}:</span> ${escapeHtml(msg)}`;
    container.appendChild(line);
    capChildren(container, max);
    container.scrollTop = container.scrollHeight;
  }

  // ──────────────────────────────────────────────
  // 로딩 인디케이터
  // ──────────────────────────────────────────────
  let LOADING_STYLE_INJECTED = false;
  let LOADING_EL = null;

  function injectLoadingCSS() {
    if (LOADING_STYLE_INJECTED) return;
    LOADING_STYLE_INJECTED = true;
    const css = `
    .pyx-loading{
      position:fixed; inset:0; z-index:2147482000; display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.45); backdrop-filter:blur(4px);
    }
    .pyx-loading .ring{
      width:56px; height:56px; border-radius:50%;
      border:3px solid rgba(220,199,162,.2); border-top-color:#DCC7A2; animation:pyx-spin 1s linear infinite;
    }
    @keyframes pyx-spin{ to { transform:rotate(360deg) } }
    `;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }
  function startLoading(active = true) {
    injectLoadingCSS();
    if (active) {
      if (!LOADING_EL) {
        LOADING_EL = document.createElement("div");
        LOADING_EL.className = "pyx-loading";
        LOADING_EL.innerHTML = `<div class="ring"></div>`;
        document.body.appendChild(LOADING_EL);
      }
    } else {
      if (LOADING_EL && LOADING_EL.parentNode) LOADING_EL.parentNode.removeChild(LOADING_EL);
      LOADING_EL = null;
    }
  }

  // ──────────────────────────────────────────────
  // 접근성/키보드
  // ──────────────────────────────────────────────
  function focusTrap(container) {
    if (!container) return () => {};
    const focusables = () =>
      $$('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])', container)
        .filter(el => !el.hasAttribute("disabled"));
    function keydown(e) {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
    container.addEventListener("keydown", keydown);
    return () => container.removeEventListener("keydown", keydown);
  }
  function enableKeyboardNav(container) {
    if (!container) return;
    container.addEventListener("keydown", (e) => {
      if (e.key === "Escape") container.dispatchEvent(new CustomEvent("ui:escape"));
    });
  }

  // 엔터키 → 버튼 클릭/핸들러 실행 (채팅 전송 등)
  function bindEnterToClick(inputEl, trigger) {
    if (!inputEl || !trigger) return () => {};
    const handler = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (typeof trigger === "function") trigger();
        else if (trigger.click) trigger.click();
      }
    };
    inputEl.addEventListener("keydown", handler);
    return () => inputEl.removeEventListener("keydown", handler);
  }

  // ──────────────────────────────────────────────
  // 효과
  // ──────────────────────────────────────────────
  function addRippleEffect(elm) {
    if (!elm) return;
    elm.style.position = "relative";
    elm.style.overflow = "hidden";
    elm.addEventListener("click", (e) => {
      const rect = elm.getBoundingClientRect();
      const r = document.createElement("span");
      const size = Math.max(rect.width, rect.height);
      r.style.position = "absolute";
      r.style.left = (e.clientX - rect.left - size / 2) + "px";
      r.style.top = (e.clientY - rect.top - size / 2) + "px";
      r.style.width = r.style.height = size + "px";
      r.style.borderRadius = "50%";
      r.style.background = "rgba(220,199,162,.20)";
      r.style.transform = "scale(0)";
      r.style.transition = "transform .35s ease, opacity .45s ease";
      elm.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 500);
    });
  }

  // ──────────────────────────────────────────────
  // 클립보드
  // ──────────────────────────────────────────────
  async function copyToClipboard(text, { toastOnSuccess = true } = {}) {
    try {
      await navigator.clipboard.writeText(String(text || ""));
      if (toastOnSuccess) success("복사되었습니다.", "복사");
      return true;
    } catch (e) {
      warning("복사에 실패했습니다.", "복사");
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // 토스트: PyxisNotify 연동 + 폴백
  // ──────────────────────────────────────────────
  function toast(message, opts = {}) {
    if (typeof window !== "undefined" && window.PyxisNotify && typeof window.PyxisNotify.toast === "function") {
      return window.PyxisNotify.toast(String(message), {
        title: opts.title || "알림",
        tone: mapTone(opts.tone),
        durationMs: opts.duration || opts.durationMs,
        dedupKey: opts.dedupKey
      });
    }
    return fallbackToast(String(message), opts);
  }
  function success(msg, title = "성공") { return toast(msg, { title, tone: "ok" }); }
  function warning(msg, title = "주의") { return toast(msg, { title, tone: "warn" }); }
  function error(msg, title = "오류")   { return toast(msg, { title, tone: "err" }); }
  function info(msg, title = "알림")    { return toast(msg, { title, tone: "info" }); }

  function mapTone(t) {
    if (!t) return "info";
    const m = { success: "ok", ok: "ok", warn: "warn", warning: "warn", error: "err", danger: "err", info: "info" };
    return m[t] || t;
  }

  // 폴백 토스트(간단)
  let FB_STYLE = false, FB_WRAP = null;
  function ensureFbStyle() {
    if (FB_STYLE) return;
    FB_STYLE = true;
    const css = `
    .fb-toast-wrap{ position:fixed; right:12px; top:12px; z-index:2147482000; display:flex; flex-direction:column; gap:8px; }
    .fb-toast{ min-width:240px; max-width:360px; color:#EEE6D6; background:rgba(15,20,28,.88); border:1px solid rgba(220,199,162,.25); border-radius:10px; padding:10px 12px; box-shadow:0 10px 28px rgba(0,0,0,.5); }
    .fb-title{ font-weight:700; color:#DCC7A2; margin-bottom:4px }
    .fb-msg{ font-size:13px }
    `;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }
  function ensureFbWrap() {
    if (FB_WRAP) return FB_WRAP;
    FB_WRAP = document.createElement("div");
    FB_WRAP.className = "fb-toast-wrap";
    document.body.appendChild(FB_WRAP);
    return FB_WRAP;
  }
  function fallbackToast(message, opts = {}) {
    ensureFbStyle(); ensureFbWrap();
    const el = document.createElement("div");
    el.className = "fb-toast";
    el.innerHTML = `<div class="fb-title">${escapeHtml(opts.title || "알림")}</div><div class="fb-msg">${escapeHtml(message)}</div>`;
    FB_WRAP.appendChild(el);
    const life = clamp(Number(opts.duration || opts.durationMs || 3200), 1500, 10000);
    setTimeout(() => el.remove(), life);
    return el;
  }

  // ──────────────────────────────────────────────
  // 모듈 API
  // ──────────────────────────────────────────────
  return {
    // DOM
    $, $$, on, once, delegate,
    addClass, removeClass, toggleClass, hasClass,
    setDisabled, show, hide, setVisible,
    el, elFromHTML, setAttrs, empty, capChildren,

    // 시간/문자/수치
    fmtTime, fmtTimeAgo, escapeHtml, parseQS, toInt, clamp,

    // 팀/전투 표시
    toAB, getTeamName, calculateHpPercent, setHpBar,

    // 로그/채팅
    appendLog, appendChat,

    // 로딩
    startLoading,

    // 접근성/효과/키보드
    focusTrap, enableKeyboardNav, addRippleEffect, bindEnterToClick,

    // 알림/토스트/클립보드
    toast, success, warning, error, info, copyToClipboard
  };
});
