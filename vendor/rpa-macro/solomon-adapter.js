// solomon-adapter.js — 솔로몬 환경 어댑터 (다단 폴백 rpaId 생성기)
//
// 무엇: DOM 요소 하나를 받아서 rpaId(별명) 문자열을 만들어 반환한다.
//       매칭 안 되면 null 반환 + unmatched 리스트에 push.
// 왜:   솔로몬은 화면마다 명명 규칙이 다를 수 있어 단일 규칙으로는 부족.
//       PoC plan §4 — ID 규칙 일반화 금지.
// 어떻게: 여러 폴백 단계를 순서대로 시도. 처음 매칭되는 단계의 결과 채택.
//
// Phase A 범위: 폴백 1·2단계만 구현
//   1) data-title 한글 라벨 + window.getMenuId() scope
//   2) DOM id 의미 suffix (동적 prefix 제거 후)
// Phase B 보강 (4/29 — 베어 select 미캡처 이슈):
//   3) name 속성
//   4) aria-label 속성
//   5) placeholder 속성 (input/textarea)
//   6) 부모 <label> 텍스트 (자기 자신 노드 제거 후)
//   7) 직전 형제 텍스트/짧은 라벨 노드
//   8) 위치 기반 폴백 (parent 식별자 + tagName + index) — 마지막 보루
// 화면별 룰셋 테이블은 향후 확장 후보.

