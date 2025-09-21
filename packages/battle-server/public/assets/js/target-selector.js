/* packages/battle-server/public/assets/js/target-selector.js
   PYXIS Target Selector Component - Enhanced Gaming Edition (final)
   - 팀 표기: 내부/표시는 항상 A/B (phoenix/eaters 입력도 자동 정규화)
   - 키보드 내비게이션, 포커스 복원, 모션 감축 대응, 오디오 컨텍스트 재사용
   - 단일/다중 선택 지원 (멀티셀렉트일 때 Ctrl+Enter로 확인)
*/

class PyxisTargetSelector {
  constructor(options = {}) {
    this.options = {
      showStats: true,
      showHp: true,
      showTeam: true,
      showAvatar: true,
      allowMultiSelect: false,
      theme: 'default',
      battleMode: '2v2',
      enableSoundEffects: false,
      enableAnimations: true,
      ...options
    };

    this.isVisible = false;
    this.targets = [];
    this.selectedTargets = [];
    this.callback = null;
    this.battleData = null;

    this._onEscKey = this._onEscKey.bind(this);
    this._onOverlayClick = this._onOverlayClick.bind(this);
    this._onKeyboardNav = this._onKeyboardNav.bind(this);

    this._listenersBound = false;
    this._focusedIndex = 0;
    this._prevActive = null;
    this._audioCtx = null;

    this.init();
  }

  /* ────────────────────────────────
     유틸 & 팀 정규화(A/B 고정)
  ──────────────────────────────── */
  static _shouldReduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  _toAB(team) {
    const s = String(team || '').toLowerCase();
    if (s === 'phoenix' || s === 'a' || s === 'team_a' || s === 'team-a') return 'A';
    if (s === 'eaters'  || s === 'b' || s === 'death'  || s === 'team_b' || s === 'team-b') return 'B';
    return '-';
  }

  init() {
    this.createOverlay();
    this.setupEventListeners();
    this.injectStyles();
  }

