# 어시스턴트 개발자 가이드 (Developer Guide)

> **대상:** assistant.js / assistant-worker.js 를 수정하거나 호스트 시스템에 연동하는 개발자  
> **최종 업데이트:** 2026-04-01 | assistant.js 8,799 lines

---

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [loadAssistant() 전체 옵션](#2-loadassistant-전체-옵션)
3. [window.assistantBridge API](#3-windowassistantbridge-api)
4. [라이프사이클 훅 시스템](#4-라이프사이클-훅-시스템)
5. [IoC 주입 (stickyLayerSelectors)](#5-ioc-주입-stickyLayerSelectors)
6. [AssistantConfig 커스터마이징](#6-assistantconfig-커스터마이징)
7. [다국어 (i18n)](#7-다국어-i18n)
8. [Worker 통신 구조](#8-worker-통신-구조)
9. [minify / 배포 주의사항](#9-minify--배포-주의사항)
10. [자주 묻는 질문](#10-자주-묻는-질문)

---

## 1. 아키텍처 개요

```
┌─────────────────────────────────────────────────────┐
│  호스트 시스템 (WebSquare 등)                         │
│                                                     │
│  loadAssistant(config)  ─────────────────────────┐  │
│  window.assistantBridge.xxx()                    │  │
│  hooks: { onMemoAdded: () => ... }               │  │
└──────────────────────────────────────────────────┼──┘
                                                   │
                              ┌────────────────────▼──────────────────┐
                              │  assistant.js  (UI 스레드)             │
                              │                                       │
                              │  [Section 1] AssistantConfig          │
                              │             assistantBridge           │
                              │             _assistantConfig (IoC)    │
                              │  [Section 2] workerSend / _runHook    │
                              │  [Section 3] state / 상수              │
                              │  [Section 4] 유틸 / i18n               │
                              │  [Section 5] bootstrapAssistant       │
                              │             stickyLayer Observer      │
                              │  [Section 6] 메모 / 포스트잇            │
                              │  [Section 7] 클립보드 / 템플릿          │
                              │  [Section 8] 리마인더 / 시간 추적        │
                              │  [Section 9] 모달/설정                 │
                              └────────────────┬──────────────────────┘
                                               │ postMessage
                              ┌────────────────▼──────────────────────────┐
                              │  assistant-worker.js  (SharedWorker)      │
                              │  IndexedDB I/O · 리마인더 폴링 · 브로드캐스트 │
                              └───────────────────────────────────────────┘
```

### 핵심 원칙

- **어시스턴트는 독립적** — 호스트 DOM을 직접 조작하거나 외부 함수를 능동 호출하지 않습니다.
- **호스트가 어시스턴트를 제어** — `assistantBridge`, `postMessage`, `hooks` 를 통해서만 연동합니다.
- **Section 1만 수정** — `AssistantConfig`와 커스텀 설정은 Section 1에 집중되어 있습니다.

---

## 2. loadAssistant() 전체 옵션

`assistant-loader.js`가 제공하는 진입 함수입니다.

```javascript
loadAssistant({

  // ── 1. 기본 설정 ───────────────────────────────────────────────────────
  mountId:  "assistant-mount",   // 어시스턴트를 마운트할 DOM 요소 ID
  loginId:  "user_id",           // IndexedDB DB명 식별자 (미입력 시 공용 모드)
  locale:   "ko-kr",             // "ko-kr" | "en-us"

  // ── 2. 리소스 경로 ─────────────────────────────────────────────────────
  htmlPath:    "vendor/assistant/assistant-fragment.html",
  cssPath:     "vendor/assistant/assistant.css",
  jsPath:      "vendor/assistant/assistant.js",
  workerPath:  "vendor/assistant/assistant-worker.js",  // 미입력 시 jsPath 기준 자동 추론
  cssPaths: [                    // 추가 CSS (순서 보장)
    "vendor/quill/quill.bubble.css",
    "vendor/quill/quill-better-table.css",
  ],
  scriptPaths: [                 // 추가 JS (jsPath 로드 전에 순서대로 주입)
    "vendor/quill/quill.min.js",
    "vendor/quill/quill-better-table.min.js",
    "vendor/quill/quill-markdown-shortcuts.js",
    "vendor/purify/purify.min.js",
  ],

  // ── 3. 사용자 정보 (AES-256-GCM 암호화, HTTPS 전용) ─────────────────────
  getUserInfo: {
    userId:     "user_id",
    userEmpNo:  "2017806",
    userNm:     "홍길동",
    userEnglNm: "Hong Gildong",
  },

  // ── 4. sticky-layer 컨텍스트 감지 ──────────────────────────────────────
  // false 로 지정하면 옵저버 전체 비활성화
  stickyLayerSelectors: {
    // 폴백 방식 (클래스명 기반 탐색)
    windowContainerClass: "w2windowContainer_selectedNameLayer",
    pgIdClass:            "pg-id",
    targetDepth:          0,     // pgEl.parentElement 기준 이동 뎁스
    anchorDepth:          0,     // anchorEl 발견 후 이동 뎁스

    // IoC 주입 방식 (아래 항목을 제공하면 클래스 탐색 대체)
    resolveStickyTarget: (menuId) => document.querySelector(`#screen-${menuId}`),
    getObserverAnchor:   () => document.getElementById("sys-content"),

    // 컨텍스트 감지 함수 (공통)
    getMenuId: () => window.getActiveMenuId?.(),
    getAreaId: (menuId) => menuId.split("-")[0],
    getLocale: () => window.gcm?.gv_LANG_CD,  // 언어 변경 자동 감지 (선택)
  },

  // ── 5. 라이프사이클 훅 ─────────────────────────────────────────────────
  hooks: {
    // 전체 목록은 섹션 4 참조
    onPanelOpen:  () => {},
    onMemoAdded:  (memo) => {},
  },

});
```

---

## 3. window.assistantBridge API

호스트 시스템(same-origin)에서 어시스턴트를 직접 제어하는 공개 API입니다.  
uglify 후에도 `window` 프로퍼티이므로 이름이 보존됩니다.

| 메서드 | 설명 | 파라미터 |
|--------|------|----------|
| `open()` | 패널 열기 | — |
| `close()` | 패널 닫기 | — |
| `ping()` | 연결 확인 | → `"ok"` 반환 |
| `setArea(areaId)` | 업무 영역 전환 | `"UW"` \| `"CT"` \| `"CL"` \| `"AC"` \| `"PF"` \| `"ST"` \| `"FN"` |
| `setMenu(menuId)` | 화면(메뉴) 전환 | `"UW-001"` 등 화면 ID 문자열 |
| `setActiveTab(tabId)` | 패널 탭 전환 | `"memo"` \| `"clipboard"` \| `"template"` \| `"reminder"` \| `"dashboard"` |
| `pushText(payload)` | 텍스트 → 클립보드 추가 | `{ text: "..." }` |
| `pushGridData(payload)` | 그리드 데이터 → 클립보드 추가 | `{ title, columns, rows }` |
| `setLocale(locale)` | UI 언어 변경 | `"ko-kr"` \| `"en-us"` |
| `setupStickyLayerObserver(cfg)` | 옵저버 재설정 | config 객체 |
| `relocateStickyLayer()` | 포스트잇 레이어 위치 재동기화 | — |

### postMessage 브리지 (cross-frame / iframe)

```javascript
window.postMessage({ type: "assistant:open" }, "*");
window.postMessage({ type: "assistant:close" }, "*");
window.postMessage({ type: "assistant:setArea",   payload: "UW" }, "*");
window.postMessage({ type: "assistant:setMenu",   payload: "UW-001" }, "*");
window.postMessage({ type: "assistant:text",      payload: { text: "..." } }, "*");
window.postMessage({ type: "assistant:gridData",  payload: { title, rows, columns } }, "*");
window.postMessage({ type: "assistant:setLocale", payload: "en-us" }, "*");
```

---

## 4. 라이프사이클 훅 시스템

`loadAssistant({ hooks: { ... } })` 에 등록합니다.  
등록하지 않은 훅은 조용히 무시됩니다.

### 전체 훅 목록

#### 패널
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onPanelOpen` | 패널 열릴 때 | — |
| `onPanelClose` | 패널 닫힐 때 | — |

#### 메모
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onMemoAdd` | Worker에 메모 추가 전송 시 | `{ memoId, memoData }` |
| `onMemoAdded` | STATE_UPDATE로 저장 확인 후 | `memo` (DB 저장 객체 전체) |
| `onMemoDelete` | 메모 삭제 시 | `{ memoId }` |
| `onMemoEdit` | 메모 본문 저장 시 | `{ memoId, content, isRichText, meta? }` |
| `onMemoTitleSave` | 메모 제목 저장 시 | `{ memoId, title }` |
| `onMemoPin` | 고정/고정 해제 시 | `{ memoId }` |
| `onMemoLabel` | 화면 라벨 추가/제거 시 | `{ memoId, menuId, force? }` |
| `onTodoToggle` | 할일 체크 토글 시 | `{ memoId }` |
| `onMemoCopy` | 메모+포스트잇 복사 시 | `{ memoId, targetMenuId, targetAreaId, placement }` |

#### 포스트잇
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onStickyAdd` | 포스트잇 추가 시 | `{ memoId, placement, menuId }` |
| `onStickyRemove` | 포스트잇 제거 시 | `{ memoId, menuId }` |
| `onStickySave` | 포스트잇 일괄 저장 시 | `{ stickyNotes }` |

#### 클립보드
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onClipboardAdd` | 항목 추가 시 | `{ content, options }` |
| `onClipboardDelete` | 항목 삭제 시 | `{ itemId }` |
| `onClipboardRefresh` | 목록 갱신 시 | — |

#### 템플릿
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onTemplateAdd` | 추가 시 | `{ template }` |
| `onTemplateDelete` | 삭제 시 | `{ templateId }` |
| `onTemplateEdit` | 수정 시 | `{ templateId, title, content, pinned }` |
| `onTemplatePin` | 고정 토글 시 | `{ templateId }` |
| `onTemplateUse` | 사용 시 | `{ templateId }` |
| `onTemplateSuggest` | 자동완성 제안 수신 시 | Worker 제안 객체 |

#### 리마인더
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onReminderSet` | 리마인더 등록/수정 시 | `{ memoId, reminderStr, title, reminderRepeat }` |

> `reminderStr` 형식: `"2026-04-01T09:00"` (ISO 8601 로컬 시간)

#### 테마 / 설정
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onThemeChange` | 테마 변경 시 | `{ themeKey }` |
| `onDarkModeChange` | 다크모드 토글 시 | `{ isDark }` |
| `onSettingsSave` | 설정 저장 시 | `{ settings }` |
| `onAreaColorsSave` | 영역 색상 저장 시 | `{ areaId, colors }` |
| `onUiPrefsSave` | UI 설정 저장 시 | `{ panelWidth, ... }` \| `{ memoFilter }` |
| `onUserInfoSave` | 사용자 정보 저장 시 | `{ userInfo }` (암호화 문자열) |

#### 내비게이션
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onContextChange` | 화면(메뉴/영역) 전환 시 | `{ menuId?, areaId? }` |
| `onTabActive` | 브라우저 탭 포커스 변경 시 | `{ isActive }` |

#### 데이터 관리
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onDataExport` | 내보내기 요청 시 | — |
| `onExportReady` | 내보내기 파일 준비 완료 시 | JSON 문자열 |
| `onDataImport` | 가져오기 시 | `{ importedData }` |
| `onDataClear` | 전체 삭제 시 | — |
| `onDataCleanup` | 자동 정리 실행 시 | `{ settings, silent?, reason? }` |

#### 상태 / 공통
| 훅 | 발화 시점 | payload |
|----|-----------|---------|
| `onStateUpdate` | 모든 STATE_UPDATE 처리 후 | `state` (전체 상태 객체) |
| `onToast` | 토스트 메시지 표시 시 | `{ messageKey?, params?, message? }` |
| `onAreaTimeRecord` | 업무 영역 시간 기록 시 | `{ areaId, elapsedMs }` |
| `onGuideSeen` | 온보딩 가이드 완료 시 | — |

---

## 5. IoC 주입 (stickyLayerSelectors)

포스트잇 타겟 컨테이너 탐색을 호스트가 직접 제어할 수 있습니다.

### 기본 방식 (클래스명 탐색)

```
DOM에서 .windowContainerClass 요소 찾기
  └─ anchorDepth 만큼 이동 (기본 0)
     └─ 내부에서 .pgIdClass 텍스트 === selectedMenu 찾기
        └─ parentElement 기준 targetDepth 만큼 이동
           └─ 포스트잇 타겟 컨테이너 반환
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `windowContainerClass` | `"w2windowContainer_selectedNameLayer"` | MutationObserver 감시 대상 클래스 |
| `pgIdClass` | `"pg-id"` | 화면 ID를 담는 hidden 요소 클래스 |
| `targetDepth` | `0` | pgEl.parentElement 기준 이동 (`+n`=내려감, `-n`=올라감) |
| `anchorDepth` | `0` | anchorEl 발견 후 이동 (`+n`=firstElementChild, `-n`=parentElement) |

### IoC 주입 방식

```javascript
stickyLayerSelectors: {
  // 아래 함수 제공 시 클래스 탐색 로직을 완전히 대체
  resolveStickyTarget: (menuId) => {
    return document.querySelector(`#screen-${menuId}`);
  },
  getObserverAnchor: () => {
    return document.getElementById("main-content");
  },
}
```

---

## 6. AssistantConfig 커스터마이징

`assistant.js` Section 1의 `AssistantConfig` 객체만 수정합니다.  
`Object.freeze` 처리되어 있어 런타임 변경은 불가합니다.

```javascript
const AssistantConfig = {
  ui: {
    panelMinWidthCollapsed:  360,   // 접힌 패널 최소 너비 (px)
    panelMinWidthExpanded:   640,   // 펼친 패널 최소 너비 (px)
    stickyNoteDefaultWidth:  220,   // 포스트잇 기본 너비 (px)
    stickyNoteDefaultHeight: 150,   // 포스트잇 기본 높이 (px)
    stickyNoteMinSize:       150,   // 포스트잇 최소 크기 (px)
    stickyNoteMargin:         16,   // 포스트잇 배치 여백 (px)
  },
  i18n: {
    defaultLocale:  "ko-kr",
    fallbackLocale: "en",
  },
  advanced: {
    reminderCheckInterval: 5000,    // 리마인더 폴링 주기 (ms)
    startupCleanupDelay:   5000,    // 초기 자동정리 지연 (ms)
    debugLogs: false,               // Worker 통신 로거 (개발 시 true)
  },
};
```

### 히든 UI 제어

특정 설정 항목의 노출 여부를 런타임에 제어합니다.

```javascript
// 개별 항목 제어
toggleAssistantHiddenUI("theme", true);      // 테마 버튼 노출
toggleAssistantHiddenUI("debugLog", false);  // 디버그 로그 숨김

// 전체 일괄 제어
showAllAssistantHiddenUI(true);   // 모든 숨김 항목 노출
showAllAssistantHiddenUI(false);  // 모든 항목 숨김
```

| 키 | 설명 |
|----|------|
| `areaColor` | 영역별 색상 설정 |
| `timeInsight` | 업무 시간 인사이트 |
| `markdown` | 마크다운 편집 기능 |
| `debugLog` | Worker 통신 디버그 로그 |
| `autoNav` | 자동 내비게이션 |
| `theme` | 테마 변경 버튼 |
| `darkMode` | 다크모드 토글 |
| `sideTabs` | 사이드 탭 레이아웃 |
| `shortcutManual` | 단축키 도움말 |
| `featureSectionTitle` | 설정 섹션 제목 |

---

## 7. 다국어 (i18n)

### 파일 위치

```
vendor/assistant/i18n/
├── ko-kr.json
└── en-us.json
```

### 번역 키 추가

1. `ko-kr.json` / `en-us.json` 에 동일한 키 추가
2. `assistant.js`에서 `t("your.key")` 또는 `t("your.key", { param: value })` 로 사용

```json
// ko-kr.json
{
  "memo": {
    "newTitle": "새 메모"
  }
}
```

```javascript
t("memo.newTitle")             // → "새 메모"
t("memo.count", { n: 3 })     // → 파라미터 보간 (JSON에서 {{n}} 사용)
```

### 런타임 언어 변경

```javascript
assistantBridge.setLocale("en-us");

// 또는 자동 감지 (옵저버 사용)
stickyLayerSelectors: {
  getLocale: () => window.gcm?.gv_LANG_CD,  // 변경 감지 시 자동 적용
}
```

---

## 8. Worker 통신 구조

### 메시지 흐름

```
UI (assistant.js)
  workerSend(type, payload)
        │
        ▼
  SharedWorker (assistant-worker.js)
  → IndexedDB 작업 수행
  → 모든 연결된 포트에 STATE_UPDATE 브로드캐스트
        │
        ▼
  dispatchWorkerMessage(type, payload)
  → handleStateUpdate(state)
  → _runHook(hookName, payload)   ← 훅 자동 발화
```

### _WORKER_HOOK_MAP

`workerSend(type, payload)` 호출 시 자동으로 매핑된 훅이 발화됩니다.

```javascript
const _WORKER_HOOK_MAP = {
  ADD_MEMO:           "onMemoAdd",
  DELETE_MEMO:        "onMemoDelete",
  SAVE_INLINE_EDIT:   "onMemoEdit",
  // ... 37개 매핑
};
// workerSend 내부에서 자동 실행:
// if (_hookName) _runHook(_hookName, payload);
```

### 안전한 훅 실행

```javascript
function _runHook(name, ...args) {
  try {
    _assistantConfig?.hooks?.[name]?.(...args);
  } catch (e) {
    assiConsole.warn(`[Assistant] hook '${name}' 오류:`, e);
  }
}
```

훅 콜백에서 예외가 발생해도 어시스턴트 동작에 영향 없습니다.

---

## 9. minify / 배포 주의사항

### 안전한 항목 (이름 보존됨)

- `window.assistantBridge.*` — window 프로퍼티
- `window.bootstrapAssistant` — window 프로퍼티
- `window.toggleAssistantHiddenUI` — window 프로퍼티
- `window.showAllAssistantHiddenUI` — window 프로퍼티
- `window.loadAssistant` — window 프로퍼티 (assistant-loader.js)

### 주의 항목

| 상황 | 대처 방법 |
|------|-----------|
| 훅 예시에서 `setActiveTab()` 직접 호출 | `assistantBridge.setActiveTab()` 으로 교체 (이미 적용됨) |
| Terser property mangling 활성화 | **반드시 비활성화** — CSS 클래스명 문자열 깨짐 |
| `assistant-worker.js` | UI와 별도 파일로 따로 minify 필요 |

### 권장 Terser 옵션

```javascript
// terser.config.js
{
  mangle: {
    properties: false,  // 프로퍼티 망글링 비활성화 (필수)
  },
  compress: {
    drop_console: true,
  }
}
```

### 배포 파일 목록

```
vendor/
├── assistant-loader.js        (minify 가능)
└── assistant/
    ├── assistant.js           (minify 가능, property mangling 제외)
    ├── assistant.css          (minify 가능)
    ├── assistant-fragment.html
    ├── assistant-worker.js    (별도 minify)
    └── i18n/
        ├── ko-kr.json
        └── en-us.json
```

---

## 10. 자주 묻는 질문

**Q. 포스트잇이 간혹 화면 밖에 생성됩니다.**  
A. `sticky-layer`가 아직 렌더링되지 않은 상태에서 좌표를 계산하면 발생할 수 있습니다. `getDefaultStickyPlacement()`가 `layerRect.width > 0` 조건으로 방어하며, Y 좌표가 레이어 높이를 초과하면 `baseY`로 되돌립니다.

**Q. SharedWorker 연결이 안 됩니다.**  
A. `file://` 프로토콜에서는 SharedWorker가 동작하지 않습니다. Live Server 또는 HTTP 서버를 통해 실행하세요.

**Q. AES-256-GCM 암호화가 동작하지 않습니다.**  
A. Web Crypto API는 HTTPS 또는 `localhost` 환경에서만 사용 가능합니다. `getUserInfo` 옵션은 HTTPS 배포 환경에서만 제공하세요.

**Q. 다크모드 상태가 페이지 새로고침 후 초기화됩니다.**  
A. IndexedDB `settings` 스토어에 저장됩니다. 같은 브라우저 + 같은 `loginId`여야 복원됩니다.

**Q. 훅 콜백에서 에러가 발생하면 어시스턴트가 멈춥니까?**  
A. 아닙니다. `_runHook()`이 try/catch로 감싸므로 에러는 콘솔 경고로만 출력되고 어시스턴트는 정상 동작합니다.

**Q. `onContextChange` 훅이 화면 전환마다 두 번 발화됩니다.**  
A. `setArea()` + `setMenu()` 를 별도로 호출하면 각각 발화됩니다. 두 값을 함께 변경할 때는 `selectMenu(menuId)` (내부 함수, areaId 자동 감지) 또는 `assistantBridge.setMenu(menuId)` + `stickyLayerSelectors.getAreaId` 조합을 사용하세요.