(function (root) {
  // ─────────────────────────────────────────────────────
  // 내부 상태
  // ─────────────────────────────────────────────────────
  const stats = {
    matched: {
      fallback1: 0,  // data-title
      fallback2: 0,  // id suffix
      fallback3: 0,  // name
      fallback4: 0,  // aria-label
      fallback5: 0,  // placeholder
      fallback6: 0,  // label 텍스트
      fallback7: 0,  // 직전 형제 텍스트
      fallback8: 0,  // 위치 기반
    },
    unmatched: [],   // [{ tagName, id, classList, ... }]
  };

  // 별명 정규화 — 공백/제어문자를 _ 로, 너무 긴 경우 컷.
  // querySelector의 셀렉터 안정성과 사람이 읽기 좋은 길이 양쪽을 노린다.
  function normalizeName(s) {
    if (!s) return null;
    const cleaned = String(s).replace(/[\s ]+/g, '_').replace(/[^\w\-가-힣]/g, '').slice(0, 40);
    return cleaned || null;
  }

  // ─────────────────────────────────────────────────────
  // 유틸 — scope 추출
  // ─────────────────────────────────────────────────────
  function getScope() {
    // 1) 호스트 제공 함수 우선 (어시스턴트 demo 패턴)
    if (typeof window.getMenuId === 'function') {
      const id = window.getMenuId();
      if (id) return id;          // 예: "UW-001"
    }
    // 2) 폴백: 활성 화면 패널의 data-screen-id
    const sel = document.querySelector('.w2windowContainer_selectedNameLayer');
    if (sel?.dataset?.screenId) return sel.dataset.screenId;
    // 3) 마지막 폴백: .pg-id 텍스트
    const pgEl = document.querySelector('.pg-id');
    if (pgEl?.textContent) return pgEl.textContent.trim();
    return 'UNKNOWN';
  }

  // ─────────────────────────────────────────────────────
  // 폴백 1: data-title 한글 라벨
  // ─────────────────────────────────────────────────────
  // td/th 같은 부모 요소를 거슬러 올라가며 data-title 탐색.
  // 예: <td data-title="$$상품코드"><input ...></td>
  // → "$$상품코드"에서 "$$" 접두사 제거 후 사용
  function tryDataTitle(el) {
    let cursor = el;
    while (cursor && cursor !== document.body) {
      const t = cursor.getAttribute?.('data-title');
      if (t) return t.replace(/^\$\$/, '').trim();
      cursor = cursor.parentElement;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────
  // 폴백 2: DOM id 의미 suffix
  // ─────────────────────────────────────────────────────
  // 예: "mf_Frames_Main_subWindow10_wframe_..._divClsBs_edtCtNo"
  //     → 동적 prefix/표준 noise 제거
  //     → 의미 토큰 2개("divClsBs", "edtCtNo") 결합
  //     → "divClsBs_edtCtNo"
  //
  // 1토큰만 쓰면 같은 라벨/같은 element-name 을 공유하는 위젯이 영역(divX)만
  // 다른 경우 충돌(multi-match)이 난다 — 검색조건 vs 종목기본의 "계약번호_edtCtNo".
  // 의미 토큰을 끝에서 최대 2개 모아 결합해 영역 구분을 포함한다.
  //
  // skipTokens: 솔로몬 id 가 일관되게 끼워넣는 표준 noise (위치 정보 없음)
  const SKIP_ID_TOKENS = new Set([
    'mf', 'frames', 'main', 'wframe', 'workmain',
    'group', 'tbody', 'thead', 'div', 'span',
  ]);

  function tryIdSuffix(el) {
    const id = el.id;
    if (!id) return null;
    const parts = id.split('_');
    if (parts.length === 0) return null;

    // 끝에서부터 의미 토큰 모음 — 최대 2개
    const meaningful = [];
    for (let i = parts.length - 1; i >= 0 && meaningful.length < 2; i--) {
      const tok = parts[i];
      if (!tok) continue;
      if (/^uuid$/i.test(tok)) continue;
      if (SKIP_ID_TOKENS.has(tok.toLowerCase())) continue;
      // 순수 숫자 토큰 처리:
      //   - "wq_uuid_NNN" 같이 직전 토큰이 wq/uuid 면 의미 없는 자동 ID → 스킵
      //   - "row_5", "cell_3", "page_2" 등은 의미 있는 인덱스 → 보존
      //     (그렇지 않으면 row_0, row_1 같은 행들이 모두 'row' 로 충돌)
      if (/^\d+$/.test(tok)) {
        const prev = (parts[i - 1] || '').toLowerCase();
        if (prev === 'uuid' || prev === 'wq') continue;
      }
      meaningful.unshift(tok);
    }
    return meaningful.length ? meaningful.join('_') : null;
  }

  // ─────────────────────────────────────────────────────
  // 폴백 3: name 속성
  // ─────────────────────────────────────────────────────
  // 표준 폼 요소면 거의 박혀있는 1차 hint. 동적 prefix 없음.
  function tryNameAttr(el) {
    return normalizeName(el.getAttribute?.('name'));
  }

  // ─────────────────────────────────────────────────────
  // 폴백 4: aria-label
  // ─────────────────────────────────────────────────────
  function tryAriaLabel(el) {
    return normalizeName(el.getAttribute?.('aria-label'));
  }

  // ─────────────────────────────────────────────────────
  // 폴백 5: placeholder (input/textarea 한정)
  // ─────────────────────────────────────────────────────
  function tryPlaceholder(el) {
    const tag = el.tagName?.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return null;
    return normalizeName(el.getAttribute?.('placeholder'));
  }

  // ─────────────────────────────────────────────────────
  // 폴백 6: 부모 <label> 텍스트
  // ─────────────────────────────────────────────────────
  // 패턴: <label>보험 상품<select>...</select></label>
  //       → label 텍스트만 추출(자기 자신·다른 입력칸 제거 후) → "보험_상품"
  // for-id 매칭(<label for="x">...) 도 동일 방식으로 커버.
  function tryLabelText(el) {
    let label = el.closest?.('label');
    if (!label && el.id) {
      // for=id 로 연결된 label 도 시도
      label = document.querySelector?.(`label[for="${cssEscapeAttr(el.id)}"]`);
    }
    if (!label) return null;
    const clone = label.cloneNode(true);
    // 자기 자신과 다른 폼 컨트롤은 제거 — label 텍스트만 남김
    clone.querySelectorAll?.('input, select, textarea, button')
      .forEach((n) => n.remove());
    const text = (clone.textContent || '').trim();
    return normalizeName(text);
  }

  // ─────────────────────────────────────────────────────
  // 폴백 7: 직전 형제 텍스트/짧은 라벨
  // ─────────────────────────────────────────────────────
  // 패턴: <span>고객명</span><input>
  //       → "고객명"
  // 텍스트 노드 또는 30자 이내의 element를 라벨로 인정.
  function tryPrecedingText(el) {
    let prev = el.previousSibling;
    while (prev) {
      if (prev.nodeType === 3 /* TEXT_NODE */) {
        const t = (prev.textContent || '').trim();
        if (t) return normalizeName(t);
      } else if (prev.nodeType === 1 /* ELEMENT_NODE */) {
        // 입력/버튼류는 라벨이 아니므로 중단
        const ptag = prev.tagName.toLowerCase();
        if (['input', 'select', 'textarea', 'button'].includes(ptag)) break;
        const t = (prev.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 30) return normalizeName(t);
        break;
      }
      prev = prev.previousSibling;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────
  // 폴백 8: 위치 기반 (마지막 보루)
  // ─────────────────────────────────────────────────────
  // 식별 단서가 전혀 없는 베어 요소(예: <select> 만)도 매크로에 잡혀야 한다.
  // 부모 식별자(id/class) + 같은 태그 형제 인덱스 조합으로 합성.
  // 같은 화면(scope)/같은 부모/같은 태그 안에서 위치가 바뀌지 않는 한 안정.
  function tryPositional(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const idx = sameTag.indexOf(el);
    if (idx < 0) return null;
    const parentTag = parent.tagName?.toLowerCase() || 'p';
    const parentHint =
      parent.id ||
      (parent.className && typeof parent.className === 'string'
        ? parent.className.split(/\s+/).find((c) => c && !/^w2|^uw_/.test(c))
        : null) ||
      parentTag;
    return normalizeName(`${parentHint}_${el.tagName.toLowerCase()}_${idx}`);
  }

  // CSS.escape 폴백 (속성 값용)
  function cssEscapeAttr(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/"/g, '\\"');
  }

  // ─────────────────────────────────────────────────────
  // 컴포넌트 종류 분류 (rpaId의 component 부분)
  // ─────────────────────────────────────────────────────
  function classifyComponent(el) {
    // WebSquare 커스텀 위젯 우선 (tagName 보다 먼저)
    if (el.matches?.('[role="button"]')) return 'btn';
    if (el.matches?.('[role="combobox"], .w2autoComplete')) return 'combobox';
    if (el.matches?.('.w2selectbox_native')) return 'select';
    if (el.matches?.('.w2inputCalendar, .w2inputCalendar_div, .w2datepicker')) return 'datepicker';
    if (el.matches?.('.w2popup')) return 'popup';

    const tag = el.tagName?.toLowerCase();
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'button' || type === 'submit') return 'btn';
      return 'form';
    }
    if (tag === 'button') return 'btn';
    if (tag === 'select') return 'select';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'a') return 'link';
    return tag || 'el';
  }

  // ─────────────────────────────────────────────────────
  // 메인 진입점
  // ─────────────────────────────────────────────────────
  function makeRpaId(el) {
    if (!el || el.nodeType !== 1) return null;

    const scope = getScope();
    const component = classifyComponent(el);

    // 우선순위:
    //   1. data-title (의미 가장 명확)  ← + id suffix 가 있으면 결합 (유일성)
    //   2. id suffix  (솔로몬 메인 패턴)
    //   3. name       (표준 폼 속성)
    //   4. aria-label (접근성 라벨)
    //   5. placeholder
    //   6. 부모 <label> 텍스트            ← + id suffix 결합
    //   7. 직전 형제 텍스트                ← + id suffix 결합
    //   8. 위치 기반 합성 — 베어 요소 마지막 보루
    //
    // 유일성 보강 (4/29): 같은 라벨을 공유하는 위젯이 여러 개 있을 때
    //   (예: 검색조건의 "적용일자"와 본문의 "적용일자")
    //   라벨 단독으로는 querySelector 가 첫 매칭만 찾아 잘못된 위젯에
    //   재생이 들어간다. id suffix 가 있으면 결합해서 유일성을 확보.
    //   id 없는 요소는 라벨 단독을 그대로 사용 (현재 동작 유지).
    const idName = tryIdSuffix(el);

    const tries = [
      ['fallback1', tryDataTitle, true],   // composite: 라벨 + id
      ['fallback2', tryIdSuffix,  false],  // 이미 id 자체
      ['fallback3', tryNameAttr,  true],
      ['fallback4', tryAriaLabel, true],
      ['fallback5', tryPlaceholder, true],
      ['fallback6', tryLabelText, true],
      ['fallback7', tryPrecedingText, true],
      ['fallback8', tryPositional, false], // 이미 위치로 유일
    ];

    for (const [key, fn, allowComposite] of tries) {
      const name = fn(el);
      if (name) {
        stats.matched[key]++;
        const finalName = (allowComposite && idName && idName !== name)
          ? `${name}_${idName}`
          : name;
        return `${scope}.${component}.${finalName}`;
      }
    }

    // 매칭 실패 — unmatched 보고 (위치 폴백까지 실패한 케이스만 도달)
    stats.unmatched.push({
      tagName: el.tagName,
      id: el.id || '(no id)',
      classList: el.className || '',
      text: (el.textContent || '').slice(0, 30),
    });
    return null;
  }

  function getStats() {
    return JSON.parse(JSON.stringify(stats));
  }

  function resetStats() {
    Object.keys(stats.matched).forEach((k) => { stats.matched[k] = 0; });
    stats.unmatched.length = 0;
  }

  // ─────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────
  const api = { makeRpaId, getStats, resetStats, getScope };
  if (typeof window !== 'undefined') window.SolomonAdapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