  injectStyles() {
    if (document.getElementById('pyxis-target-selector-enhanced-styles')) return;

    const styleSheet = document.createElement('style');
    styleSheet.id = 'pyxis-target-selector-enhanced-styles';
    styleSheet.textContent = `
      :root {
        --pyxis-deep-navy: #00080D;
        --pyxis-navy-light: #001E35;
        --pyxis-gold-bright: #DCC7A2;
        --pyxis-gold-warm: #D4BA8D;
        --pyxis-border-subtle: rgba(220, 199, 162, 0.2);
        --pyxis-glass-light: rgba(0, 30, 53, 0.8);
        --pyxis-combat-red: #C73E1D;
        --pyxis-success-green: #2D5A27;
        --pyxis-warning-amber: #B8860B;
      }

      .target-overlay {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background: linear-gradient(135deg, rgba(0, 8, 13, 0.95) 0%, rgba(0, 30, 53, 0.9) 50%, rgba(0, 8, 13, 0.95) 100%);
        backdrop-filter: blur(12px);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; opacity: 0;
        animation: fadeInOverlay 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }
      @keyframes fadeInOverlay { from { opacity: 0; } to { opacity: 1; } }

      .target-panel {
        background: linear-gradient(145deg, rgba(0, 30, 53, 0.95) 0%, rgba(42, 52, 65, 0.9) 100%);
        backdrop-filter: blur(20px);
        border: 2px solid var(--pyxis-border-subtle);
        border-radius: 20px;
        padding: 32px;
        max-width: 90vw; max-height: 85vh; width: 100%; max-width: 900px;
        box-shadow: 0 25px 50px rgba(0,0,0,0.5), 0 0 0 1px rgba(220,199,162,0.1), inset 0 1px 0 rgba(220,199,162,0.2);
        position: relative; overflow: hidden;
        transform: scale(0.9) translateY(20px);
        animation: slideInPanel 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      @keyframes slideInPanel { to { transform: scale(1) translateY(0); } }

      .target-panel::before {
        content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, transparent, var(--pyxis-gold-bright), transparent); opacity: 0.6;
      }

      .target-title {
        font-family: 'Cinzel', serif;
        font-size: clamp(24px, 4vw, 32px);
        font-weight: 600; color: var(--pyxis-gold-bright); text-align: center; margin-bottom: 8px;
        text-shadow: 0 2px 8px rgba(220,199,162,0.3);
      }

      .target-desc {
        font-size: 12px; color: rgba(220,199,162,.7); text-align: center; margin-bottom: 16px;
      }

      .target-list {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px; max-height: 60vh; overflow-y: auto; padding: 8px; margin-bottom: 24px;
        scrollbar-width: thin; scrollbar-color: var(--pyxis-gold-warm) transparent;
      }
      .target-list::-webkit-scrollbar { width: 8px; }
      .target-list::-webkit-scrollbar-track { background: rgba(0,30,53,0.3); border-radius: 4px; }
      .target-list::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, var(--pyxis-gold-bright), var(--pyxis-gold-warm)); border-radius: 4px;
      }

      .target-card {
        background: linear-gradient(145deg, rgba(0,30,53,0.9) 0%, rgba(42,52,65,0.8) 100%);
        backdrop-filter: blur(10px);
        border: 1.5px solid var(--pyxis-border-subtle);
        border-radius: 16px; padding: 20px; cursor: pointer;
        transition: all 0.3s cubic-bezier(0.4,0,0.2,1); position: relative; overflow: hidden;
        transform: translateY(0);
      }
      .target-card::before {
        content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
        background: linear-gradient(90deg, transparent, var(--pyxis-gold-bright), transparent); opacity: 0.3;
      }
      .target-card:hover:not(.disabled) {
        transform: translateY(-4px); border-color: var(--pyxis-gold-bright);
        background: linear-gradient(145deg, rgba(0,30,53,0.95), rgba(42,52,65,0.9));
        box-shadow: 0 12px 24px rgba(0,0,0,0.3), 0 0 0 1px var(--pyxis-gold-bright), 0 0 20px rgba(220,199,162,0.2);
      }
      .target-card.focused {
        border-color: var(--pyxis-gold-bright);
        box-shadow: 0 8px 16px rgba(0,0,0,0.2), 0 0 0 2px var(--pyxis-gold-bright), 0 0 20px rgba(220,199,162,0.3);
      }
      .target-card.selected {
        border-color: var(--pyxis-gold-bright)!important;
        background: linear-gradient(145deg, rgba(220,199,162,0.15), rgba(212,183,126,0.1))!important;
        box-shadow: 0 8px 16px rgba(0,0,0,0.2), 0 0 0 2px var(--pyxis-gold-bright), inset 0 0 20px rgba(220,199,162,0.1)!important;
      }
      .target-card.disabled { opacity: .4; cursor: not-allowed; filter: grayscale(.8);
        background: linear-gradient(145deg, rgba(42,52,65,.5), rgba(26,31,42,.6)); }
      .target-card.disabled:hover { transform: none!important; border-color: var(--pyxis-border-subtle)!important; box-shadow: none!important; }

      .target-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .target-avatar { width: 48px; height: 48px; border-radius: 12px;
        background: linear-gradient(145deg, var(--pyxis-gold-warm), var(--pyxis-gold-bright));
        display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 18px; color: var(--pyxis-deep-navy);
        border: 2px solid var(--pyxis-border-subtle); box-shadow: 0 4px 8px rgba(0,0,0,.2); }
      .target-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }

      .target-info { flex: 1; min-width: 0; }
      .target-name { font-family: 'Inter', sans-serif; font-size: 18px; font-weight: 600;
        color: var(--pyxis-gold-bright); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .target-team { font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 8px; display: inline-block; margin-bottom: 8px; }
      .target-team.team-A { background: rgba(199,62,29,0.2); color: #FF6B4A; border: 1px solid rgba(199,62,29,0.3); }
      .target-team.team-B { background: rgba(45,90,39,0.2);  color: #66BB6A; border: 1px solid rgba(45,90,39,0.3); }

      .target-hp { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .target-hp-text { font-size: 14px; font-weight: 500; color: var(--pyxis-gold-warm); min-width: fit-content; }
      .target-hp-bar-container { flex: 1; height: 8px; background: rgba(0,30,53,0.8); border-radius: 4px; border: 1px solid var(--pyxis-border-subtle); overflow: hidden; position: relative; }
      .target-hp-bar { height: 100%; border-radius: 3px; transition: width .4s cubic-bezier(.4,0,.2,1); position: relative;
        background: linear-gradient(90deg, var(--pyxis-success-green), var(--pyxis-gold-warm), var(--pyxis-gold-bright)); }
      .target-hp-bar.low { background: linear-gradient(90deg, var(--pyxis-combat-red), var(--pyxis-warning-amber)); }
      .target-hp-bar::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.3), transparent); animation: shimmer 2s infinite; }
      @keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }

      .target-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; font-size: 11px; color: rgba(220,199,162,.8); margin-bottom: 12px; }
      .target-stat { display: flex; justify-content: space-between; padding: 4px 8px; background: rgba(0,30,53,.5); border-radius: 6px; border: 1px solid var(--pyxis-border-subtle); }

      .target-status { display: flex; gap: 6px; flex-wrap: wrap; }
      .status-pill { padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }
      .status-pill.alive { background: rgba(45,90,39,.3); color: #66BB6A; border: 1px solid rgba(45,90,39,.5); }
      .status-pill.dead  { background: rgba(199,62,29,.3); color: #FF6B4A; border: 1px solid rgba(199,62,29,.5); }
      .status-pill.boosted { background: rgba(184,134,11,.3); color: var(--pyxis-warning-amber); border: 1px solid rgba(184,134,11,.5); }

      .target-actions { display: flex; gap: 12px; justify-content: center; align-items: center; margin-top: 24px; }
      .btn { padding: 12px 24px; border: 2px solid var(--pyxis-border-subtle); border-radius: 12px;
        background: linear-gradient(145deg, rgba(0,30,53,.9), rgba(42,52,65,.8)); color: var(--pyxis-gold-bright);
        font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; transition: all .3s cubic-bezier(.4,0,.2,1);
        text-transform: uppercase; letter-spacing: .5px; position: relative; overflow: hidden; min-width: 100px; }
      .btn::before { content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
        background: linear-gradient(90deg, transparent, rgba(220,199,162,.2), transparent); transition: left .5s cubic-bezier(.4,0,.2,1); }
      .btn:hover::before { left: 100%; }
      .btn:hover:not(:disabled) { border-color: var(--pyxis-gold-bright); background: linear-gradient(145deg, rgba(0,30,53,.95), rgba(42,52,65,.9));
        box-shadow: 0 8px 16px rgba(0,0,0,.2), 0 0 20px rgba(220,199,162,.2); transform: translateY(-2px); }
      .btn.btn-gold { background: linear-gradient(145deg, var(--pyxis-gold-warm), var(--pyxis-gold-bright)); color: var(--pyxis-deep-navy); border-color: var(--pyxis-gold-bright); }
      .btn.btn-gold:hover:not(:disabled) { background: linear-gradient(145deg, var(--pyxis-gold-bright), var(--pyxis-gold-warm));
        box-shadow: 0 8px 16px rgba(0,0,0,.3), 0 0 20px rgba(220,199,162,.4); }
      .btn:disabled { opacity: .5; cursor: not-allowed; transform: none!important; box-shadow: none!important; }

      .no-targets { text-align: center; color: rgba(220,199,162,.6); font-style: italic; padding: 60px 20px; font-size: 18px;
        background: linear-gradient(145deg, rgba(0,30,53,.5), rgba(42,52,65,.3)); border: 2px dashed var(--pyxis-border-subtle); border-radius: 16px; margin: 20px 0; }

      .battle-info { text-align: center; margin-bottom: 20px; padding: 16px; background: linear-gradient(145deg, rgba(0,30,53,.7), rgba(42,52,65,.5));
        border: 1px solid var(--pyxis-border-subtle); border-radius: 12px; }
      .battle-mode { font-size: 14px; color: var(--pyxis-gold-warm); font-weight: 500; margin-bottom: 8px; }
      .turn-info { font-size: 12px; color: rgba(220,199,162,.7); }

      @media (max-width: 768px) {
        .target-panel { margin: 16px; padding: 20px; max-height: 90vh; }
        .target-list { grid-template-columns: 1fr; max-height: 50vh; }
        .target-card { padding: 16px; }
        .target-title { font-size: 24px; margin-bottom: 8px; }
        .target-actions { flex-direction: column; gap: 8px; }
        .btn { width: 100%; min-width: unset; }
      }

      @media (prefers-reduced-motion: reduce) {
        * { animation-duration: .01ms!important; animation-iteration-count: 1!important; transition-duration: .01ms!important; }
      }
      @media (prefers-contrast: high) { .target-card { border-width: 3px; } .btn { border-width: 3px; } }
    `;
    document.head.appendChild(styleSheet);
  }

