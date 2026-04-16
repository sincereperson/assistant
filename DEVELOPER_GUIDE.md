# 어시스턴트 개발자 가이드 (Developer Guide)

> **대상:** assistant.js / assistant-worker.js 를 수정하거나 호스트 시스템에 연동하는 개발자  
> **최종 업데이트:** 2026-04-16 | assistant.js 9,156 lines

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
11. [훅 전체 참조 (Quick Reference)](#11-훅-전체-참조-quick-reference)
12. [훅 사용 예시](#12-훅-사용-예시)
13. [URL 파라미터 온/오프 제어](#13-url-파라미터-온오프-제어)
14. [차단 목록 (사번 / 부서)](#14-차단-목록-사번--부서)
15. [Boot Hang Watchdog](#15-boot-hang-watchdog)

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
  mountId:          "assistant-mount",      // 어시스턴트를 마운트할 DOM 요소 ID
  mountContainerId: "mf_VFrames_Root",      // 마운트 부모 컨테이너 ID (기본: "mf_VFrames_Root")
  allowBodyFallback: false,                  // mountContainerId 못 찾을 때 body에 폴백 허용
  loginId:  "user_id",                      // IndexedDB DB명 식별자 (미입력 시 공용 모드)
  locale:   "ko-kr",                        // "ko-kr" | "en-us"

  // ── 1-1. 차단 목록 (로드 자체 스킵) ───────────────────────────────────
  // 아래 값이 차단 목록에 포함되면 loadAssistant 자체가 실행되지 않음
  deptCd:    "240070",  // 사용자 부서 코드 (BLOCKED_DEPT_CDS 배열과 비교)
  uprDeptCd: "240000",  // 상위 부서 코드 (BLOCKED_UPR_DEPT_CDS 배열과 비교)
  // ※ 사번 차단은 loginId와 loader 내부 BLOCKED_LOGIN_IDS 배열로 처리

  // ── 1-2. 초기 테마 / 모드 (flash 없이 첫 렌더부터 즉시 반영) ───────────
  initialTheme:         "earthBrown",  // 초기 테마 키 (설정 없으면 "classic")
  initialDarkMode:      false,         // 초기 다크모드 (true/false)
  initialAreaColorMode: false,         // 초기 업무영역 컬러모드
  // ※ DB에 저장된 값이 있으면 STATE_UPDATE 후 덮어써짐 — 첫 렌더 flash 방지 목적

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
| `setTheme(themeKey)` | 테마 즉시 변경 | `"classic"` \| `"earthBrown"` \| `"oceanGreen"` \| `"lightBeige"` |
| `setDarkMode(isDark)` | 다크모드 즉시 전환 | `true` \| `false` |
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
| `onClipboardDelete` | 항목 삭제 시 | `{ itemId }` || `onClipboardPin` | 항목 고정 토글 시 | `{ itemId }` || `onClipboardRefresh` | 목록 갱신 시 | — |

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
| `onDarkModeChange` | 다크모드 토글 시 | `{ isDarkMode }` |
| `onAreaColorModeChange` | 업무영역 컬러모드 토글 시 | `{ areaColorMode }` |
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
| `areaColorMode` | 업무영역 컬러모드 버튼 |
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

---

## 11. 훅 전체 참조 (Quick Reference)

`loadAssistant()` 의 `hooks` 옵션에 그대로 복사해서 사용할 수 있는 전체 훅 목록입니다.

```javascript
loadAssistant({
  hooks: {

    // ── 패널 ────────────────────────────────────────────────────────────
    onPanelOpen:  () => { console.log("call onPanelOpen") },           // 인자 없음
    onPanelClose: () => { console.log("call onPanelClose") },          // 인자 없음

    // ── 메모 ────────────────────────────────────────────────────────────
    onMemoAdd:       ({ memoId, memoData }) => { console.log("call onMemoAdd", memoId, memoData) },
    //   memoData: { title, content, areaId, menuId, date, isRichText, ... }
    onMemoAdded:     (memo) => { console.log("call onMemoAdded", memo) },
    //   memo: DB 저장 확인된 메모 객체 (id, title, content, areaId, menuId, date, ...)
    onMemoDelete:    ({ memoId }) => { console.log("call onMemoDelete", memoId) },
    onMemoEdit:      ({ memoId, content, isRichText, meta }) => { console.log("call onMemoEdit", memoId, content, isRichText, meta) },
    //   meta: { tags }
    onMemoTitleSave: ({ memoId, title }) => { console.log("call onMemoTitleSave", memoId, title) },
    onMemoPin:       ({ memoId }) => { console.log("call onMemoPin", memoId) },
    onMemoLabel:     ({ memoId, menuId, force }) => { console.log("call onMemoLabel", memoId, menuId, force) },
    onTodoToggle:    ({ memoId }) => { console.log("call onTodoToggle", memoId) },
    onMemoCopy:      ({ memoId, targetMenuId, targetAreaId, placement }) => { console.log("call onMemoCopy", memoId, targetMenuId, targetAreaId, placement) },

    // ── 포스트잇 ──────────────────────────────────────────────────────
    onStickyAdd:    ({ memoId, placement, menuId }) => { console.log("call onStickyAdd", memoId, placement, menuId) },
    //   placement: "top-left" | "top-right" | "bottom-left" | "bottom-right"
    onStickyRemove: ({ memoId, menuId }) => { console.log("call onStickyRemove", memoId, menuId) },
    onStickySave:   ({ stickyNotes }) => { console.log("call onStickySave", stickyNotes) },
    //   stickyNotes: 현재 활성 포스트잇 배열

    // ── 클립보드 ──────────────────────────────────────────────────────
    onClipboardAdd:     ({ content, options }) => { console.log("call onClipboardAdd", content, options) },
    onClipboardDelete:  ({ itemId }) => { console.log("call onClipboardDelete", itemId) },
    onClipboardPin:     ({ itemId }) => { console.log("call onClipboardPin", itemId) },
    onClipboardRefresh: () => {},                                      // 인자 없음

    // ── 템플릿 ────────────────────────────────────────────────────────
    onTemplateAdd:     ({ template }) => { console.log("call onTemplateAdd", template) },
    //   template: { title, content, pinned, ... }
    onTemplateDelete:  ({ templateId }) => { console.log("call onTemplateDelete", templateId) },
    onTemplateEdit:    ({ templateId, title, content, pinned }) => { console.log("call onTemplateEdit", templateId, title, content, pinned) },
    onTemplatePin:     ({ templateId }) => { console.log("call onTemplatePin", templateId) },
    onTemplateUse:     ({ templateId }) => { console.log("call onTemplateUse", templateId) },
    onTemplateSuggest: (payload) => { console.log("call onTemplateSuggest", payload) },  // Worker 자동완성 제안 객체

    // ── 리마인더 ──────────────────────────────────────────────────────
    onReminderSet: ({ memoId, reminderStr, title, reminderRepeat }) => {
      console.log("call onReminderSet", memoId, reminderStr, title, reminderRepeat)
    },
    //   reminderStr: "2026-04-01T09:00" (ISO 8601 로컬 시간)
    //   reminderRepeat: boolean

    // ── 테마 / 설정 ───────────────────────────────────────────────────
    onThemeChange:         ({ themeKey }) => { console.log("call onThemeChange", themeKey) },
    onDarkModeChange:      ({ isDarkMode }) => { console.log("call onDarkModeChange", isDarkMode) },
    onAreaColorModeChange: ({ areaColorMode }) => { console.log("call onAreaColorModeChange", areaColorMode) },
    onSettingsSave:        ({ settings }) => { console.log("call onSettingsSave", settings) },
    //   settings: 전체 설정 객체
    onAreaColorsSave:      ({ areaId, colors }) => { console.log("call onAreaColorsSave", areaId, colors) },
    onUiPrefsSave:         ({ panelWidth, panelWidthCollapsed, panelWidthExpanded, panelHeight }) => {
      console.log("call onUiPrefsSave", panelWidth, panelWidthCollapsed, panelWidthExpanded, panelHeight)
    },
    onUserInfoSave:        ({ userInfo }) => { console.log("call onUserInfoSave", userInfo) },
    //   userInfo: AES-256-GCM 암호화된 문자열

    // ── 내비게이션 ────────────────────────────────────────────────────
    onContextChange: ({ menuId, areaId }) => { console.log("call onContextChange", menuId, areaId) },
    //   menuId: 변경된 화면 ID (예: "UW-001"). 변경 시에만 포함
    //   areaId: 영역 변경 시에만 포함
    onTabActive: ({ isActive }) => { console.log("call onTabActive", isActive) },
    //   isActive: 브라우저 탭 포커스 여부 (Page Visibility API)

    // ── 데이터 관리 ───────────────────────────────────────────────────
    onDataExport:  () => { console.log("call onDataExport") },         // 인자 없음
    onExportReady: (data) => { console.log("call onExportReady", data) },
    //   data: JSON 문자열 (Worker→UI 파일 준비 완료)
    onDataImport:  ({ importedData }) => { console.log("call onDataImport", importedData) },
    onDataClear:   () => { console.log("call onDataClear") },          // 인자 없음
    onDataCleanup: ({ settings, silent, reason }) => { console.log("call onDataCleanup", settings, silent, reason) },

    // ── 상태 / 공통 ───────────────────────────────────────────────────
    // onStateUpdate: (state) => { console.log("call onStateUpdate", state) },
    //   모든 STATE_UPDATE 처리 후. state: 전체 상태 객체 (디버그용, 고빈도 발화)
    // onToast: ({ messageKey, params, message }) => { console.log("call onToast", messageKey, params, message) },
    //   messageKey 우선. 없으면 message 문자열 사용
    onAreaTimeRecord: ({ areaId, elapsedMs }) => { console.log("call onAreaTimeRecord", areaId, elapsedMs) },
    onGuideSeen:      () => { console.log("call onGuideSeen") },       // 인자 없음

  },
});
```

---

## 12. 훅 사용 예시

### 예시 1 — 리마인더 설정 완료 → 대시보드 탭 자동 이동

```javascript
onReminderSet: (payload) => {
  // payload: { memoId, reminderStr, title, reminderRepeat }
  console.log(`[훅] 리마인더 등록 → ${payload.title} (${payload.reminderStr})`);
  assistantBridge.open();
  assistantBridge.setActiveTab("dashboard");
},
```

### 예시 2 — 내보내기 파일 준비 → 자동 다운로드

```javascript
onExportReady: (data) => {
  // data: JSON 문자열
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "backup.json" });
  a.click();
  URL.revokeObjectURL(url);
},
```

### 예시 3 — 테마 변경 → 호스트 페이지 `data` 속성 동기화

```javascript
onThemeChange: ({ themeKey }) => {
  // 어시스턴트 테마를 호스트 루트 속성에 반영 (CSS 변수 연동 등)
  document.documentElement.dataset.assistantTheme = themeKey;
},
```

### 예시 4 — 토스트 메시지 감지 → 접근성 로그

```javascript
onToast: ({ message }) => {
  if (message) console.info(`[Assistant] ${message}`);
},
```

### 예시 5 — 클립보드 항목 추가 → 패널 열기 + 탭 이동

```javascript
onClipboardAdd: () => {
  assistantBridge.open();
  assistantBridge.setActiveTab("clipboard");
},
```

### 예시 6 — 설정 저장 → 서버에 사용자 설정 동기화

```javascript
onSettingsSave: (payload) => {
  fetch("/api/user-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
},
```

---

## 13. URL 파라미터 온/오프 제어

현업 사용자가 개발자도구 없이 **주소창 URL만으로** 어시스턴트 자체를 켜고 끌 수 있는 기능입니다.  
`assistant-loader.js`의 `loadAssistant()` 진입 시점에 URL을 파싱하여 처리합니다.

### 지원 파라미터

| 파라미터 | 값 | 동작 |
|----------|----|------|
| `?assistant=off` | `off` \| `0` \| `false` | 어시스턴트 로드 완전 중단. 이미 마운트된 경우 DOM 제거 |
| `?assistant=on` | `on` \| `1` \| `true` | 기본 동작과 동일 (정상 로드) |
| `?assi=off` | 동일 | `assistant` 파라미터의 단축 별칭 |
| 파라미터 없음 | — | 기본 동작 (정상 로드) |

### 사용 예시

```
// 어시스턴트 끄기
http://erp.company.com/main.html?assistant=off

// 어시스턴트 켜기 (기본과 동일)
http://erp.company.com/main.html?assistant=on

// 단축 별칭
http://erp.company.com/main.html?assi=off
```

> ⚠ **주의:** `off` 상태로 접속하면 `window.assistantInitialized = false`로 초기화됩니다.  
> 새로고침 또는 `?assistant=on` URL로 재접속해야 다시 활성화됩니다.

---

## 14. 차단 목록 (사번 / 부서)

특정 사번·부서의 사용자에게 어시스턴트가 로드되지 않도록 `assistant-loader.js` 내부 배열로 관리합니다.

### 차단 방식

| 옵션 | 차단 배열 | 설명 |
|------|-----------|------|
| `loginId` | `BLOCKED_LOGIN_IDS` | 사번 단위 차단 (대소문자 무시) |
| `deptCd` | `BLOCKED_DEPT_CDS` | 부서 코드 단위 차단 |
| `uprDeptCd` | `BLOCKED_UPR_DEPT_CDS` | 상위 부서 코드 단위 차단 |

### 배열 위치 및 수정 방법

`assistant-loader.js` 의 `loadAssistant()` 함수 내부 최상단에서 관리합니다.

```javascript
// 사번 차단 (loadAssistant 내부)
const BLOCKED_LOGIN_IDS = [
  'O402321', 'O402322',  // 추가/삭제
];

// 부서 차단
const BLOCKED_DEPT_CDS = [
  // '240070',  // 예: IT기획파트
];

// 상위 부서 차단
const BLOCKED_UPR_DEPT_CDS = [
  // '240000',  // 예: 정보기술팀 전체
];
```

### 호스트에서 전달하는 방법

```javascript
loadAssistant({
  loginId:   gcm.gv_USER_ID,          // 사번 차단 대상
  deptCd:    gcm.gv_DEPT_CD,          // 부서 차단 대상
  uprDeptCd: gcm.gv_UPR_DEPT_CD,      // 상위 부서 차단 대상
  // ...
});
```

> 차단된 사용자는 콘솔에 `[assistant-loader] 차단된 사번입니다.` 로그만 남기고 로드가 중단됩니다.

---

## 15. Boot Hang Watchdog

WebSquare 등 내부 시스템의 초기화(`init()`)가 API 응답 지연으로 hang 걸려 `loadAssistant()`가 끝내 호출되지 않는 상황을 감지하는 안전망입니다.

### 동작 흐름

```
<script> 로드 즉시 watchdog 타이머 시작
    │
    ├─ [정상] timeout 내에 loadAssistant() 호출 → 타이머 취소
    │
    └─ [hang] timeout 경과 → 화면 우하단에 경고 배지 표시
                              배지 클릭 → 모달 표시 → 새로고침 버튼
```

### 설정 방법

`assistant-loader.js` 로드 직후, WebSquare `<script>` **이전에** 호출합니다.

```html
<script src="vendor/assistant-loader.js"></script>
<script>
  // WebSquare bootloader.js 보다 먼저 watchdog 등록
  loadAssistant.watchdog({
    timeout:  20000,                          // hang 판단 기준 시간 (ms, 기본 60000)
    watchUrl: "/websquare5/bootloader.js",   // HEAD 프로브 URL (선택)
    htmlPath: "vendor/assistant/assistant-fragment.html",  // 배지 아이콘 경로 추론용
  });
</script>
<script src="/websquare5/websquare.js"></script>  <!-- 내부 시스템 -->
```

### watchdog 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `timeout` | `60000` | hang 판단 기준 시간 (ms) |
| `watchUrl` | — | HEAD 요청으로 응답 여부를 별도 프로브. 네트워크 장애도 즉시 감지 |
| `htmlPath` | — | 배지 아이콘 SVG 경로 추론용 (`assistant-fragment.html` 경로 전달) |

> **두 가지 감지 방식이 병행 동작합니다:**  
> - **[A] 타이머 감시** — `timeout` 내 `loadAssistant()` 미호출 시 배지 표시  
> - **[B] fetch 프로브** — `watchUrl` 응답 실패(네트워크 장애) 시 즉시 배지 표시