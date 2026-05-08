// macro-recorder.js — 매크로 녹화·재생 엔진
//
// 무엇: 사용자의 click/input/change 이벤트를 시간 순서로 events[]에 기록(start~stop),
//       나중에 events를 받아 같은 순서로 재현(replay).
// 왜:   사용자가 본인 반복 작업을 1회 녹화 → 매번 자동 재생. RPA의 가장 단순한 형태.
// 어떻게:
//   - start() / stop() 명시 호출 (자동 추적 X)
//   - data-rpa-id 가 박힌 요소만 캡처 (식별자 없는 요소는 노이즈로 제외)
//   - 어시스턴트/매크로 토글 영역은 캡처 제외 (재귀 캡처 방지)
//   - 재생 시 웹스퀘어 컴포넌트 API ($p.comp[id].setValue) 우선 사용 (Phase B 보강)
//
// Phase B 보강 (4/28 폐쇄망 검증 결과 반영):
//   1. change 이벤트 캡처 — select/checkbox/날짜위젯/팝업 적용 동작 처리
//   2. 재생 시 $p.comp setValue 우선 호출 — 솔로몬 내부 상태 + 핸들러 체인 정상 발화
//   3. 재생 후 blur dispatch — onkillfocus 핸들러 트리거
//   4. 어시스턴트/매크로 토글 영역 제외 — 재귀 캡처 방지
//
// Phase C 보강 (4/29 — WebSquare 커스텀 콤보박스 캡처):
//   5. w2autoComplete 등 readonly + setValue 위젯의 라벨 변경을 감지해
//      가짜 change 이벤트로 events 에 push. native change 가 안 나오는 위젯의
//      값 변경을 캡처하기 위한 우회로.
//
// Phase D 보강 (4/29 — 캘린더 위젯 + 모달 결과 캡처):
//   6. value 폴링 — w2inputCalendar 처럼 input.value (프로퍼티) 만 바뀌고
//      DOM mutation 이 안 나오는 위젯의 값 변경을 setInterval 로 250ms 폴링.
//      MutationObserver 와 같은 _wqLastSnap Map 을 공유해 dedupe.
//   7. 모달 commit 후 부모 폼 변경도 같은 폴러가 자동 캡처. 모달 인터랙션
//      자체를 재현하지 않고, 결과로 바뀐 부모 값만 setValue 로 재현하는 전략.

