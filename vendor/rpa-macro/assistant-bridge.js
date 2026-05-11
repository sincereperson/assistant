// assistant-bridge.js — 어시스턴트 대시보드에 매크로 토글 + 라이브러리 UI 주입
//
// 무엇: 어시스턴트 대시보드 안에 [● 녹화]/[■ 종료]/[▶ 재생] 버튼과
//       *매크로 라이브러리 목록*을 DOM 주입한다.
// 왜:   사용자가 매크로를 어시스턴트에서 시작·종료·관리할 수 있게.
//       단 어시스턴트 빌드 사이클과 분리(코드 수정 X).
// 어떻게:
//   1) DOMReady 후 어시스턴트 대시보드 슬롯이 있으면 그 안에 컨트롤 박스 끼워넣기,
//      어시스턴트가 없는 단독 데모 환경에서는 페이지 우하단 floating
//   2) 녹화 종료 시 events 를 *자체 localStorage 키*(rpa-macros)에 매크로 1건으로 저장
//      — 어시스턴트의 클립보드/메모/템플릿 탭은 건드리지 않는다
//   3) 컨트롤 박스 하단에 매크로 목록 렌더링, 각 항목에 [▶ 재생][✕ 삭제] 버튼
//
// 어시스턴트 미존재 시(외부망 데모) — floating 모드로도 모든 기능 동작.