  createOverlay() {
    const existing = document.getElementById('pyxis-target-overlay');
    if (existing) existing.remove();

    this.overlay = document.createElement('div');
    this.overlay.id = 'pyxis-target-overlay';
    this.overlay.className = 'target-overlay';
    this.overlay.style.display = 'none';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'targetTitle');
    this.overlay.setAttribute('aria-describedby', 'targetDesc');

    this.overlay.innerHTML = `
      <div class="target-panel">
        <div class="target-title" id="targetTitle">전투 대상 선택</div>
        <div class="target-desc" id="targetDesc">화살표로 이동하고 스페이스/엔터로 선택합니다. ${this.options.allowMultiSelect ? 'Ctrl+Enter로 확인합니다.' : ''}</div>
        <div class="battle-info" style="display:none;">
          <div class="battle-mode"></div>
          <div class="turn-info"></div>
        </div>
        <div class="target-list" id="targetList" role="listbox" aria-multiselectable="${this.options.allowMultiSelect}"></div>
        <div class="target-actions">
          <button class="btn" id="cancelTarget" type="button">취소</button>
          ${this.options.allowMultiSelect ? `
            <button class="btn btn-gold" id="confirmTarget" type="button" disabled>
              확인 (<span id="selectedCount">0</span>)
            </button>
          ` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    this.titleEl = this.overlay.querySelector('#targetTitle');
    this.descEl = this.overlay.querySelector('#targetDesc');
    this.listEl = this.overlay.querySelector('#targetList');
    this.cancelBtn = this.overlay.querySelector('#cancelTarget');
    this.confirmBtn = this.overlay.querySelector('#confirmTarget');
    this.selectedCountEl = this.overlay.querySelector('#selectedCount');
    this.battleInfoEl = this.overlay.querySelector('.battle-info');
  }

  setupEventListeners() {
    this.teardownEventListeners();

    if (this.cancelBtn) {
      this._cancelHandler = () => this.hide();
      this.cancelBtn.addEventListener('click', this._cancelHandler);
    }
    if (this.confirmBtn) {
      this._confirmHandler = () => this.confirm();
      this.confirmBtn.addEventListener('click', this._confirmHandler);
    }
    document.addEventListener('keydown', this._onEscKey);
    document.addEventListener('keydown', this._onKeyboardNav);
    this.overlay.addEventListener('click', this._onOverlayClick);

    this._listenersBound = true;
  }

  teardownEventListeners() {
    if (!this._listenersBound) return;
    if (this._cancelHandler && this.cancelBtn) {
      this.cancelBtn.removeEventListener('click', this._cancelHandler);
      this._cancelHandler = null;
    }
    if (this._confirmHandler && this.confirmBtn) {
      this.confirmBtn.removeEventListener('click', this._confirmHandler);
      this._confirmHandler = null;
    }
    document.removeEventListener('keydown', this._onEscKey);
    document.removeEventListener('keydown', this._onKeyboardNav);
    if (this.overlay) this.overlay.removeEventListener('click', this._onOverlayClick);
    this._listenersBound = false;
  }

  _onEscKey(e) {
    if (e.key === 'Escape' && this.isVisible) {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
  }

  _onKeyboardNav(e) {
    if (!this.isVisible) return;
    const targetCards = this.listEl.querySelectorAll('.target-card:not(.disabled)');
    if (targetCards.length === 0) return;

    // 멀티셀렉트: Ctrl+Enter 로 확인
    if (this.options.allowMultiSelect && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.confirm();
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        this._focusedIndex = Math.min(this._focusedIndex + 1, targetCards.length - 1);
        this.updateFocus();
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        this._focusedIndex = Math.max(this._focusedIndex - 1, 0);
        this.updateFocus();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (targetCards[this._focusedIndex]) {
          targetCards[this._focusedIndex].click();
        }
        break;
      case 'Home':
        e.preventDefault();
        this._focusedIndex = 0;
        this.updateFocus();
        break;
      case 'End':
        e.preventDefault();
        this._focusedIndex = targetCards.length - 1;
        this.updateFocus();
        break;
    }
  }

  updateFocus() {
    const cards = this.listEl.querySelectorAll('.target-card:not(.disabled)');
    cards.forEach((card, index) => {
      card.classList.toggle('focused', index === this._focusedIndex);
    });
    const behavior = PyxisTargetSelector._shouldReduceMotion() ? 'auto' : 'smooth';
    cards[this._focusedIndex]?.scrollIntoView({ behavior, block: 'nearest' });
  }

  _onOverlayClick(e) {
    if (e.target === this.overlay) this.hide();
  }

  show(title, targets, callback, battleData = null) {
    this._prevActive = document.activeElement;

    this.titleEl.textContent = title || '전투 대상 선택';
    this.descEl.textContent =
      `화살표로 이동하고 스페이스/엔터로 선택합니다.${this.options.allowMultiSelect ? ' Ctrl+Enter로 확인합니다.' : ''}`;
    this.targets = Array.isArray(targets) ? targets : [];
    this.callback = typeof callback === 'function' ? callback : null;
    this.battleData = battleData;
    this.selectedTargets = [];
    this._focusedIndex = 0;

    // 배틀 정보 UI (A/B 표기)
    if (this.battleInfoEl && battleData) {
      this.battleInfoEl.style.display = '';
      this.battleInfoEl.querySelector('.battle-mode').textContent = `${battleData.mode || '2v2'} 전투`;
      const ab = this._toAB(battleData.currentTeam);
      const parts = [`턴 ${battleData.currentTurn || 1}`];
      if (ab === 'A' || ab === 'B') parts.push(`팀 ${ab} 차례`);
      this.battleInfoEl.querySelector('.turn-info').textContent = parts.join(' • ');
    } else if (this.battleInfoEl) {
      this.battleInfoEl.style.display = 'none';
    }

    this.renderTargets();
    this.overlay.style.display = 'flex';
    this.isVisible = true;

    const firstCard = this.listEl.querySelector('.target-card:not(.disabled)');
    if (firstCard) {
      setTimeout(() => {
        try { firstCard.focus(); } catch (_) {}
        this.updateFocus();
      }, 100);
    }
  }

  renderTargets() {
    this.listEl.innerHTML = '';
    if (this.targets.length === 0) {
      this.listEl.innerHTML = `<div class="no-targets">선택할 수 있는 대상이 없습니다</div>`;
      return;
    }
    this.targets.forEach((target, index) => {
      const card = this.createTargetCard(target, index);
      this.listEl.appendChild(card);
    });
  }

  createTargetCard(target, index) {
    const card = document.createElement('div');
    const isDisabled = target.alive === false || target.hp <= 0;
    card.className = `target-card${isDisabled ? ' disabled' : ''}`;
    card.tabIndex = isDisabled ? -1 : 0;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', 'false');
    card.setAttribute('aria-label', `${target.name || `대상 ${index + 1}`} 선택`);

    const header = document.createElement('div');
    header.className = 'target-header';

    const avatar = document.createElement('div');
    avatar.className = 'target-avatar';
    if (target.avatar && this.options.showAvatar) {
      const img = document.createElement('img');
      img.src = target.avatar;
      img.alt = target.name || '플레이어';
      img.onerror = () => {
        avatar.innerHTML = '';
        avatar.textContent = (target.name || 'U').charAt(0).toUpperCase();
      };
      avatar.appendChild(img);
    } else {
      avatar.textContent = (target.name || 'U').charAt(0).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'target-info';

    // 팀 뱃지(항상 A/B)
    if (this.options.showTeam && (target.team || target.teamAB)) {
      const ab = this._toAB(target.teamAB || target.team);
      if (ab === 'A' || ab === 'B') {
        const team = document.createElement('div');
        team.className = `target-team team-${ab}`;
        team.textContent = `팀 ${ab}`;
        info.appendChild(team);
      }
    }

    const name = document.createElement('div');
    name.className = 'target-name';
    name.textContent = target.name || `대상 ${index + 1}`;
    info.appendChild(name);

    header.appendChild(avatar);
    header.appendChild(info);
    card.appendChild(header);

    // HP
    if (this.options.showHp && target.hp !== undefined) {
      const hpContainer = document.createElement('div');
      hpContainer.className = 'target-hp';

      const hpText = document.createElement('div');
      hpText.className = 'target-hp-text';
      const maxHp = target.maxHp || 100;
      const hpVal = Math.max(0, target.hp);
      hpText.textContent = `${hpVal}/${maxHp}`;

      const hpBarContainer = document.createElement('div');
      hpBarContainer.className = 'target-hp-bar-container';

      const hpBar = document.createElement('div');
      hpBar.className = 'target-hp-bar';
      const hpPercent = Math.max(0, Math.min(100, (hpVal / maxHp) * 100));
      if (hpPercent <= 25) hpBar.classList.add('low');
      hpBar.style.width = `${hpPercent}%`;

      hpBarContainer.appendChild(hpBar);
      hpContainer.appendChild(hpText);
      hpContainer.appendChild(hpBarContainer);
      card.appendChild(hpContainer);
    }

    // 스탯(1~5 보장)
    if (this.options.showStats && target.stats) {
      const statsContainer = document.createElement('div');
      statsContainer.className = 'target-stats';
      const stats = target.stats;
      const statNames = [
        { key: 'attack',  label: '공격', alt: 'atk' },
        { key: 'defense', label: '방어', alt: 'def' },
        { key: 'agility', label: '민첩', alt: 'agi' },
        { key: 'luck',    label: '행운', alt: 'luk' }
      ];
      statNames.forEach(stat => {
        const statEl = document.createElement('div');
        statEl.className = 'target-stat';
        const raw = stats[stat.key] ?? stats[stat.alt] ?? 3;
        const v = Math.max(1, Math.min(5, raw|0));
        statEl.innerHTML = `<span>${stat.label}</span><span>${v}</span>`;
        statsContainer.appendChild(statEl);
      });
      card.appendChild(statsContainer);
    }

    // 상태
    const statusContainer = document.createElement('div');
    statusContainer.className = 'target-status';
    const aliveStatus = document.createElement('div');
    aliveStatus.className = `status-pill ${isDisabled ? 'dead' : 'alive'}`;
    aliveStatus.textContent = isDisabled ? '전투불능' : '전투가능';
    statusContainer.appendChild(aliveStatus);
    if (target.effects && Array.isArray(target.effects)) {
      target.effects.forEach(effect => {
        const effectPill = document.createElement('div');
        effectPill.className = 'status-pill boosted';
        effectPill.textContent = effect.name || effect;
        statusContainer.appendChild(effectPill);
      });
    }
    card.appendChild(statusContainer);

    if (!isDisabled) {
      const selectHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectTarget(target, card);
      };
      card.addEventListener('click', selectHandler);
      card.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') selectHandler(e); });
      if (this.options.enableSoundEffects) {
        card.addEventListener('mouseenter', () => this.playSound('hover'));
      }
    }

    return card;
  }

  selectTarget(target, cardEl) {
    if (target.alive === false || target.hp <= 0) return;
    if (this.options.enableSoundEffects) this.playSound('select');

    if (this.options.allowMultiSelect) {
      const index = this.selectedTargets.findIndex(t =>
        (t.id && t.id === target.id) || (t.name === target.name)
      );
      if (index > -1) {
        this.selectedTargets.splice(index, 1);
        cardEl.classList.remove('selected');
        cardEl.setAttribute('aria-selected', 'false');
      } else {
        this.selectedTargets.push(target);
        cardEl.classList.add('selected');
        cardEl.setAttribute('aria-selected', 'true');
      }
      this.updateConfirmButton();
    } else {
      this.hide();
      if (this.callback) setTimeout(() => this.callback(target), 100);
    }
  }

  updateConfirmButton() {
    if (this.confirmBtn && this.selectedCountEl) {
      const count = this.selectedTargets.length;
      this.confirmBtn.disabled = count === 0;
      this.selectedCountEl.textContent = count;
      if (count > 0) this.confirmBtn.setAttribute('aria-label', `${count}명의 대상 선택 확인`);
    }
  }

  confirm() {
    if (!this.options.allowMultiSelect) return; // 단일선택 모드에서는 confirm 버튼이 없음
    if (this.selectedTargets.length === 0) return;
    if (this.options.enableSoundEffects) this.playSound('confirm');
    this.hide();
    if (this.callback) {
      setTimeout(() => {
        this.callback(this.selectedTargets);
      }, 100);
    }
  }

  hide() {
    if (!this.overlay) return;

    if (!PyxisTargetSelector._shouldReduceMotion()) this.overlay.style.opacity = '0';
    const panel = this.overlay.querySelector('.target-panel');
    if (panel && !PyxisTargetSelector._shouldReduceMotion()) {
      panel.style.transform = 'scale(0.9) translateY(20px)';
    }

    setTimeout(() => {
      this.overlay.style.display = 'none';
      this.isVisible = false;
      this.targets = [];
      this.selectedTargets = [];
      this.callback = null;
      this.battleData = null;
      this._focusedIndex = 0;

      if (this._prevActive && this._prevActive.focus) {
        try { this._prevActive.focus(); } catch (_) {}
      }
      this._prevActive = null;

      this.overlay.style.opacity = '';
      if (panel) panel.style.transform = '';
    }, PyxisTargetSelector._shouldReduceMotion() ? 0 : 200);
  }

  playSound(type) {
    if (!this.options.enableSoundEffects) return;
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioContext = this._audioCtx;
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      switch (type) {
        case 'hover':
          oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
          gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
          break;
        case 'select':
          oscillator.frequency.setValueAtTime(1200, audioContext.currentTime);
          gainNode.gain.setValueAtTime(0.2, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
          break;
        case 'confirm':
          oscillator.frequency.setValueAtTime(1000, audioContext.currentTime);
          oscillator.frequency.setValueAtTime(1200, audioContext.currentTime + 0.1);
          gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
          break;
      }
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (_) {}
  }

  filterTargets(predicate) {
    this.targets = this.targets.filter(predicate);
    this.selectedTargets = this.selectedTargets.filter(predicate);
    this.renderTargets();
    this.updateConfirmButton();
  }

  updateTargets(targets) {
    this.targets = Array.isArray(targets) ? targets : [];
    this.selectedTargets = [];
    this.renderTargets();
    this.updateConfirmButton();
  }

  updateTarget(targetId, updates) {
    const i = this.targets.findIndex(t => (t.id && t.id === targetId) || (t.name === targetId));
    if (i > -1) { this.targets[i] = { ...this.targets[i], ...updates }; this.renderTargets(); }
  }

  addTarget(target) { this.targets.push(target); this.renderTargets(); }

  removeTarget(targetId) {
    const keep = (t) => !((t.id != null && t.id === targetId) || (t.name === targetId));
    this.targets = this.targets.filter(keep);
    this.selectedTargets = this.selectedTargets.filter(keep);
    this.renderTargets(); this.updateConfirmButton();
  }

  isShown() { return this.isVisible; }
  getSelectedTargets() { return [...this.selectedTargets]; }

  clearSelection() {
    this.selectedTargets = [];
    if (this.listEl) {
      this.listEl.querySelectorAll('.target-card.selected').forEach(card => {
        card.classList.remove('selected');
        card.setAttribute('aria-selected', 'false');
      });
    }
    this.updateConfirmButton();
  }

  updateOptions(newOptions) {
    const oldMultiSelect = this.options.allowMultiSelect;
    this.options = { ...this.options, ...newOptions };
    if (oldMultiSelect !== this.options.allowMultiSelect) {
      this.teardownEventListeners();
      this.createOverlay();
      this.setupEventListeners();
    } else if (this.descEl) {
      this.descEl.textContent =
        `화살표로 이동하고 스페이스/엔터로 선택합니다.${this.options.allowMultiSelect ? ' Ctrl+Enter로 확인합니다.' : ''}`;
    }
  }

  updateBattleData(battleData) {
    this.battleData = battleData;
    if (this.battleInfoEl && this.isVisible) {
      this.battleInfoEl.style.display = '';
      this.battleInfoEl.querySelector('.battle-mode').textContent = `${battleData.mode || '2v2'} 전투`;
      const ab = this._toAB(battleData.currentTeam);
      const parts = [`턴 ${battleData.currentTurn || 1}`];
      if (ab === 'A' || ab === 'B') parts.push(`팀 ${ab} 차례`);
      this.battleInfoEl.querySelector('.turn-info').textContent = parts.join(' • ');
    }
  }

  setTheme(theme) {
    this.options.theme = theme;
    if (this.overlay) this.overlay.className = `target-overlay theme-${theme}`;
  }

  setCustomStyles(styles) {
    if (!styles || typeof styles !== 'object') return;
    Object.entries(styles).forEach(([selector, cssText]) => {
      const elements = this.overlay?.querySelectorAll(selector) || [];
      elements.forEach(el => {
        if (typeof cssText === 'string') el.style.cssText += cssText;
        else if (typeof cssText === 'object') Object.assign(el.style, cssText);
      });
    });
  }

  toggleAnimations(enabled) {
    this.options.enableAnimations = enabled;
    if (this.overlay) {
      if (!enabled || PyxisTargetSelector._shouldReduceMotion()) {
        this.overlay.style.transition = 'none';
        const panel = this.overlay.querySelector('.target-panel');
        if (panel) panel.style.transition = 'none';
      } else {
        this.overlay.style.transition = '';
        const panel = this.overlay.querySelector('.target-panel');
        if (panel) panel.style.transition = '';
      }
    }
  }

  toggleSoundEffects(enabled) { this.options.enableSoundEffects = enabled; }

  addKeyboardShortcut(key, callback) {
    const handler = (e) => { if (this.isVisible && e.key === key) { e.preventDefault(); callback(e); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  getStats() {
    return {
      totalTargets: this.targets.length,
      selectedTargets: this.selectedTargets.length,
      aliveTargets: this.targets.filter(t => t.alive !== false && t.hp > 0).length,
      deadTargets: this.targets.filter(t => t.alive === false || t.hp <= 0).length,
      averageHp: this.targets.length ? this.targets.reduce((sum, t) => sum + (t.hp || 0), 0) / this.targets.length : 0
    };
  }

  announceToScreenReader(message) {
    const announcement = document.createElement('div');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    announcement.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden;';
    announcement.textContent = message;
    document.body.appendChild(announcement);
    setTimeout(() => { document.body.removeChild(announcement); }, 1000);
  }

  destroy() {
    this.teardownEventListeners();
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    const styleSheet = document.getElementById('pyxis-target-selector-enhanced-styles');
    if (styleSheet) styleSheet.remove();
    this.targets = []; this.selectedTargets = []; this.callback = null; this.battleData = null; this.isVisible = false; this._focusedIndex = 0;
    try { this._audioCtx?.close(); } catch(_) {}
    this._audioCtx = null;
  }
}

/* 전역 바인딩 */
window.PyxisTargetSelector = PyxisTargetSelector;

/* 싱글톤 */
window.PyxisTarget = new PyxisTargetSelector({
  enableAnimations: true,
  enableSoundEffects: false,
  showStats: true,
  showHp: true,
  showTeam: true,
  showAvatar: true
});

/* 플레이어 클라이언트 호환용 래퍼
   - 기대 시그니처: window.PYXISTargetSelector.open({ players, onPick, title?, battleData?, allowMultiSelect? })
   - 단일 선택: onPick(선택 id)
   - 다중 선택: onPick(선택된 target 배열)  ← (기존 요구에 맞춰 객체 배열 전달; 필요 시 id 배열로 변환 가능)
*/
window.PYXISTargetSelector = {
  open({ players = [], onPick, title = '전투 대상 선택', battleData = null, allowMultiSelect = false } = {}) {
    try {
      window.PyxisTarget.updateOptions({ allowMultiSelect });
      const normalized = (players || []).map(window.PyxisTargetUtils
        ? window.PyxisTargetUtils.normalizeTarget
        : (t) => t
      );
      window.PyxisTarget.show(title, normalized, (selected) => {
        if (!onPick || typeof onPick !== 'function') return;
        onPick(selected);
      }, battleData);
    } catch (e) {
      console.error('PYXISTargetSelector.open 에러:', e);
    }
  },
  close() { try { window.PyxisTarget.hide(); } catch (_) {} }
};

/* 유틸리티: A/B·phoenix/eaters 모두 허용 */
window.PyxisTargetUtils = window.PyxisTargetUtils || {
  _toAB(team) {
    const s = String(team || '').toLowerCase();
    if (s === 'phoenix' || s === 'a' || s === 'team_a' || s === 'team-a') return 'A';
    if (s === 'eaters'  || s === 'b' || s === 'death'  || s === 'team_b' || s === 'team-b') return 'B';
    return '-';
  },
  filterByTeam: (targets, team) => {
    const ab = window.PyxisTargetUtils._toAB(team);
    return targets.filter(t => window.PyxisTargetUtils._toAB(t.team || t.teamAB) === ab);
  },
  filterAlive: (targets) => targets.filter(target => target.alive !== false && target.hp > 0),
  sortByHp: (targets, ascending = true) => [...targets].sort((a, b) => {
    const hpA = a.hp || 0, hpB = b.hp || 0;
    return ascending ? hpA - hpB : hpB - hpA;
  }),
  sortByTotalStats: (targets, ascending = false) => [...targets].sort((a, b) => {
    const statsA = a.stats ? Object.values(a.stats).reduce((sum, val) => sum + (val || 0), 0) : 0;
    const statsB = b.stats ? Object.values(b.stats).reduce((sum, val) => sum + (val || 0), 0) : 0;
    return ascending ? statsA - statsB : statsB - statsA;
  }),
  isValidTarget: (target) => target && target.alive !== false && target.hp > 0,
  normalizeTarget: (target) => {
    const clamp5 = (v) => Math.max(1, Math.min(5, v|0));
    const maxHp = target.maxHp || 100;
    const hp = Math.max(0, target.hp ?? 100);
    return {
      id: target.id || target.name || Math.random().toString(36),
      name: target.name || '무명의 전사',
      team: target.team || target.teamAB || 'phoenix', // 원본 유지(표시는 AB로 변환)
      teamAB: window.PyxisTargetUtils._toAB(target.team || target.teamAB),
      hp, maxHp,
      stats: {
        attack:  clamp5(target.stats?.attack  ?? target.stats?.atk  ?? 3),
        defense: clamp5(target.stats?.defense ?? target.stats?.def  ?? 3),
        agility: clamp5(target.stats?.agility ?? target.stats?.agi  ?? 3),
        luck:    clamp5(target.stats?.luck    ?? target.stats?.luk  ?? 3)
      },
      alive: target.alive !== false && hp > 0,
      avatar: target.avatar || null,
      effects: target.effects || []
    };
  }
};