(function (root) {
  // ─────────────────────────────────────────────
  // 캡처 제외 영역 (재귀 캡처 방지)
  // ─────────────────────────────────────────────
  // 어시스턴트 자체 UI / 우리 매크로 토글 / 사용자가 명시 제외한 영역
  const EXCLUDE_SELECTOR = [
    '#assistant-mount',                  // 어시스턴트 마운트 컨테이너
    '#assistant-root',                   // 어시스턴트 루트
    '.imsmassi-assistant-body',          // 어시스턴트 바디
    '#imsmassi-panel-outer',             // 어시스턴트 패널 외부
    '.imsmassi-floating-btn',            // 어시스턴트 플로팅 버튼
    '#rpa-macro-toggle',                 // 우리 매크로 토글 박스
    '[data-rpa-skip]',                   // 사용자 수동 마커
  ].join(', ');

  // 커스텀 콤보박스/위젯 — readonly 라 native change 가 안 나오는 위젯들.
  // 데코는 rpa-decorator.js TARGET_SELECTOR 와 동기화되어야 한다.
  const WIDGET_SELECTOR = [
    '[data-rpa-id][role="combobox"]',
    '[data-rpa-id].w2autoComplete',
    '[data-rpa-id].w2selectbox_native',
    '[data-rpa-id].w2inputCalendar',
    '[data-rpa-id].w2inputCalendar_div',
    '[data-rpa-id].w2datepicker',
  ].join(', ');

  // 폴러가 추가로 감시할 일반 폼 요소 — 모달 commit 후 부모 폼 input 에
  // setValue 만으로 값이 들어오는 케이스를 잡기 위해.
  // 위젯 내부 input 은 WIDGET_SELECTOR 매칭으로 별도 처리되므로 :not() 으로 제외.
  const FORM_POLL_SELECTOR = [
    '[data-rpa-id]:is(input,select,textarea):not([type=button]):not([type=submit])',
  ].join(', ');

  function isExcluded(el) {
    return !!(el && el.closest && el.closest(EXCLUDE_SELECTOR));
  }

  // Phase I: WebSquare $p.comp.getValue() 우선으로 raw 값 읽기.
  //   사업비 같은 w2inputNumber/w2inputAmount 위젯은 표시값이 "123,123"이지만
  //   내부 raw 는 "123123" 이다. 표시값을 캡처/재생하면 setValue 가 콤마를
  //   못 파싱해 NaN 으로 망가진다. getValue 가 있으면 그걸 우선 쓰고,
  //   없으면 .value 로 폴백.
  function readRawValue(el) {
    if (!el) return '';
    try {
      const comp = window.$p && window.$p.comp && window.$p.comp[el.id];
      if (comp && typeof comp.getValue === 'function') {
        const v = comp.getValue();
        return v == null ? '' : String(v);
      }
    } catch (_) { /* fall through */ }
    return typeof el.value === 'string' ? el.value : '';
  }

  // 위젯의 현재 값/라벨 스냅샷.
  // 우선순위: $p.comp.getValue() → 내부 input.value → 라벨 텍스트
  // value 는 재생 시 setValue 인자로 쓰이므로 *내부 값* 을 우선.
  function readWidgetValue(widget) {
    let value = '';
    let label = readWidgetLabel(widget);
    try {
      const comp = window.$p && window.$p.comp && window.$p.comp[widget.id];
      if (comp && typeof comp.getValue === 'function') {
        value = String(comp.getValue() ?? '');
        return { value, label };
      }
    } catch (_) { /* fall through */ }
    const innerInput = widget.querySelector('input');
    if (innerInput && typeof innerInput.value === 'string') {
      value = innerInput.value;
      return { value, label };
    }
    // 마지막 폴백: 라벨 텍스트를 값으로 (덜 정확하지만 setValue 가 라벨로
    // 검색하는 위젯도 있어 동작은 함)
    return { value: label, label };
  }

  function readWidgetLabel(widget) {
    // 1) `${widget.id}_label` (WebSquare 표준 패턴)
    if (widget.id) {
      const direct = document.getElementById(widget.id + '_label');
      if (direct) return (direct.textContent || '').trim();
    }
    // 2) 클래스 기반 폴백
    const span = widget.querySelector('.w2autoComplete_label_label, .w2datepicker_label, [class*="_label_label"]');
    if (span) return (span.textContent || '').trim();
    // 3) 위젯 자체의 텍스트 (마지막 보루)
    return (widget.textContent || '').trim().slice(0, 60);
  }

  class MacroRecorder {
    constructor(options = {}) {
      this.events = [];
      this.recording = false;
      this.options = {
        captureClick: true,
        captureInput: true,
        captureChange: true,           // 신규: select/checkbox/날짜위젯
        captureWidgets: true,          // Phase C: w2autoComplete 등 라벨 감시
        useWebSquareApi: true,         // 신규: 재생 시 $p.comp.setValue 우선
        dispatchBlurAfter: true,       // 신규: 입력 재생 후 blur dispatch
        debug: false,                  // Phase G: true 면 캡처 즉시 콘솔 표시
        ...options,
      };
      this._click = null;
      this._dblclick = null;          // Phase J: 행 더블클릭(=선택+확정) 캡처
      this._input = null;
      this._change = null;
      this._wqWatcher = null;
      this._wqLastSnap = null;         // Map<rpaId, { value, label }>
      this._wqPollerId = null;         // setInterval id (Phase D)
      this._wqPollIntervalMs = options.widgetPollIntervalMs ?? 250;
    }

    // ─────────────────────────────────────────────
    // 녹화
    // ─────────────────────────────────────────────
    start() {
      this.events = [];
      this.recording = true;
      this._bindHandlers();
    }

    stop() {
      this.recording = false;
      this._unbindHandlers();
      return this.events;
    }

    _bindHandlers() {
      if (this.options.captureClick) {
        this._click = (e) => this._record('click', e);
        document.addEventListener('click', this._click, true);
        // Phase J: 더블클릭(행 선택+확정) — click/click/dblclick 시퀀스 중 dblclick 캡처
        this._dblclick = (e) => this._record('dblclick', e);
        document.addEventListener('dblclick', this._dblclick, true);
      }
      if (this.options.captureInput) {
        this._input = (e) => this._record('input', e);
        document.addEventListener('input', this._input, true);
      }
      if (this.options.captureChange) {
        this._change = (e) => this._record('change', e);
        document.addEventListener('change', this._change, true);
      }
      if (this.options.captureWidgets) {
        this._bindWidgetWatcher();
      }
    }

    _unbindHandlers() {
      if (this._click)    document.removeEventListener('click',    this._click,    true);
      if (this._dblclick) document.removeEventListener('dblclick', this._dblclick, true);
      if (this._input)    document.removeEventListener('input',    this._input,    true);
      if (this._change)   document.removeEventListener('change',   this._change,   true);
      this._click = this._dblclick = this._input = this._change = null;
      this._unbindWidgetWatcher();
    }

    // ─────────────────────────────────────────────
    // Phase C: WebSquare 콤보박스 라벨 변경 감지
    // ─────────────────────────────────────────────
    // 단일 document-level MutationObserver 로 처리.
    // characterData/childList 변경 → 부모로 거슬러 올라가 데코된 위젯을 찾음.
    // value/label 둘 다 동일하면 무시 (debounce 효과).
    _bindWidgetWatcher() {
      this._wqLastSnap = new Map();
      // 초기 스냅샷 — 녹화 시작 시점의 값을 baseline 으로
      document.querySelectorAll(WIDGET_SELECTOR).forEach((w) => {
        if (isExcluded(w)) return;
        this._wqLastSnap.set(w.dataset.rpaId, readWidgetValue(w));
      });
      // Phase E: 일반 폼 요소도 baseline 잡기 (모달 commit 결과 폴링용)
      // Phase I: readRawValue 통일
      document.querySelectorAll(FORM_POLL_SELECTOR).forEach((el) => {
        if (isExcluded(el)) return;
        if (el.closest(WIDGET_SELECTOR)) return;  // 위젯 내부는 위에서 처리
        const rpaId = el.dataset.rpaId;
        if (!rpaId) return;
        this._wqLastSnap.set(rpaId, { value: readRawValue(el), label: '' });
      });

      this._wqWatcher = new MutationObserver((mutations) => {
        if (!this.recording) return;
        // 같은 위젯에 대해 한 번의 mutation 버스트가 여러 번 깨질 수 있어
        // dirty set 으로 모은 뒤 한 번에 비교
        const dirty = new Set();
        for (const mut of mutations) {
          const target = mut.target.nodeType === 3 /* TEXT_NODE */
            ? mut.target.parentElement
            : mut.target;
          if (!target || !target.closest) continue;
          const widget = target.closest(WIDGET_SELECTOR);
          if (!widget) continue;
          if (isExcluded(widget)) continue;
          dirty.add(widget);
        }
        for (const widget of dirty) {
          const rpaId = widget.dataset.rpaId;
          if (!rpaId) continue;
          const snap = readWidgetValue(widget);
          const prev = this._wqLastSnap.get(rpaId);
          if (prev && prev.value === snap.value && prev.label === snap.label) continue;
          this._wqLastSnap.set(rpaId, snap);
          this.events.push({
            type: 'change',
            rpaId,
            value: snap.value,
            label: snap.label,
            widget: 'wq',           // 재생 시 setValue 우선 힌트
            ts: Date.now(),
          });
        }
      });
      this._wqWatcher.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      // Phase D: 값 폴러 — MutationObserver 가 못 보는 input.value 프로퍼티
      //          변경(캘린더, 모달 commit 결과 등)을 잡기 위한 보강.
      //          _wqLastSnap 을 공유하므로 MO 와 dedupe 자동.
      this._wqPollerId = setInterval(() => this._pollWidgetValues(), this._wqPollIntervalMs);
    }

    _pollWidgetValues() {
      if (!this.recording) return;
      // 1) 커스텀 위젯 (라벨/내부 input 종합)
      const widgets = document.querySelectorAll(WIDGET_SELECTOR);
      for (const widget of widgets) {
        if (isExcluded(widget)) continue;
        const rpaId = widget.dataset.rpaId;
        if (!rpaId) continue;
        const snap = readWidgetValue(widget);
        if (this._handleSnap(rpaId, snap, 'wq')) continue;
      }
      // 2) Phase E: 일반 폼 요소 — 모달 commit 등 .value 프로퍼티만 바뀌는 케이스
      // Phase I: readRawValue 로 WebSquare 컴포넌트 raw 값 우선 읽기.
      const inputs = document.querySelectorAll(FORM_POLL_SELECTOR);
      for (const input of inputs) {
        if (isExcluded(input)) continue;
        // 위젯 내부는 위 루프에서 처리됨
        if (input.closest(WIDGET_SELECTOR)) continue;
        const rpaId = input.dataset.rpaId;
        if (!rpaId) continue;
        const snap = { value: readRawValue(input), label: '' };
        this._handleSnap(rpaId, snap, 'form');
      }
    }

    // 공통 스냅샷 처리: prev 와 다르면 events 에 push, 같으면 no-op.
    // baseline (prev 가 아예 없는 경우) 은 record 하지 않고 lastSnap 만 갱신.
    // return true 면 변경 감지 (호출측 continue 신호 — 의미는 없지만 일관성).
    _handleSnap(rpaId, snap, kind) {
      const prev = this._wqLastSnap.get(rpaId);
      if (prev && prev.value === snap.value && prev.label === snap.label) return false;
      this._wqLastSnap.set(rpaId, snap);
      if (!prev) return false; // baseline
      const ev = {
        type: 'change',
        rpaId,
        value: snap.value,
        source: 'poll',
        ts: Date.now(),
      };
      if (kind === 'wq') {
        ev.label = snap.label;
        ev.widget = 'wq';
      }
      this.events.push(ev);
      return true;
    }

    _unbindWidgetWatcher() {
      if (this._wqWatcher) {
        this._wqWatcher.disconnect();
        this._wqWatcher = null;
      }
      if (this._wqPollerId) {
        clearInterval(this._wqPollerId);
        this._wqPollerId = null;
      }
      this._wqLastSnap = null;
    }

    _record(type, e) {
      if (!this.recording) return;
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      // 어시스턴트/매크로 토글 영역은 무시 (재귀 캡처 방지)
      if (isExcluded(target)) return;

      // Phase C/D: 커스텀 위젯 내부 click/input/change 는 widget watcher 가
      // 외곽 위젯 rpaId 로 단일 change 이벤트로 변환한다. 안쪽 input 도
      // rpaId 가 박혀있어 native 이벤트가 한 번 더 기록되면 dupe 가 되므로
      // 위젯 내부 이벤트는 모두 드롭. (replay 는 외곽 widget 의 setValue 만
      // 호출하면 됨) — dblclick 은 row 더블클릭 같이 위젯 밖 케이스 위주라
      // 단순화 위해 동일 처리.
      if (target.closest && target.closest(WIDGET_SELECTOR)) {
        return;
      }

      // Phase J: 더블클릭이 들어오면 직전 같은 rpaId 의 click 1~2 건은
      //          드롭. 브라우저는 click+click+dblclick 순으로 발화하므로
      //          replay 시 두 번의 click 이 row select toggling 을 일으켜
      //          dblclick 효과(=선택 확정)를 가릴 수 있다.
      if (type === 'dblclick') {
        let popped = 0;
        while (popped < 2 && this.events.length > 0) {
          const last = this.events[this.events.length - 1];
          if (last.type === 'click' && last.rpaId === target.dataset?.rpaId) {
            this.events.pop();
            popped++;
          } else break;
        }
      }

      const rpaId = target.dataset?.rpaId;
      if (!rpaId) return;          // 식별자 없는 요소는 기록 제외

      // Phase I: WebSquare 컴포넌트면 raw 값 우선 (사업비 NaNNaN 방지).
      // 일반 input 은 .value 그대로.
      const curValue = readRawValue(target);

      // Phase E: native value 이벤트는 폴러와 dedupe 위해 lastSnap 도 갱신.
      // 같은 변경을 폴러가 한 번 더 잡지 않도록.
      if ((type === 'change' || type === 'input') && this._wqLastSnap) {
        this._wqLastSnap.set(rpaId, { value: curValue, label: '' });
      }

      // Phase G: 키 입력 이벤트 압축.
      //   브라우저는 글자마다 input 이벤트를 발화한다("ABC" → 3건). 같은 rpaId
      //   에 대해 연속된 input 은 마지막 값만 의미 있으므로 마지막 1건으로 합친다.
      //   replay 시간 단축 + 이벤트 부풀림 방지.
      if (type === 'input' && this.events.length > 0) {
        const last = this.events[this.events.length - 1];
        if (last.type === 'input' && last.rpaId === rpaId) {
          last.value = curValue;
          last.ts = Date.now();
          return;
        }
      }

      // Phase G: 동일 값 redundant change 드롭.
      //   blur 시점에 input 직후 같은 값으로 change 가 한 번 더 오는 패턴 흔함.
      //   이미 input 으로 캡처된 같은 rpaId+값이면 중복.
      if (type === 'change' && this.events.length > 0) {
        const last = this.events[this.events.length - 1];
        if (last.rpaId === rpaId && (last.value ?? '') === curValue
            && (last.type === 'input' || last.type === 'change')) {
          return;
        }
      }

      this.events.push({
        type,
        rpaId,
        value: curValue,
        // select 의 경우 selectedIndex 도 같이 (재생 시 안정성)
        selectedIndex: target.tagName === 'SELECT' ? target.selectedIndex : undefined,
        ts: Date.now(),
      });

      if (this.options.debug) {
        // Phase G: 진단용 — 캡처 즉시 콘솔에 표시 (paste 같은 케이스 추적)
        console.log('[macro-recorder] ', type, rpaId, JSON.stringify(curValue));
      }
    }

    // ─────────────────────────────────────────────
    // 재생
    // ─────────────────────────────────────────────
    async replay(events, opts = {}) {
      const speed = opts.speed ?? 1;
      const onProgress = opts.onProgress;
      const throwOnFail = opts.throwOnFail ?? false;
      const useApi = opts.useWebSquareApi ?? this.options.useWebSquareApi;
      const dispatchBlur = opts.dispatchBlurAfter ?? this.options.dispatchBlurAfter;
      const failed = [];
      let completedCount = 0;

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        try {
          onProgress?.(i, events.length, ev);

          const sel = `[data-rpa-id="${cssEscape(ev.rpaId)}"]`;
          let matches = document.querySelectorAll(sel);
          if (matches.length === 0) {
            await this._waitFor(ev.rpaId, 2000);
            matches = document.querySelectorAll(sel);
          }
          if (matches.length === 0) {
            const reason = 'element not found';
            failed.push({ index: i, rpaId: ev.rpaId, reason });
            if (throwOnFail) throw new Error(`replay failed: ${ev.rpaId}`);
            continue;
          }
          // 다중 매칭 — 잘못된 첫 매칭에 setValue 가 들어가면 깜빡임/오작동.
          // 어댑터의 rpaId 유일화 후에는 발생하지 않아야 하지만, 옛 매크로
          // 호환을 위해 콘솔 경고만 남기고 첫 매치로 진행.
          if (matches.length > 1) {
            console.warn(
              `[macro-recorder] multi-match (${matches.length}) for rpaId="${ev.rpaId}" — ` +
              `using first match. 매크로를 다시 녹화하면 유일한 rpaId 로 갱신됩니다.`,
              { matches: Array.from(matches).map((m) => m.id || '(no id)') }
            );
          }
          const el = matches[0];

          // ── 액션 디스패치 ──────────────────────────
          if (ev.type === 'click') {
            // Phase F: WebSquare 모달 확인/취소 등 일부 버튼은 mousedown/mouseup
            //          핸들러까지 같이 와야 동작한다. el.click() 만으로는
            //          click 이벤트만 발화되므로 풀 마우스 시퀀스를 추가.
            try {
              const Mouse = window.MouseEvent;
              if (Mouse) {
                el.dispatchEvent(new Mouse('mousedown', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Mouse('mouseup',   { bubbles: true, cancelable: true }));
              }
            } catch (_) { /* ignore */ }
            // 표준 click — onclick 핸들러 + click listener 모두 발화
            el.click();
          } else if (ev.type === 'dblclick') {
            // Phase J: 더블클릭 재생 — 브라우저 자연 시퀀스(클릭2회 + dblclick)
            //          를 모사. WebSquare 그리드의 위임 핸들러가 정상 트리거됨.
            try {
              const Mouse = window.MouseEvent;
              if (Mouse) {
                for (let n = 0; n < 2; n++) {
                  el.dispatchEvent(new Mouse('mousedown', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new Mouse('mouseup',   { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new Mouse('click',     { bubbles: true, cancelable: true }));
                }
                el.dispatchEvent(new Mouse('dblclick', { bubbles: true, cancelable: true }));
              } else {
                el.click(); el.click();
              }
            } catch (_) { /* ignore */ }
          } else if (ev.type === 'input' || ev.type === 'change') {
            // 보강 1: 웹스퀘어 컴포넌트 API 우선 사용
            let handled = useApi && trySetValueViaWebSquare(el, ev.value, ev.selectedIndex);

            // Phase C: 위젯 이벤트인데 외곽 div 의 setValue 가 실패하면
            //          내부 input 으로 폴백 (API 미주입 환경 대비)
            if (!handled && ev.widget === 'wq') {
              const innerInput = el.querySelector?.('input');
              if (innerInput) {
                innerInput.value = ev.value;
                innerInput.dispatchEvent(new Event('change', { bubbles: true }));
                handled = true;
              }
            }

            if (!handled) {
              // 폴백: 표준 DOM
              el.value = ev.value;
              if (typeof ev.selectedIndex === 'number' && el.tagName === 'SELECT') {
                el.selectedIndex = ev.selectedIndex;
              }
              el.dispatchEvent(new Event(ev.type, { bubbles: true }));
              // change 가 안 와있어도 input 변경 후 change 도 같이 발화 (안전망)
              if (ev.type === 'input') {
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }

            // 보강 3: blur dispatch — onkillfocus 핸들러 트리거
            if (dispatchBlur) {
              try {
                el.dispatchEvent(new Event('blur', { bubbles: true }));
              } catch (_) { /* ignore */ }
            }
          }

          completedCount++;
          // Phase F/J: 이벤트 종류별 sleep 차등.
          //   click/dblclick 은 비동기 후속(서브미션·모달 그리드 로딩 + 모달 닫기)
          //   가능성이 높아 기본 400ms. value 이벤트는 100ms 유지.
          //   사용자가 옵션으로 override 가능.
          const isClickish = ev.type === 'click' || ev.type === 'dblclick';
          const baseGap = isClickish
            ? (opts.clickGapMs ?? 400)
            : (opts.valueGapMs ?? 100);
          await sleep(baseGap / speed);
        } catch (err) {
          if (throwOnFail) throw err;
          failed.push({ index: i, rpaId: ev.rpaId, reason: String(err.message || err) });
        }
      }

      return {
        success: failed.length === 0,
        completedCount,
        totalCount: events.length,
        failed,
      };
    }

    _waitFor(rpaId, timeout) {
      return new Promise((resolve) => {
        const start = Date.now();
        const sel = `[data-rpa-id="${cssEscape(rpaId)}"]`;
        const check = () => {
          if (document.querySelector(sel)) resolve(true);
          else if (Date.now() - start > timeout) resolve(false);
          else requestAnimationFrame(check);
        };
        check();
      });
    }
  }

  // ─────────────────────────────────────────────
  // 보강 2: 웹스퀘어 컴포넌트 API 우선 사용
  // ─────────────────────────────────────────────
  // 솔로몬 컴포넌트는 자체 상태 관리가 있어 단순 value 설정으로는
  // 내부 상태가 갱신되지 않는다. $p.comp[fullId].setValue() 호출 시
  // 내부 상태와 핸들러 체인(onkillfocus 등)이 정상 발화한다.
  //
  // 우선순위:
  //   1. window.$p.comp[fullId].setValue(value)
  //   2. window.WebSquare.util.getComponentById(fullId).setValue(value)
  //   3. 실패 시 false 반환 → 호출측에서 표준 DOM 폴백
  function trySetValueViaWebSquare(el, value, selectedIndex) {
    if (!el || !el.id) return false;
    const fullId = el.id;
    try {
      const comp1 = window.$p && window.$p.comp && window.$p.comp[fullId];
      if (comp1 && typeof comp1.setValue === 'function') {
        comp1.setValue(value);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const util = window.WebSquare && window.WebSquare.util;
      if (util && typeof util.getComponentById === 'function') {
        const comp2 = util.getComponentById(fullId);
        if (comp2 && typeof comp2.setValue === 'function') {
          comp2.setValue(value);
          return true;
        }
      }
    } catch (_) { /* fall through */ }
    return false;
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // CSS.escape 폴백 — 한글/특수문자 안전한 셀렉터 생성
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/(["\\\[\]:.\s])/g, '\\$1');
  }

  // ─────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────
  if (typeof window !== 'undefined') window.MacroRecorder = MacroRecorder;
  if (typeof module !== 'undefined' && module.exports) module.exports = MacroRecorder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