(function (root) {
  // ─────────────────────────────────────────────
  // 상수
  // ─────────────────────────────────────────────
  const STORAGE_KEY = 'rpa-macros';      // localStorage 자체 키
  const SCHEMA_VERSION = 1;

  // ─────────────────────────────────────────────
  // 상태
  // ─────────────────────────────────────────────
  let recorder = null;
  let lastEvents = [];
  let uiRoot = null;
  let mountedHost = 'detached';          // 'detached' | 'floating' | 'dashboard'

  function getRecorder() {
    if (!recorder) {
      if (typeof window.MacroRecorder !== 'function') {
        console.warn('[assistant-bridge] MacroRecorder 미로드');
        return null;
      }
      recorder = new window.MacroRecorder();
    }
    return recorder;
  }

  // ─────────────────────────────────────────────
  // 매크로 라이브러리 — 자체 localStorage 키 (rpa-macros)
  //   schema: { version, macros: [{ id, name, ts, menuId, eventCount, events }] }
  // ─────────────────────────────────────────────
  function loadLibrary() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: SCHEMA_VERSION, macros: [] };
      const parsed = JSON.parse(raw);
      if (!parsed?.macros) return { version: SCHEMA_VERSION, macros: [] };
      return parsed;
    } catch (err) {
      console.warn('[assistant-bridge] library load 실패, 빈 라이브러리로 시작:', err);
      return { version: SCHEMA_VERSION, macros: [] };
    }
  }

  function saveLibrary(lib) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
    } catch (err) {
      console.warn('[assistant-bridge] library save 실패:', err);
    }
  }

  function addMacro(events) {
    const lib = loadLibrary();
    const now = new Date();
    const id = 'macro_' + now.getTime();
    const name = formatName(now);
    const menuId = window.SolomonAdapter?.getScope?.() || 'UNKNOWN';
    lib.macros.push({
      id,
      name,
      ts: now.toISOString(),
      menuId,
      eventCount: events.length,
      events,
    });
    saveLibrary(lib);
    return lib.macros[lib.macros.length - 1];
  }

  function removeMacro(id) {
    const lib = loadLibrary();
    lib.macros = lib.macros.filter((m) => m.id !== id);
    saveLibrary(lib);
  }

  function getMacro(id) {
    return loadLibrary().macros.find((m) => m.id === id);
  }

  function formatName(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `매크로_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ─────────────────────────────────────────────
  // UI 빌드
  // ─────────────────────────────────────────────
  function buildUi() {
    if (uiRoot) return uiRoot;

    uiRoot = document.createElement('div');
    uiRoot.id = 'rpa-macro-toggle';
    uiRoot.innerHTML = `
      <div class="rmt-row">
        <button class="rmt-btn rmt-rec" data-action="record">● 녹화</button>
        <button class="rmt-btn rmt-stop" data-action="stop" disabled>■ 종료</button>
        <button class="rmt-btn rmt-play" data-action="play-last" disabled>▶ 재생</button>
      </div>
      <div class="rmt-status" data-role="status">대기 중</div>
      <div class="rmt-lib-wrap">
        <div class="rmt-lib-header">
          <span data-role="lib-title">매크로 목록 (0)</span>
          <button class="rmt-mini" data-action="lib-clear" title="전체 삭제">전체 삭제</button>
        </div>
        <ul class="rmt-lib" data-role="lib"></ul>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #rpa-macro-toggle {
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #fff;
        border: 1px solid #d0d0d0;
        border-radius: 6px;
        padding: 8px 10px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        z-index: 9999;
      }
      #rpa-macro-toggle.floating {
        position: fixed;
        bottom: 16px;
        right: 16px;
        width: 280px;
      }
      #rpa-macro-toggle.in-dashboard {
        width: 100%;
        box-sizing: border-box;
        box-shadow: none;
      }
      #rpa-macro-toggle .rmt-row { display: flex; gap: 4px; margin-bottom: 6px; }
      #rpa-macro-toggle .rmt-btn {
        flex: 1; padding: 4px 6px; font-size: 12px;
        border: 1px solid #c0c0c0; background: #f7f7f7; border-radius: 4px;
        cursor: pointer;
      }
      #rpa-macro-toggle .rmt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      #rpa-macro-toggle .rmt-rec { color: #c0392b; }
      #rpa-macro-toggle .rmt-stop { color: #2c3e50; }
      #rpa-macro-toggle .rmt-play { color: #27ae60; }
      #rpa-macro-toggle .rmt-status {
        font-size: 11px; color: #555; padding: 2px 4px;
        background: #f1f3f5; border-radius: 3px;
        margin-bottom: 8px;
      }
      #rpa-macro-toggle .rmt-lib-wrap {
        border-top: 1px solid #e8e8e8; padding-top: 6px;
      }
      #rpa-macro-toggle .rmt-lib-header {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 11px; color: #777; margin-bottom: 4px;
      }
      #rpa-macro-toggle .rmt-mini {
        font-size: 10px; padding: 1px 4px;
        border: 1px solid #ddd; background: #fafafa; border-radius: 3px;
        cursor: pointer; color: #888;
      }
      #rpa-macro-toggle .rmt-lib {
        list-style: none; margin: 0; padding: 0;
        max-height: 180px; overflow-y: auto;
      }
      #rpa-macro-toggle .rmt-lib li {
        display: flex; align-items: center; gap: 4px;
        padding: 4px 0; border-bottom: 1px dashed #eee;
        font-size: 11px;
      }
      #rpa-macro-toggle .rmt-lib li:last-child { border-bottom: none; }
      #rpa-macro-toggle .rmt-lib .rmt-lib-name {
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: #333;
      }
      #rpa-macro-toggle .rmt-lib .rmt-lib-meta {
        color: #888; font-size: 10px; margin-right: 4px;
      }
      #rpa-macro-toggle .rmt-lib button {
        font-size: 10px; padding: 1px 5px;
        border: 1px solid #c0c0c0; background: #f7f7f7; border-radius: 3px;
        cursor: pointer;
      }
      #rpa-macro-toggle .rmt-lib .rmt-lib-play { color: #27ae60; }
      #rpa-macro-toggle .rmt-lib .rmt-lib-del  { color: #c0392b; }
      #rpa-macro-toggle .rmt-lib-empty {
        color: #aaa; text-align: center; padding: 8px 0;
      }
    `;
    document.head.appendChild(style);

    uiRoot.addEventListener('click', onUiClick);
    return uiRoot;
  }

  function setStatus(text) {
    const el = uiRoot?.querySelector('[data-role="status"]');
    if (el) el.textContent = text;
  }

  function setBtnState({ recordEnabled, stopEnabled, playLastEnabled }) {
    if (!uiRoot) return;
    const m = (sel, enabled) => {
      const b = uiRoot.querySelector(sel);
      if (b) b.disabled = !enabled;
    };
    m('[data-action="record"]', recordEnabled);
    m('[data-action="stop"]', stopEnabled);
    m('[data-action="play-last"]', playLastEnabled);
  }

  // ─────────────────────────────────────────────
  // 라이브러리 목록 렌더
  // ─────────────────────────────────────────────
  function renderLibrary() {
    if (!uiRoot) return;
    const lib = loadLibrary();
    const list = uiRoot.querySelector('[data-role="lib"]');
    const title = uiRoot.querySelector('[data-role="lib-title"]');
    title.textContent = `매크로 목록 (${lib.macros.length})`;

    if (lib.macros.length === 0) {
      list.innerHTML = `<li class="rmt-lib-empty">아직 녹화한 매크로가 없습니다</li>`;
      return;
    }

    // 최신순 (역순)
    list.innerHTML = lib.macros.slice().reverse().map((m) => `
      <li data-macro-id="${m.id}">
        <span class="rmt-lib-name" title="${escapeHtml(m.name)} · ${m.menuId}">
          ${escapeHtml(m.name)}
        </span>
        <span class="rmt-lib-meta">(${m.eventCount})</span>
        <button class="rmt-lib-play" data-action="lib-play" title="재생">▶</button>
        <button class="rmt-lib-del"  data-action="lib-del"  title="삭제">✕</button>
      </li>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─────────────────────────────────────────────
  // 액션 핸들러
  // ─────────────────────────────────────────────
  function onUiClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'record') return doRecord();
    if (action === 'stop')   return doStop();
    if (action === 'play-last') return doPlayLast();
    if (action === 'lib-play') {
      const id = btn.closest('[data-macro-id]')?.dataset.macroId;
      return doPlayById(id);
    }
    if (action === 'lib-del') {
      const id = btn.closest('[data-macro-id]')?.dataset.macroId;
      return doDelete(id);
    }
    if (action === 'lib-clear') return doClearAll();
  }

  function doRecord() {
    const r = getRecorder();
    if (!r) return;
    r.start();
    setStatus('녹화 중…');
    setBtnState({ recordEnabled: false, stopEnabled: true, playLastEnabled: false });
  }

  function doStop() {
    const r = getRecorder();
    if (!r) return;
    lastEvents = r.stop();
    if (lastEvents.length === 0) {
      setStatus('녹화 종료 — 캡처된 이벤트 없음 (data-rpa-id 박힌 요소 클릭/입력 필요)');
      setBtnState({ recordEnabled: true, stopEnabled: false, playLastEnabled: false });
      return;
    }
    const saved = addMacro(lastEvents);
    setStatus(`저장 완료 — ${saved.name} (이벤트 ${saved.eventCount}개)`);
    setBtnState({ recordEnabled: true, stopEnabled: false, playLastEnabled: true });
    renderLibrary();
  }

  async function doPlayLast() {
    if (!lastEvents.length) return;
    await replayEvents(lastEvents, '방금 녹화');
  }

  async function doPlayById(id) {
    if (!id) return;
    const m = getMacro(id);
    if (!m) {
      setStatus(`재생 실패 — 매크로 ${id} 없음`);
      return;
    }
    await replayEvents(m.events, m.name);
  }

  async function replayEvents(events, label) {
    const r = getRecorder();
    if (!r) return;
    setBtnState({ recordEnabled: false, stopEnabled: false, playLastEnabled: false });
    setStatus(`재생 시작 — ${label} (0/${events.length})`);

    const result = await r.replay(events, {
      onProgress: (i, total) => setStatus(`재생 중 ${label} (${i + 1}/${total})`),
    });

    if (result.success) {
      setStatus(`재생 완료 ✓ ${label} (${result.completedCount}/${result.totalCount})`);
    } else {
      setStatus(`재생 일부 실패 ${label} (${result.completedCount}/${result.totalCount}, 실패 ${result.failed.length}건 — 콘솔 확인)`);
      console.warn('[assistant-bridge] replay failed:', result.failed);
    }
    setBtnState({ recordEnabled: true, stopEnabled: false, playLastEnabled: lastEvents.length > 0 });
  }

  function doDelete(id) {
    if (!id) return;
    if (!confirm('이 매크로를 삭제할까요?')) return;
    removeMacro(id);
    renderLibrary();
    setStatus('매크로 삭제됨');
  }

  function doClearAll() {
    const lib = loadLibrary();
    if (lib.macros.length === 0) return;
    if (!confirm(`매크로 ${lib.macros.length}개를 모두 삭제할까요?`)) return;
    saveLibrary({ version: SCHEMA_VERSION, macros: [] });
    renderLibrary();
    setStatus('전체 삭제됨');
  }

  // ─────────────────────────────────────────────
  // 마운트
  // ─────────────────────────────────────────────
  const DASHBOARD_SELECTORS = [
    '#rpa-macro-dashboard-slot',
    '[data-rpa-dashboard-slot]',
  ];

  function findDashboardSlot() {
    for (const sel of DASHBOARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function hasAssistantShell() {
    return !!document.querySelector('#assistant-root, #assistant-mount, .imsmassi-assistant-content');
  }

  function tryMountToDashboard() {
    const panel = findDashboardSlot();
    if (!panel) return false;
    const ui = buildUi();
    ui.classList.remove('floating');
    ui.classList.add('in-dashboard');
    panel.replaceChildren(ui);
    mountedHost = 'dashboard';
    renderLibrary();
    return true;
  }

  function mountFloating() {
    const ui = buildUi();
    ui.classList.remove('in-dashboard');
    ui.classList.add('floating');
    document.body.appendChild(ui);
    mountedHost = 'floating';
  }

  // 기존에 마운트된 토글을 DOM에서 떼어냄 (재마운트 전 단계).
  function detachUi() {
    if (uiRoot && uiRoot.parentNode) {
      uiRoot.parentNode.removeChild(uiRoot);
    }
  }

  // mount({ force: true }) 호출 시 *위치 무관* 재마운트.
  // 옵션 없이 호출하면 idempotent (이미 적절한 자리면 그대로).
  function mount(opts) {
    const force = opts && opts.force === true;
    const alreadyMounted = uiRoot && document.body.contains(uiRoot);

    if (alreadyMounted && !force) {
      // 대시보드 슬롯이 새로 등장했는데 우리는 floating에 머물러 있다면
      // *암묵적 재마운트* 시도(시각적 위치 자동 따라감).
      if (mountedHost === 'floating' && findDashboardSlot()) {
        detachUi();
        if (!tryMountToDashboard()) mountFloating();
      }
      return;
    }

    if (alreadyMounted && force) detachUi();
    if (!tryMountToDashboard()) {
      if (hasAssistantShell()) {
        mountedHost = 'detached';
        return;
      }
      mountFloating();
    }
    setBtnState({ recordEnabled: true, stopEnabled: false, playLastEnabled: false });
    setStatus('대기 중');
    renderLibrary();
  }

  // 대시보드 슬롯이 *나중에 등장하거나 사라지면* 자동으로 재마운트한다.
  // (사용자가 대시보드 탭으로 이동하거나 다른 탭으로 이동할 때 자연스럽게 따라감)
  let observer = null;
  function startPanelObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      const panel = findDashboardSlot();
      const inAssistant = uiRoot && panel && panel.contains(uiRoot);
      const shouldBeDashboard = !!panel;

      if (shouldBeDashboard && mountedHost !== 'dashboard') {
        // 대시보드가 렌더링되면 대시보드 안으로 이동
        detachUi();
        tryMountToDashboard();
      } else if (!shouldBeDashboard && mountedHost === 'dashboard') {
        // 대시보드가 사라지면 어시스턴트 내부에서는 노출하지 않음
        detachUi();
        mountedHost = hasAssistantShell() ? 'detached' : mountedHost;
      } else if (shouldBeDashboard && !inAssistant && mountedHost === 'dashboard') {
        // dashboard 모드인데 슬롯 밖에 떨어진 경우(대시보드 재렌더링)
        detachUi();
        tryMountToDashboard();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { mount(); startPanelObserver(); }, { once: true });
    } else {
      mount();
      startPanelObserver();
    }
  }

  // ─────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────
  // 진단용: 가장 최근 매크로의 events 를 콘솔에 보기 좋게 출력.
  // 사용: AssistantBridge.dumpLast()  또는  AssistantBridge.dumpLast(true) 면 클립보드 복사
  function dumpLast(toClipboard = false) {
    const lib = loadLibrary();
    const last = lib.macros[lib.macros.length - 1];
    if (!last) {
      console.log('[assistant-bridge] 저장된 매크로 없음');
      return null;
    }
    const json = JSON.stringify(last.events, null, 2);
    console.log(`[assistant-bridge] "${last.name}" — ${last.eventCount} events`);
    console.log(json);
    if (toClipboard && typeof window !== 'undefined' && window.copy) {
      try { window.copy(json); console.log('(클립보드 복사 완료)'); } catch (_) {}
    }
    return last.events;
  }

  const api = {
    init,
    mount,
    getLastEvents: () => lastEvents.slice(),
    getMountedHost: () => mountedHost,
    getLibrary: () => loadLibrary(),
    refreshLibrary: renderLibrary,
    dumpLast,
  };
  if (typeof window !== 'undefined') window.AssistantBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
