// rpa-decorator.js — 식별자 주입기
//
// 무엇: 페이지의 모든 입력칸/버튼/링크에 data-rpa-id 를 자동으로 붙인다.
//       동적으로 추가되는 요소도 MutationObserver로 감지해 자동 데코레이션.
// 왜:   매크로 녹화·재생이 *고정 별명* 으로 요소를 찾아갈 수 있도록.
//       솔로몬 DOM id는 동적이라 매번 바뀌므로, 별명을 미리 박아둬야 안정.
// 어떻게:
//   1) decorate(root): 한 번 일괄 스캔
//   2) startObserving(root): 동적 추가 자동 감지 시작
//   3) stopObserving(): 감지 종료
//   4) 어떤 요소에 어떤 별명을 부여할지는 SolomonAdapter.makeRpaId() 위임
//
// 가이드 원본(2.5절 decorateGrid)는 그리드 한정. PoC plan §2-1 검토대로
// 그리드 외 일반 요소까지 커버하도록 확장. 단 재귀 비용을 줄이기 위해
// "관심 있는 요소 셀렉터" 만 스캔.

(function (root) {
  // 데코레이션 대상 셀렉터 (관심 요소만 스캔)
  // WebSquare 커스텀 위젯 외곽도 포함 — 내부 readonly input은 setValue로만
  // 값이 바뀌고 native change 가 안 나오므로, 외곽 위젯에 별명을 박아두고
  // recorder가 라벨 변경을 따로 관찰해야 한다.
  const TARGET_SELECTOR = [
    'input',
    'button',
    'select',
    'textarea',
    'a[href]',
    'tr[data-rowid]',          // 가이드 원본 패턴
    'td[data-colkey]',         // 가이드 원본 패턴
    '[data-clickable]',
    '[role="button"]',         // div/span 으로 만든 버튼 (모달 확인/취소 등)
    '[role="combobox"]',       // WebSquare w2autoComplete 등 콤보박스 외곽
    '.w2autoComplete',         // 클래스 매칭 (role 미부여 변종 대비)
    '.w2selectbox_native',     // WebSquare 기본 셀렉트박스
    '.w2inputCalendar',        // 날짜 위젯 (calUep... 등) — value 가 inner input
    '.w2inputCalendar_div',    // 날짜 위젯 외곽 div 변종
    '.w2datepicker',           // (구버전 호환) 날짜 위젯
    '.w2popup',                // 팝업/모달 외곽 (모달 안 input/click 추적용)
  ].join(', ');

  // 데코레이션 제외 영역 (재귀 캡처 방지 + unmatched 노이즈 제거)
  // - 어시스턴트 자체 UI / 우리 매크로 토글 박스 / 사용자 수동 마커
  const EXCLUDE_SELECTOR = [
    '#assistant-mount',
    '#assistant-root',
    '.imsmassi-assistant-body',
    '#imsmassi-panel-outer',
    '.imsmassi-floating-btn',
    '#rpa-macro-toggle',
    '[data-rpa-skip]',
  ].join(', ');

  function isExcluded(el) {
    return !!(el && el.closest && el.closest(EXCLUDE_SELECTOR));
  }

  let observer = null;
  let lastDecoratedCount = 0;

  function getAdapter() {
    return (typeof window !== 'undefined' && window.SolomonAdapter)
      ? window.SolomonAdapter
      : null;
  }

  // ─────────────────────────────────────────────────────
  // 단일 요소 데코레이션
  // ─────────────────────────────────────────────────────
  function decorateElement(el) {
    // 이미 박혀있으면 skip (중복 방지 + 안정성)
    if (el.dataset.rpaId) return false;
    // 제외 영역(어시스턴트/매크로 토글)은 별명 안 박음 — adapter unmatched 도 발생 X
    if (isExcluded(el)) return false;

    const adapter = getAdapter();
    if (!adapter) {
      console.warn('[rpa-decorator] SolomonAdapter 미로드');
      return false;
    }

    const rpaId = adapter.makeRpaId(el);
    if (!rpaId) return false;     // unmatched는 어댑터가 stats에 기록

    el.dataset.rpaId = rpaId;
    return true;
  }

  // ─────────────────────────────────────────────────────
  // 일괄 스캔
  // ─────────────────────────────────────────────────────
  function decorate(rootEl = document) {
    let count = 0;
    const targets = rootEl.querySelectorAll(TARGET_SELECTOR);
    targets.forEach((el) => {
      if (decorateElement(el)) count++;
    });
    lastDecoratedCount = count;
    return count;
  }

  // ─────────────────────────────────────────────────────
  // 동적 감지 (MutationObserver)
  // ─────────────────────────────────────────────────────
  // - 새로 추가된 노드(addedNodes)에서 TARGET_SELECTOR 매칭 요소를 데코레이션
  // - 기존 노드의 속성 변경은 감시 안 함 (성능)
  function startObserving(rootEl = document.body) {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 추가된 노드 자체 검사
          if (node.matches?.(TARGET_SELECTOR)) decorateElement(node);
          // 추가된 서브트리 안의 대상 검사
          node.querySelectorAll?.(TARGET_SELECTOR)?.forEach(decorateElement);
        }
      }
    });
    observer.observe(rootEl, { childList: true, subtree: true });
  }

  function stopObserving() {
    observer?.disconnect();
    observer = null;
  }

  // ─────────────────────────────────────────────────────
  // 가이드 원본의 decorateGrid 도 호환 유지 (필요 시 직접 호출)
  // ─────────────────────────────────────────────────────
  function decorateGrid(gridId, scope) {
    const grid = document.getElementById(gridId);
    if (!grid) return 0;
    let count = 0;
    grid.querySelectorAll('tr[data-rowid]').forEach((tr) => {
      const rid = tr.dataset.rowid;
      if (!tr.dataset.rpaId) {
        tr.dataset.rpaId = `${scope}.grid.row_${rid}`;
        count++;
      }
      tr.querySelectorAll('td[data-colkey]').forEach((td) => {
        const ck = td.dataset.colkey;
        if (!td.dataset.rpaId) {
          td.dataset.rpaId = `${scope}.grid.row_${rid}.cell_${ck}`;
          count++;
        }
      });
    });
    return count;
  }

  // ─────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────
  const api = {
    decorate,
    decorateElement,
    decorateGrid,
    startObserving,
    stopObserving,
    getLastCount: () => lastDecoratedCount,
  };
  if (typeof window !== 'undefined') window.RpaDecorator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
