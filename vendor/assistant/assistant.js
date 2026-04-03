// ============================================================================
// 📦 assistant.js — 솔로몬 어시스턴트 프론트엔드 코어
// ============================================================================
// 섹션 구성 (Top → Bottom)
//   [Section 1] Configuration & Customization  🛠️  AssistantConfig + window.assistantBridge
//   [Section 2] Worker Communication           🔌
//   [Section 3] Global State & Constants       📦
//   [Section 4] Core Utilities                 🔧
//   [Section 5] Core Layout & Lifecycle        🏗️
//   [Section 6] Feature: Memo & Sticky Notes   📝
//   [Section 7] Feature: Clipboard & Templates 📋
//   [Section 8] Reminders · Notifications ·    🔔
//               Time Tracking
//   [Section 9] Modals & Settings              🪟
// ⚠️  Section 2 이하는 시스템 코어 영역입니다. 수정 시 장애가 발생할 수 있습니다.
// ============================================================================

// ============================================================================
// 🛠️ [Section 1] CONFIGURATION & CUSTOMIZATION  커스텀 영역 (자유롭게 수정 가능)
// ============================================================================
// 이 영역만 수정하여 테마, 다국어, UI 크기 등 기본 동작을 안전하게 변경하세요.
// Section 3 이하의 코어 로직은 직접 수정하지 마세요.
// ============================================================================

/**
 * AssistantConfig - 어시스턴트 전역 설정 객체
 * 코드 내 하드코딩된 매직 넘버들의 단일 진실 원천(Single Source of Truth)
 */
const AssistantConfig = {
  /** 패널 / 포스트잇 UI 크기 */
  ui: {
    panelMinWidthCollapsed:  360,  // 접힌 상태 패널 최소 너비 (px)
    panelMinWidthExpanded:   640,  // 펼친 상태 패널 최소 너비 (px)
    stickyNoteDefaultWidth:  220,  // 포스트잇 기본 너비 (px)
    stickyNoteDefaultHeight: 150,  // 포스트잇 기본 높이 (px)
    stickyNoteMinSize:       150,  // 포스트잇 최소 너비/높이 (px)
    stickyNoteMargin:         16,  // 포스트잇 배치 여백 (px)
  },
  /** 다국어 */
  i18n: {
    defaultLocale:  "ko-kr",
    fallbackLocale: "en",
  },
  /** 고급 설정 */
  advanced: {
    reminderCheckInterval: 5000, // 리마인더 폴링 주기 (ms)
    startupCleanupDelay:   5000, // 초기 자동정리 실행 지연 (ms)
    debugLogs: false,            // 통신 로거 활성화 여부 (개발 시에만 true)
  },
};
Object.freeze(AssistantConfig.ui);
Object.freeze(AssistantConfig.i18n);
Object.freeze(AssistantConfig.advanced);
Object.freeze(AssistantConfig);

// ── window.assistantBridge ────────────────────────────────────────────────────
// 호스트 시스템(웹스퀘어 등)이 직접 호출하는 same-origin 브리지 API.
// 참조하는 함수들은 function 선언으로 호이스팅되므로 파일 최상단 배치가 안전합니다.
window.assistantBridge = {
  pushGridData:             (payload) => ingestExternalContent(payload),
  pushText:                 (payload) => ingestExternalContent(payload),
  setArea:                  (areaId)  => setSelectedArea(areaId),
  setMenu:                  (menu)    => selectMenu(menu),
  setActiveTab:             (tabId)   => setActiveTab(tabId),
  open:  () => { state.assistantOpen = true;  renderAssistant(); },
  close: () => { state.assistantOpen = false; renderAssistant(); },
  ping:  () => "ok",
  setupStickyLayerObserver: (cfg)     => setupStickyLayerObserver(cfg || {}),
  relocateStickyLayer:      ()        => relocateStickyLayer(),
  setLocale:                (locale)  => setLocale(locale),
  setTheme:                 (themeKey) => setTheme(themeKey),
  setDarkMode:              (isDark)   => setDarkMode(isDark),
};

// postMessage 기반 브리지 (cross-frame / iframe 대응)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;
  switch (data.type) {
    case "assistant:gridData":
    case "assistant:text":    ingestExternalContent(data.payload); break;
    case "assistant:setArea": setSelectedArea(data.payload); break;
    case "assistant:setMenu": selectMenu(data.payload); break;
    case "assistant:open":    state.assistantOpen = true;  renderAssistant(); break;
    case "assistant:close":   state.assistantOpen = false; renderAssistant(); break;
    case "assistant:setLocale": setLocale(data.payload); break;
    default: break;
  }
});

// ============================================================================
// ⚠️ [CORE AREA] 시스템 코어 로직 — 수정 시 시스템 장애가 발생할 수 있습니다.
// SharedWorker 통신, 전역 State 관리, DOM 렌더링 사이클이 포함됩니다.
// ============================================================================

/**
 * 어시스턴트 전용 로거 (전역 console Monkey Patching 방지)
 * state.settings.debugLogs 값에 따라 출력 여부를 결정합니다.
 * error는 크리티컬 이슈 파악을 위해 설정과 무관하게 항상 출력합니다.
 */
// var 선언: state(let) TDZ 진입 전에도 안전하게 참조 가능
var _assiDebugReady = false;
const assiConsole = {
  log:   (...args) => { if (_assiDebugReady && state?.settings?.debugLogs) console.log(...args); },
  info:  (...args) => { if (_assiDebugReady && state?.settings?.debugLogs) console.info(...args); },
  debug: (...args) => { if (_assiDebugReady && state?.settings?.debugLogs) console.debug(...args); },
  warn:  (...args) => { if (_assiDebugReady && state?.settings?.debugLogs) console.warn(...args); },
  error: (...args) => { console.error(...args); },
};


if (typeof Quill !== "undefined") {
  assiConsole.log("✅ Quill 라이브러리 로드 성공!");
} else {
  alert("❌ Quill 라이브러리를 찾을 수 없습니다. 경로를 확인해주세요.");
}

// ============================================================================
// [Section 2] WORKER COMMUNICATION  🔌 SharedWorker 통신 브리지
// ============================================================================
// connectToWorker, workerSend, dispatchWorkerMessage, handleStateUpdate
// UserInfo 암호화/복호화 (AES-GCM)
// NOTE: AssistantDB 클래스 및 모든 DB 직접 접근은
//       assistant-worker.js (Shared Worker)로 완전 이전됩니다.
//       이 파일은 UI 렌더링 및 Worker 메시지 송수신만 담당합니다.

/** @type {MessagePort|null} */
let workerPort = null;

/**
 * Shared Worker에 메시지를 전송합니다.
 * Worker가 연결되지 않은 경우 경고를 출력합니다.
 * @param {string} type - 메시지 타입 (HANDLERS 키)
 * @param {Object} [payload] - 전송할 데이터
 */

/**
 * Worker 메시지 타입 → 훅 이름 매핑 테이블
 * bootstrapAssistant({ hooks: { onMemoAdd: (payload) => ... } }) 형태로 등록
 * 훅이 등록되지 않은 타입은 조용히 무시됩니다.
 */
const _WORKER_HOOK_MAP = {
  // ── 메모 ──────────────────────────────────────────────────────────────────
  ADD_MEMO:                 "onMemoAdd",
  DELETE_MEMO:              "onMemoDelete",
  SAVE_MEMO_TITLE:          "onMemoTitleSave",
  SAVE_INLINE_EDIT:         "onMemoEdit",
  TOGGLE_PIN:               "onMemoPin",
  TOGGLE_LABEL:             "onMemoLabel",
  TOGGLE_TODO:              "onTodoToggle",
  COPY_MEMO_AND_STICKY:     "onMemoCopy",
  // ── 포스트잇 ──────────────────────────────────────────────────────────────
  ADD_STICKY_NOTE:          "onStickyAdd",
  REMOVE_STICKY_NOTE:       "onStickyRemove",
  SAVE_STICKY_NOTES:        "onStickySave",
  // ── 클립보드 ──────────────────────────────────────────────────────────────
  ADD_CLIPBOARD:            "onClipboardAdd",
  DELETE_CLIPBOARD:         "onClipboardDelete",
  REFRESH_CLIPBOARD:        "onClipboardRefresh",
  // ── 템플릿 ────────────────────────────────────────────────────────────────
  ADD_TEMPLATE:             "onTemplateAdd",
  DELETE_TEMPLATE:          "onTemplateDelete",
  EDIT_TEMPLATE:            "onTemplateEdit",
  TOGGLE_TEMPLATE_PIN:      "onTemplatePin",
  USE_TEMPLATE:             "onTemplateUse",
  // ── 리마인더 ──────────────────────────────────────────────────────────────
  SET_REMINDER:             "onReminderSet",
  // ── 테마/설정 ─────────────────────────────────────────────────────────────
  SET_THEME:                "onThemeChange",
  SET_DARK_MODE:            "onDarkModeChange",
  SAVE_SETTINGS:            "onSettingsSave",
  SAVE_AREA_COLORS:         "onAreaColorsSave",
  SAVE_UI_PREFS:            "onUiPrefsSave",
  SAVE_USER_INFO:           "onUserInfoSave",
  // ── 컨텍스트/내비게이션 ───────────────────────────────────────────────────
  CONTEXT_CHANGE:           "onContextChange",
  TAB_ACTIVE:               "onTabActive",
  // ── 데이터 관리 ───────────────────────────────────────────────────────────
  EXPORT_DATA:              "onDataExport",
  IMPORT_DATA:              "onDataImport",
  CLEAR_MEMO_AND_CLIPBOARD: "onDataClear",
  CLEAR_OLD_DATA:           "onDataCleanup",
  // ── 기타 ──────────────────────────────────────────────────────────────────
  RECORD_AREA_TIME:         "onAreaTimeRecord",
  MARK_GUIDE_SEEN:          "onGuideSeen",
};

function workerSend(type, payload) {
  if (!workerPort) {
    assiConsole.warn("[WorkerSend] Worker 연결 안됨. 메시지 무시:", type);
    return;
  }
  if (state?.settings?.debugLogs) {
    console.groupCollapsed(`%c ⬆️ [Worker Send] ${type}`, 'color: #3498db; font-weight: bold;');
    console.log('Payload:', payload);
    console.groupEnd();
  }
  workerPort.postMessage({ type, payload });
  // [IoC] 훅 자동 발화 — _WORKER_HOOK_MAP에 등록된 타입만 호출됨
  const _hookName = _WORKER_HOOK_MAP[type];
  if (_hookName) _runHook(_hookName, payload);
}

/**
 * Worker로부터 STATE_UPDATE 메시지를 수신하여
 * 로컬 state를 갱신하고 UI를 리렌더링합니다.
 * @param {Object} newState - Worker가 전달한 최신 상태 스냅샷
 */
let _guideTriggered = false;

function handleStateUpdate(newState) {
  // Worker STATE_UPDATE가 덮어쓰면 안 되는 로컬 전용 상태값을 보존합니다.
  // - memoDraftHtml/Text: 화면 전환(CONTEXT_CHANGE) 시 입력 중인 메모 초안이 사라지는 현상 방지
  // - selectedMenu/selectedArea: MutationObserver·bridge가 권위적 소스(authoritative source)
  //   이미 큐에 쌓인 이전 STATE_UPDATE가 늦게 도착해 로컬에서 방금 설정한 값을 덮어쓰는 race 방지
  const savedDraftHtml = state.memoDraftHtml;
  const savedDraftText = state.memoDraftText;
  const savedMenu = state.selectedMenu;
  const savedArea = state.selectedArea;
  // 다른 탭의 읽음 처리 감지를 위해 이전 미확인 상태를 보존
  const wasUnread = !!state.hasUnreadReminder;
  const _prevMemoCount = Array.isArray(state.memos) ? state.memos.length : 0;

  // 드래그/리사이즈 중에는 로컬 stickyNotes 변경사항을 worker 스냅샷으로 덮어쓰지 않습니다.
  if (state.stickyDragActive || state.stickyResizeActive) {
    const saved = state.stickyNotes;
    Object.assign(state, newState);
    state.stickyNotes = saved;
  } else {
    Object.assign(state, newState);
  }

  // 메모 초안 복원 (Worker는 draft를 관리하지 않으므로 로컬값 우선)
  state.memoDraftHtml = savedDraftHtml;
  state.memoDraftText = savedDraftText;
  // 컨텍스트 복원: MutationObserver/bridge가 설정한 값이 race로 덮어쓰이지 않도록 보존
  if (savedMenu) state.selectedMenu = savedMenu;
  if (savedArea) state.selectedArea = savedArea;
  // CSS 커스텀 프로퍼티: state 복원 후 DOM에 테마/다크모드 반영
  const root = getAssistantStyleRoot();
  if (root) {
    root.dataset.theme = state.currentTheme || "classic";
    root.classList.toggle("imsmassi-dark-mode", !!state.isDarkMode);
  }
  rebuildAssistantTabs();
  renderAssistant();
  // 드래그 중에는 sticky notes를 다시 그리지 않습니다 — 드래그 mouseup 후 saveStickyNotes() → 새 STATE_UPDATE에서 처리됩니다.
  if (!state.stickyDragActive) {
    renderStickyNotes();
  }

  // 알림 미확인 수 → 탭 타이틀 동기화 (toggleNotificationRead/markAll 이후 즉시 반영)
  syncNotifTabTitle();

  // 온보딩 가이드: 첫 입장 시(Worker 초기 상태 로드 후) 최초 1회만 표시
  if (!_guideTriggered && state.hasSeenGuide === false) {
    _guideTriggered = true;
    setTimeout(() => {
      if (typeof AssistantGuide !== "undefined") AssistantGuide.start();
    }, 600);
  }

  // [IoC] 라이프사이클 훅 실행
  const _newMemoCount = Array.isArray(state.memos) ? state.memos.length : 0;
  if (_newMemoCount > _prevMemoCount) {
    // 메모 개수 증가 감지 → 가장 최근 메모(index 0)를 전달 (Worker는 최신순 정렬)
    _runHook('onMemoAdded', state.memos[0]);
  }
  _runHook('onStateUpdate', state);
}

/**
 * 내보내기 데이터를 파일로 다운로드합니다.
 * Worker가 EXPORT_DATA_RESULT 메시지로 전달한 데이터를 처리합니다.
 * @param {Object} data - 내보낼 데이터 객체
 */
function downloadExportData(data) {
  try {
    const dataStr = JSON.stringify(data, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `assistant-backup-${toLocalDateStr()}.json`;
    getAssistantRoot().appendChild(link);
    link.click();
    getAssistantRoot().removeChild(link);
    URL.revokeObjectURL(url);

    // 백업 일자 자동 갱신
    const today = toLocalDateStr();
    state.settings.lastBackup = today;
    saveSettings({ silent: true });

    showToast(t("system.exportSuccess"));
  } catch (error) {
    console.error("내보내기 실패:", error);
    showToast(t("system.exportFail"));
  }
}

// ========================================
// Worker 수신 라우터 (Dispatcher)
// ========================================

/**
 * Worker로부터 수신된 메시지를 중앙에서 라우팅합니다.
 * connectToWorker 내부 익명 핸들러에서 분리하여 가독성 및 추적성을 높입니다.
 * WORKER_DEBUG_LOG 타입은 Worker 내부 workerConsole이 전달한 포워딩 로그입니다.
 * @param {MessageEvent} event
 */
function dispatchWorkerMessage(event) {
  const { type, payload } = event.data || {};

  // ⬇️ 수신 로그 (WORKER_DEBUG_LOG 자체는 재귀 방지를 위해 제외)
  if (state?.settings?.debugLogs && type !== 'WORKER_DEBUG_LOG') {
    console.groupCollapsed(`%c ⬇️ [Worker Receive] ${type}`, 'color: #2ecc71; font-weight: bold;');
    console.log('Payload:', payload);
    console.groupEnd();
  }

  switch (type) {
    case 'STATE_UPDATE':
      handleStateUpdate(payload);
      break;
    case 'TOAST':
      if (payload?.messageKey) {
        showToast(t(payload.messageKey, payload.params));
      } else {
        showToast(payload?.message || '');
      }
      _runHook('onToast', payload);
      break;
    case 'EXPORT_DATA_RESULT':
      downloadExportData(payload?.data);
      _runHook('onExportReady', payload?.data);
      break;
    case 'TEMPLATE_SUGGEST':
      if (!state.currentModal) {
        openModal('templateSuggest', { suggestedText: payload?.suggestedText || '' });
      }
      _runHook('onTemplateSuggest', payload);
      break;
    case 'WORKER_DEBUG_LOG': {
      // Worker 내부 workerConsole이 전달한 로그를 메인 F12 콘솔에 출력
      const logArgs = payload?.args || [];
      if (payload?.level === 'error')     console.error('[Worker Inner]', ...logArgs);
      else if (payload?.level === 'warn') console.warn('[Worker Inner]', ...logArgs);
      else                                console.log('%c[Worker Inner]', 'color: #9b59b6;', ...logArgs);
      break;
    }
    default:
      assiConsole.warn('[Assistant] Worker로부터 알 수 없는 메시지:', type);
  }
}

// ────────────────────────────────────────────────────────────
// ※ 아래 AssistantDB 클래스는 Shared Worker 미지원 환경을 위한
//   폴백(fallback)용으로 남겨두되, 정상 환경에서는 사용되지 않습니다.

// ========================================
// UserInfo 암호화 유틸리티 (Web Crypto API - AES-GCM)
// ========================================

/**
 * 앱 고유 솔트 (PBKDF2용 고정 16바이트)
 * 'SOLOMON_ASSISTAN'의 ASCII 코드값
 */
const USER_CRYPTO_SALT = new Uint8Array([
  0x53, 0x4f, 0x4c, 0x4f, 0x4d, 0x4f, 0x4e, 0x5f, 0x41, 0x53, 0x53, 0x49, 0x53,
  0x54, 0x41, 0x4e,
]);

/**
 * 암호화 대상 민감 컬럼 목록
 * - userId, userEmpNo: 사번/ID
 * - userNm, userEnglNm: 성명
 * - userJoinYd: 입사정보
 */
const USER_SENSITIVE_FIELDS = ["userId", "userEmpNo", "userNm", "userEnglNm"];

/** 파생된 AES 키 캐시 (페이지 수명 동안 재파생 방지) */
let _userCryptoKey = null;
let _userCryptoKeyId = null;

/**
 * loginId로부터 AES-256-GCM 키 파생 (PBKDF2 100,000회)
 * @param {string} loginId
 * @returns {Promise<CryptoKey>}
 */
async function deriveUserCryptoKey(loginId) {
  if (_userCryptoKey && _userCryptoKeyId === loginId) return _userCryptoKey;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(loginId)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  _userCryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: USER_CRYPTO_SALT,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  _userCryptoKeyId = loginId;
  return _userCryptoKey;
}

/**
 * 문자열 암호화 → base64 (IV 12바이트 앞에 첨부)
 * @param {string} plainText
 * @param {CryptoKey} key
 * @returns {Promise<string>} base64 인코딩된 암호문
 */
async function encryptUserField(plainText, key) {
  if (plainText == null || plainText === "") return plainText;
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(String(plainText)),
  );
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  return btoa(String.fromCharCode(...combined));
}

/**
 * base64 암호문 복호화 → 원문
 * @param {string} b64
 * @param {CryptoKey} key
 * @returns {Promise<string|null>}
 */
async function decryptUserField(b64, key) {
  if (b64 == null || b64 === "") return b64;
  try {
    const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      key,
      combined.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    assiConsole.warn("[Assistant] 필드 복호화 실패 (키 불일치 또는 손상)");
    return null;
  }
}

/**
 * UserInfo 암호화 → Worker에 저장 요청
 *
 * @param {string} loginId
 * @param {Function|Object} userInfoSource
 *   - Function : () => Object | Promise<Object>  호스트가 직접 제공하는 파서
 *   - Object   : 이미 파싱된 userInfo 객체를 직접 전달
 *
 * @example
 *   saveUserInfoToWorker(loginId, () => ({ userId: '123', userNm: '홍길동' }))
 *   saveUserInfoToWorker(loginId, { userId: '123', userNm: '홍길동' })
 */
async function saveUserInfoToWorker(loginId, userInfoSource) {
  if (!userInfoSource) return;
  let raw;
  try {
    if (typeof userInfoSource === "function") {
      raw = await userInfoSource();
    } else if (typeof userInfoSource === "object") {
      raw = userInfoSource;
    }
  } catch (e) {
    assiConsole.warn("[Assistant] UserInfo 소스 실행 실패:", e);
    raw = null;
  }

  if (!raw || !Object.keys(raw).length) {
    assiConsole.warn("[Assistant] UserInfo 없음 — 저장 건너뜀");
    return;
  }
  try {
    const key = await deriveUserCryptoKey(loginId);
    const encrypted = {
      ...raw,
      _encrypted: [],
      _savedAt: new Date().toISOString(),
    };
    for (const field of USER_SENSITIVE_FIELDS) {
      if (field in raw && raw[field] !== "") {
        encrypted[field] = await encryptUserField(raw[field], key);
        encrypted._encrypted.push(field);
      }
    }
    workerSend("SAVE_USER_INFO", { userInfo: encrypted });
    assiConsole.log(
      "[Assistant] UserInfo 암호화 저장 완료 (loginId:",
      loginId,
      ")",
    );
  } catch (e) {
    console.error("[Assistant] UserInfo 암호화/저장 실패:", e);
  }
}

/**
 * state.userInfo(암호화 상태)를 복호화하여 반환
 * Worker STATE_UPDATE 수신 후 호출하세요.
 * @param {string} loginId
 * @returns {Promise<Object|null>}
 */
// ── [Section 2] Worker 연결 진입점 ────────────────────────────────────────────
/**
 * Shared Worker에 연결합니다.
 * Worker로부터의 메시지(STATE_UPDATE, TOAST, EXPORT_DATA_RESULT)를 수신하여 처리합니다.
 * @param {string} workerPath - assistant-worker.js 경로
 * @param {string} [loginId] - 사용자 로그인 ID (DB 격리에 사용)
 * @param {Object} [initialContext] - 초기 컨텍스트 (menuId, areaId 등)
 */
function connectToWorker(workerPath, loginId, initialContext = {}) {
  try {
    const worker = new SharedWorker(workerPath, { name: "assistant-worker" });
    workerPort = worker.port;

    // 수신 메시지를 중앙 라우터(dispatchWorkerMessage)에 위임
    workerPort.addEventListener('message', dispatchWorkerMessage);

    workerPort.start();
    // INIT 메시지로 초기 상태 요청 (initialContext 포함 → 레이스 없이 원자적 컨텍스트 설정)
    workerPort.postMessage({
      type: "INIT",
      payload: { loginId, ...initialContext },
    });
    assiConsole.log("[Assistant] SharedWorker 연결 완료:", workerPath);
  } catch (error) {
    console.error(
      "[Assistant] SharedWorker 연결 실패, 폴백 모드로 전환합니다.",
      error,
    );
    _bootstrapFallback(loginId);
  }
}

/**
 * SharedWorker 미지원 환경 폴백 (직접 IndexedDB 접근)
 * @param {string} [loginId]
 */
async function _bootstrapFallback(loginId) {
  assiConsole.warn("[Assistant] 폴백 모드: IndexedDB 직접 접근");
  const dbName = loginId ? `AssistantDB_${loginId}` : "AssistantDB_public";
  db = new AssistantDB(dbName, 5);
  try {
    await loadStateFromDB();
  } catch (e) {
    console.error("[Assistant] 폴백 DB 로드 실패:", e);
  }
  renderAll();
  initStickyNoteDrop();
  initReminderSystem();
}

// ────────────────────────────────────────────────────────────
// ※ 아래 AssistantDB 클래스는 Shared Worker 미지원 환경을 위한
//   폴백(fallback)용으로 남겨두되, 정상 환경에서는 사용되지 않습니다.
class AssistantDB {
  constructor(dbName = "AssistantDB", dbVersion = 4) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.db = null;
    this.stores = ["memos", "clipboard", "templates", "settings", "metadata"];
  }

  // DB 초기화
  async init() {
    // Persistent Storage 요청 (데이터 손실 방지)
    if (navigator.storage && navigator.storage.persist) {
      try {
        const persisted = await navigator.storage.persist();
        assiConsole.log(
          "Persistent Storage 상태:",
          persisted ? "활성화" : "비활성화",
        );
      } catch (error) {
        assiConsole.warn("Persistent Storage 요청 실패:", error);
      }
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error("IndexedDB 오픈 실패:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        assiConsole.log("IndexedDB 초기화 완료:", this.dbName);
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        assiConsole.log("IndexedDB 스토어 생성 중...");

        // 메모 스토어 (areaId 인덱스)
        if (!db.objectStoreNames.contains("memos")) {
          const memoStore = db.createObjectStore("memos", { keyPath: "id" });
          memoStore.createIndex("areaId", "areaId", { unique: false });
          memoStore.createIndex("date", "date", { unique: false });
          memoStore.createIndex("pinned", "pinned", { unique: false });
        }

        // 클립보드 스토어
        if (!db.objectStoreNames.contains("clipboard")) {
          const clipStore = db.createObjectStore("clipboard", {
            keyPath: "id",
            autoIncrement: true,
          });
          clipStore.createIndex("menu", "menu", { unique: false });
          clipStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // 템플릿 스토어
        if (!db.objectStoreNames.contains("templates")) {
          db.createObjectStore("templates", {
            keyPath: "id",
            autoIncrement: true,
          });
        }

        // 설정 스토어 (싱글톤)
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings");
        }

        // 메타데이터 스토어 (마지막 수정 시간 등)
        if (!db.objectStoreNames.contains("metadata")) {
          db.createObjectStore("metadata");
        }
      };
    });
  }

  // 트랜잭션 실행
  async transaction(storeName, mode, callback) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let callbackResult = null;
      let hasError = false;

      try {
        // 콜백 실행 (store.delete, store.put 등)
        callbackResult = callback(store);

        // IDBRequest인 경우 (delete, put, add, get 등)
        if (callbackResult && typeof callbackResult.onsuccess === "function") {
          callbackResult.onsuccess = () => {
            assiConsole.log(`[transaction] ${storeName} IDBRequest 성공`);
          };
          callbackResult.onerror = () => {
            console.error(
              `[transaction] ${storeName} IDBRequest 실패:`,
              callbackResult.error,
            );
            hasError = true;
          };
        }

        // 트랜잭션 완료 대기
        tx.oncomplete = () => {
          if (hasError) {
            reject(new Error("Transaction request failed"));
          } else {
            assiConsole.log(`[transaction] ${storeName} 트랜잭션 완료 (${mode})`);
            resolve(callbackResult);
          }
        };

        tx.onerror = () => {
          console.error(`[transaction] ${storeName} 트랜잭션 에러:`, tx.error);
          reject(tx.error);
        };

        tx.onabort = () => {
          console.error(`[transaction] ${storeName} 트랜잭션 중단`);
          reject(new Error("Transaction aborted"));
        };
      } catch (error) {
        console.error(`[transaction] ${storeName} 콜백 에러:`, error);
        reject(error);
      }
    });
  }

  // CRUD 작업

  // 메모 추가 (memoId를 키로 사용)
  async addMemo(memoId, memo) {
    if (!memoId) {
      throw new Error("[addMemo] memoId가 없습니다");
    }
    memo.id = memoId; // memoId를 메모 객체에 저장
    memo.timestamp = Date.now();
    assiConsole.log("[db.addMemo] 메모 추가:", memoId);
    return this.transaction("memos", "readwrite", (store) => {
      // 기존 메모가 있으면 덮어쓰기, 없으면 추가
      return store.put(memo);
    });
  }

  // 특정 영역 메모 조회
  async getMemosByArea(areaId) {
    return this.transaction("memos", "readonly", (store) => {
      const index = store.index("areaId");
      return new Promise((resolve) => {
        const request = index.getAll(areaId);
        request.onsuccess = () => {
          const memos = request.result.sort((a, b) => {
            if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
            return new Date(b.date) - new Date(a.date);
          });
          resolve(memos);
        };
      });
    });
  }

  // 메모 업데이트
  async updateMemo(memo, memoId) {
    // memoId가 전달되지 않으면 memo 객체에서 id 필드 사용
    if (memoId && !memo.id) {
      memo.id = memoId;
    }
    memo.updatedAt = memo.updatedAt || Date.now();
    return this.transaction("memos", "readwrite", (store) => {
      return store.put(memo);
    });
  }

  // 메모 삭제
  async deleteMemo(memoId) {
    if (!memoId) {
      throw new Error("[deleteMemo] memoId가 없습니다");
    }

    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      assiConsole.log("[db.deleteMemo] 메모 삭제 시도:", memoId);

      const tx = this.db.transaction("memos", "readwrite");
      const store = tx.objectStore("memos");
      const request = store.delete(memoId);

      request.onsuccess = () => {
        assiConsole.log("[db.deleteMemo] 메모 삭제 성공:", memoId);
      };

      request.onerror = () => {
        console.error("[db.deleteMemo] 메모 삭제 요청 실패:", request.error);
        reject(request.error);
      };

      tx.oncomplete = () => {
        assiConsole.log("[db.deleteMemo] 트랜잭션 완료:", memoId);
        resolve(true);
      };

      tx.onerror = () => {
        console.error("[db.deleteMemo] 트랜잭션 에러:", tx.error);
        reject(tx.error);
      };

      tx.onabort = () => {
        console.error("[db.deleteMemo] 트랜잭션 중단:", memoId);
        reject(new Error("Transaction aborted"));
      };
    });
  }

  // 모든 메모 조회 (내보내기용)
  async getAllMemos() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("memos", "readonly");
      const store = tx.objectStore("memos");
      const request = store.getAll();

      request.onsuccess = () => {
        const memos = request.result;
        assiConsole.log("[db.getAllMemos] 메모 로드 완료:", memos.length, "개");
        resolve(memos);
      };

      request.onerror = () => {
        console.error("[db.getAllMemos] 메모 로드 실패:", request.error);
        reject(request.error);
      };

      tx.onerror = () => {
        console.error("[db.getAllMemos] 트랜잭션 에러:", tx.error);
        reject(tx.error);
      };
    });
  }

  // 클립보드 추가 (indexedDb메서드)
  async addClipboardItem(item) {
    item.timestamp = Date.now();
    assiConsole.log(item);
    return this.transaction("clipboard", "readwrite", (store) => {
      return new Promise((resolve, reject) => {
        const request = store.add(item);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  // 클립보드 아이템 업데이트 (카운트 증가 시 사용)
  async updateClipboardItem(item) {
    return this.transaction("clipboard", "readwrite", (store) => {
      return store.put(item); // id가 같으면 덮어쓰기(업데이트) 됨
    });
  }

  // 클립보드 조회
  async getClipboardItems(limit = 50) {
    return this.transaction("clipboard", "readonly", (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const items = request.result
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
          resolve(items);
        };
      });
    });
  }

  // 클립보드 삭제 (오래된 항목)
  async deleteOldClipboardItems(daysBefore = 7) {
    const cutoffTime = Date.now() - daysBefore * 24 * 60 * 60 * 1000;
    return this.transaction("clipboard", "readwrite", (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const oldItems = request.result.filter(
            (item) => item.timestamp < cutoffTime,
          );
          oldItems.forEach((item) => store.delete(item.id));
          resolve(oldItems.length);
        };
      });
    });
  }

  // 메모 삭제 (오래된 항목)
  async deleteOldMemos(daysBefore = 90) {
    if (!daysBefore || daysBefore <= 0) return [];
    const cutoffTime = Date.now() - daysBefore * 24 * 60 * 60 * 1000;
    return this.transaction("memos", "readwrite", (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const deletedIds = [];
          request.result.forEach((memo) => {
            const createdAt =
              memo?.createdAt ||
              memo?.timestamp ||
              (memo?.date ? new Date(memo.date).getTime() : null);
            if (createdAt && createdAt < cutoffTime) {
              deletedIds.push(memo.id);
              store.delete(memo.id);
            }
          });
          resolve(deletedIds);
        };
      });
    });
  }

  // 템플릿 추가
  async addTemplate(template) {
    template.createdAt = Date.now();
    return this.transaction("templates", "readwrite", (store) => {
      return store.add(template);
    });
  }

  // 모든 템플릿 조회
  async getAllTemplates() {
    return this.transaction("templates", "readonly", (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const templates = request.result.sort((a, b) => b.count - a.count);
          resolve(templates);
        };
      });
    });
  }

  // 템플릿 업데이트
  async updateTemplate(template) {
    return this.transaction("templates", "readwrite", (store) => {
      return store.put(template);
    });
  }

  // 템플릿 삭제
  async deleteTemplate(templateId) {
    return this.transaction("templates", "readwrite", (store) => {
      return store.delete(templateId);
    });
  }

  // 설정 저장
  async saveSetting(key, value) {
    return this.transaction("settings", "readwrite", (store) => {
      return store.put(value, key);
    });
  }

  // 설정 조회
  async getSetting(key) {
    return this.transaction("settings", "readonly", (store) => {
      return new Promise((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
      });
    });
  }

  // 모든 설정 조회
  async getAllSettings() {
    return this.transaction("settings", "readonly", (store) => {
      return new Promise((resolve) => {
        const valuesRequest = store.getAll();
        const keysRequest = store.getAllKeys();

        let values = null;
        let keys = null;

        const tryResolve = () => {
          if (!values || !keys) return;
          const entries = keys.map((key, index) => ({
            key,
            value: values[index],
          }));
          resolve(entries);
        };

        valuesRequest.onsuccess = () => {
          values = valuesRequest.result || [];
          tryResolve();
        };
        keysRequest.onsuccess = () => {
          keys = keysRequest.result || [];
          tryResolve();
        };
      });
    });
  }

  // 메타데이터 저장
  async saveMetadata(key, value) {
    return this.transaction("metadata", "readwrite", (store) => {
      return store.put({ ...value, timestamp: Date.now() }, key);
    });
  }

  // 메타데이터 조회
  async getMetadata(key) {
    return this.transaction("metadata", "readonly", (store) => {
      return new Promise((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
      });
    });
  }

  // 데이터 내보내기
  async exportAllData() {
    const memos = await this.getAllMemos();
    const templates = await this.getAllTemplates();
    const settings = await this.getAllSettings();
    const clipboard = await this.getClipboardItems(500); // Issue 4: 클립보드 포함
    const filteredSettings = settings.filter(
      (setting) => !["menu_time_stats", "time_buckets"].includes(setting.key),
    );

    return {
      version: "1.0",
      exportDate: new Date().toISOString(),
      data: {
        memos,
        templates,
        settings: filteredSettings,
        clipboard,
      },
    };
  }

  // 데이터 가져오기
  async importData(importedData) {
    if (!importedData.data) throw new Error("잘못된 데이터 형식");

    const { memos = [], templates = [], settings = [], clipboard = [] } = importedData.data;

    const normalizedMemos = Array.isArray(memos)
      ? memos
      : Object.values(memos || {});
    const normalizedTemplates = Array.isArray(templates)
      ? templates
      : Object.values(templates || {});
    const normalizedClipboard = Array.isArray(clipboard)
      ? clipboard
      : Object.values(clipboard || {});

    const normalizedSettings = (() => {
      if (!settings) return [];
      if (Array.isArray(settings)) {
        return settings
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            if ("key" in item) return { key: item.key, value: item.value };
            const keys = Object.keys(item);
            if (keys.length === 1)
              return { key: keys[0], value: item[keys[0]] };
            return null;
          })
          .filter(Boolean);
      }
      if (typeof settings === "object") {
        return Object.keys(settings).map((key) => ({
          key,
          value: settings[key],
        }));
      }
      return [];
    })();

    // 메모 가져오기
    for (const memo of normalizedMemos) {
      if (!memo || typeof memo !== "object") continue;
      const memoId =
        memo.id || memo.memoId || memo.areaId || memo.createdAreaId;
      await this.addMemo(memoId, memo);
    }

    // 템플릿 가져오기
    for (const template of normalizedTemplates) {
      if (!template || typeof template !== "object") continue;
      await this.addTemplate(template);
    }

    // 클립보드 가져오기: store.put으로 원본 id·timestamp 유지
    for (const item of normalizedClipboard) {
      if (!item || typeof item !== "object") continue;
      if (!item.content) continue;
      const itemToSave = { ...item };
      if (!itemToSave.timestamp) itemToSave.timestamp = Date.now();
      await this.transaction("clipboard", "readwrite", (store) =>
        store.put(itemToSave),
      );
    }

    // 설정 가져오기
    for (const setting of normalizedSettings) {
      if (!setting || !setting.key) continue;
      if (["menu_time_stats", "time_buckets"].includes(setting.key)) continue;
      await this.saveSetting(setting.key, setting.value);
    }

    return {
      success: true,
      imported: normalizedMemos.length + normalizedTemplates.length + normalizedClipboard.length,
    };
  }

  // DB 클리어
  async clearAll() {
    const storeNames = [
      "memos",
      "clipboard",
      "templates",
      "settings",
      "metadata",
    ];
    for (const storeName of storeNames) {
      await this.transaction(storeName, "readwrite", (store) => {
        return store.clear();
      });
    }
  }

  // DB 삭제
  async deleteDatabase() {
    if (this.db) this.db.close();
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// 폴백용 DB 인스턴스 (SharedWorker 미지원 환경)
let db;

// ============================================================================
// [Section 3] GLOBAL STATE & CONSTANTS  📦 전역 상태 및 상수
// ============================================================================
// themes, THEME_SWATCHES, ASSISTANT_TABS, state 객체, 전역 변수

// ============================================================================
// 테마별 표시명 메타데이터 (색상 값은 assistant.css 커스텀 프로퍼티로 이관)
const themes = {
  classic: { name: "클래식" },
  earthbrown: { name: "어스 브라운" },
  oceangreen: { name: "오션 그린" },
  lightbeige: { name: "라이트 베이지" },
};

// 테마 선택 UI에서 비활성 테마의 닷(dot) 표식에 사용하는 정적 스와치
// (활성 테마는 getTheme()로 CSS var에서 읽으므로 이곳에 포함하지 않아도 됨)
const THEME_SWATCHES = {
  classic: { primary: "#4A90A4", light: "#E8F4F8", border: "" },
  earthbrown: { primary: "#C9BEAA", light: "#D6CEC0", border: "" },
  oceangreen: { primary: "#7CE0D3", light: "#A9E9E1", border: "" },
  lightbeige: {
    primary: "#FBF1E6",
    light: "#FAF3EB",
    border: "1px solid #ccc",
  },
};

const businessAreas = [
  { id: "UW", name: "언더라이팅", color: "#333d4b", bgColor: "#E8F1FB" },
  { id: "CT", name: "계약", color: "#5BA55B", bgColor: "#E8F5E8" },
  { id: "CL", name: "손사", color: "#E67E22", bgColor: "#FEF3E8" },
  { id: "AC", name: "계수", color: "#9B59B6", bgColor: "#F5EBF9" },
  { id: "PF", name: "실적", color: "#1ABC9C", bgColor: "#E8F8F5" },
  { id: "ST", name: "정청산", color: "#E74C3C", bgColor: "#FDECEB" },
  { id: "FN", name: "회계", color: "#34495E", bgColor: "#EBF0F5" },
];

/**
 * 업무영역 목록 반환. window.ASSISTANT_AREAS가 주입된 경우 우선 사용.
 *
 * 외부 데이터의 컬럼명이 다를 때는 window.ASSISTANT_AREA_KEYS로 매핑 지정:
 * @example
 * window.ASSISTANT_AREA_KEYS = {
 *   id:   'menuId',   // → area.id  (식별자)
 *   name: 'menuNm',  // → area.name (화면 표시명)
 * };
 * window.ASSISTANT_AREAS = [
 *   { areaCode: 'UW', areaName: '언더라이팅', mainColor: '#191F28', subColor: '#E8F1FB' },
 *   ...
 * ];
 */
function getBusinessAreas() {
  if (
    !Array.isArray(window.ASSISTANT_AREAS) ||
    !window.ASSISTANT_AREAS.length
  ) {
    return businessAreas;
  }
  const keys = window.ASSISTANT_AREA_KEYS || {};
  // 키 매핑이 없으면 그대로 반환
  if (!Object.keys(keys).length) return window.ASSISTANT_AREAS;

  const defaultColors = [
    "#191F28",
    "#5BA55B",
    "#E67E22",
    "#9B59B6",
    "#1ABC9C",
    "#E74C3C",
    "#34495E",
  ];
  return window.ASSISTANT_AREAS.map((item, i) => {
    const color =
      item[keys.color || "color"] || defaultColors[i % defaultColors.length];
    const bgColor = item[keys.bgColor || "bgColor"] || color + "22"; // 투명도 fallback
    return {
      ...item, // 원본 필드 보존
      id: item[keys.id || "id"],
      name: item[keys.name || "name"],
      color,
      bgColor,
    };
  });
}

const assistantTabs = [];

// ============================================================================
// [Section 4] CORE UTILITIES  🔧 공통 유틸리티
// ============================================================================
// [4-A] 날짜 유틸: toLocalDateStr  (선언 위치: 파일 상단 CORE 진입 전)
// [4-B] 다국어(i18n): i18nDict, currentLocale, getI18nBasePath, t, setLocale,
//                     loadLocale, normalizeLocale
// [4-C] DOM 헬퍼: createElement, getAssistantRoot, getAssistantStyleRoot
// [4-D] 테마/영역: getTheme, getArea, getColors, getAreaName, applyAreaColorVars
// [4-E] 기타 유틸: showToast, generateMemoId, escapeHtml, sanitizeHtml,
//                  getMemoPlainText, getRelativeTime, formatNotifTime
// [4-F] 훅 실행기: _runHook
// ============================================================================

// ── [4-F] 훅 실행기 ──────────────────────────────────────────────────────────

/**
 * _runHook — 등록된 훅 콜백을 안전하게 실행합니다.
 * 훅이 없거나 오류 발생 시 어시스턴트 동작에 영향을 주지 않습니다.
 *
 * 사용 가능한 훅 목록 (bootstrapAssistant({ hooks: { ... } }) 로 등록):
 *
 * ┌ 패널  ─────────────────────────────────────────────────────────────────┐
 * │ onPanelOpen()            패널이 열릴 때                                │
 * │ onPanelClose()           패널이 닫힐 때                                │
 * ├ 메모  ─────────────────────────────────────────────────────────────────┤
 * │ onMemoAdd(payload)       메모 추가 전송 시                              │
 * │ onMemoAdded(memo)        메모 추가 후 STATE_UPDATE 수신 시              │
 * │ onMemoDelete(payload)    메모 삭제 시                                   │
 * │ onMemoEdit(payload)      메모 본문 편집 시                              │
 * │ onMemoTitleSave(payload) 메모 제목 저장 시                              │
 * │ onMemoPin(payload)       메모 고정 토글 시                              │
 * │ onMemoLabel(payload)     메모 라벨 토글 시                              │
 * │ onTodoToggle(payload)    할 일 체크 토글 시                             │
 * │ onMemoCopy(payload)      메모+포스트잇 복사 시                          │
 * ├ 포스트잇 ──────────────────────────────────────────────────────────────┤
 * │ onStickyAdd(payload)     포스트잇 추가 시                               │
 * │ onStickyRemove(payload)  포스트잇 삭제 시                               │
 * │ onStickySave(payload)    포스트잇 저장 시                               │
 * ├ 클립보드 ──────────────────────────────────────────────────────────────┤
 * │ onClipboardAdd(payload)    클립보드 항목 추가 시                        │
 * │ onClipboardDelete(payload) 클립보드 항목 삭제 시                        │
 * │ onClipboardRefresh()       클립보드 새로고침 시                         │
 * ├ 템플릿 ────────────────────────────────────────────────────────────────┤
 * │ onTemplateAdd(payload)   템플릿 추가 시                                 │
 * │ onTemplateDelete(payload)템플릿 삭제 시                                 │
 * │ onTemplateEdit(payload)  템플릿 수정 시                                 │
 * │ onTemplatePin(payload)   템플릿 고정 토글 시                            │
 * │ onTemplateUse(payload)   템플릿 사용 시                                 │
 * │ onTemplateSuggest(payload) 자동완성 제안 수신 시 (Worker→UI)           │
 * ├ 리마인더 ──────────────────────────────────────────────────────────────┤
 * │ onReminderSet(payload)   리마인더 설정 시                               │
 * ├ 테마/설정 ─────────────────────────────────────────────────────────────┤
 * │ onThemeChange(payload)   테마 변경 시                                   │
 * │ onDarkModeChange(payload)다크모드 토글 시                               │
 * │ onSettingsSave(payload)  설정 저장 시                                   │
 * │ onAreaColorsSave(payload)영역 색상 저장 시                              │
 * │ onUiPrefsSave(payload)   UI 환경설정 저장 시                            │
 * │ onUserInfoSave(payload)  사용자 정보 저장 시                            │
 * ├ 컨텍스트/내비게이션 ───────────────────────────────────────────────────┤
 * │ onContextChange(payload) 화면(메뉴/영역) 전환 시                        │
 * │ onTabActive(payload)     탭 활성화 시                                   │
 * ├ 데이터 관리 ───────────────────────────────────────────────────────────┤
 * │ onDataExport(payload)    데이터 내보내기 요청 시                        │
 * │ onExportReady(data)      내보내기 파일 준비 완료 시 (Worker→UI)        │
 * │ onDataImport(payload)    데이터 가져오기 시                             │
 * │ onDataClear(payload)     메모+클립보드 초기화 시                        │
 * │ onDataCleanup(payload)   오래된 데이터 자동 정리 시                     │
 * ├ 상태 ──────────────────────────────────────────────────────────────────┤
 * │ onStateUpdate(state)     Worker STATE_UPDATE 처리 완료 시               │
 * │ onToast(payload)         토스트 메시지 표시 시 (Worker→UI)             │
 * ├ 기타 ──────────────────────────────────────────────────────────────────┤
 * │ onAreaTimeRecord(payload)영역 체류 시간 기록 시                         │
 * │ onGuideSeen(payload)     온보딩 가이드 확인 시                          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * @param {string} name - 훅 이름 (예: 'onMemoAdd')
 * @param {...*}   args - 훅에 전달할 인자
 */
function _runHook(name, ...args) {
  try {
    _assistantConfig?.hooks?.[name]?.(...args);
  } catch (e) {
    assiConsole.warn(`[Assistant] hook "${name}" 오류:`, e);
  }
}

// ── [4-B] 다국어(i18n) ───────────────────────────────────────────────────────

/** @type {Record<string, any>} 로드된 언어 사전 */
let i18nDict = {};

/** @type {string} 현재 활성 로케일 */
let currentLocale = AssistantConfig.i18n.defaultLocale;

/**
 * 언어 사전 파일의 기준 경로 (assistant.js 위치 기준 자동 해결)
 * assistant-loader.js의 resolvePath 방식과 동일하게 처리됩니다.
 * @returns {string} i18n 디렉토리 절대 URL
 */
function getI18nBasePath() {
  try {
    const scripts = Array.from(document.querySelectorAll("script[src]"));
    // "assistant-worker.js" 등 다른 파일을 오매칭하지 않도록 정확히 "assistant.js"로 끝나는 것만 선택
    const self = scripts.find(
      (s) => s.src && /\/assistant\.js(\?|$)/.test(s.src),
    );
    const base = self ? self.src : document.baseURI;
    return new URL("i18n/", base).toString();
  } catch (_) {
    return "i18n/";
  }
}

/**
 * 다국어 키로 번역된 문자열을 반환합니다.
 * 점(.) 구분으로 중첩 키를 탐색하며, 동적 파라미터 바인딩을 지원합니다.
 *
 * @param {string} key - "카테고리.키명" 형식의 번역 키 (예: "시스템.메모_추가_알림")
 * @param {Record<string, string|number>} [params] - 동적 치환 파라미터 ({count}, {areaName} 등)
 * @returns {string} 번역된 문자열. 키를 찾을 수 없으면 키 자체를 반환합니다.
 */
function t(key, params) {
  const parts = key.split(".");
  let value = i18nDict;
  for (const part of parts) {
    if (value && typeof value === "object" && part in value) {
      value = value[part];
    } else {
      // 키 미발견 시 키 자체 반환 (사전 미로드 상황 대비)
      return key;
    }
  }
  if (typeof value !== "string") return key;
  if (!params) return value;
  // {placeholder} 형식 동적 치환
  return value.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

/**
 * 언어를 런타임에 동적으로 변경합니다.
 * 새 사전 파일을 fetch한 뒤 전체 UI를 즉시 재렌더링합니다.
 *
 * @param {string} newLocale - 변경할 로케일 코드 ("ko-kr" | "en-us")
 * @returns {Promise<void>}
 */
async function setLocale(newLocale) {
  if (!newLocale || newLocale === currentLocale) return;
  try {
    const url = getI18nBasePath() + `${newLocale}.json`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`[i18n] 언어 파일 로드 실패: ${url} (${res.status})`);
    i18nDict = await res.json();
    currentLocale = newLocale;
    assiConsole.log(`[Assistant] 언어 변경 완료: ${newLocale}`);

    // 정적 요소 즉시 갱신 (renderAssistant 조기 반환과 무관하게 항상 적용)
    syncStaticLocaleElements();

    // 전체 UI 즉시 재렌더링
    renderAll();
    renderStickyNotes();

    // Quill placeholder 수동 갱신 (DOM 재생성 불가 서드파티 인스턴스)
    if (memoQuill) {
      const area = typeof getArea === "function" ? getArea() : null;
      const areaName = area?.name || "";
      const placeholderText = areaName
        ? t("ui.memoPlaceholder", { areaName })
        : t("ui.memoPlaceholderDefault");
      const editorEl = memoQuill.root;
      if (editorEl) editorEl.dataset.placeholder = placeholderText;
    }
  } catch (err) {
    console.error("[Assistant] setLocale 실패:", err);
  }
}

/**
 * 초기 언어 사전을 로드합니다. bootstrapAssistant 에서 호출됩니다.
 * @param {string} [locale="ko"]
 * @returns {Promise<void>}
 */
async function loadLocale(locale) {
  const target = locale || "ko-kr";
  try {
    const url = getI18nBasePath() + `${target}.json`;
    assiConsole.log(`[Assistant] i18n 로드 시도: ${url}`);
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`[i18n] 초기 언어 파일 로드 실패: ${url} (${res.status})`);
    i18nDict = await res.json();
    currentLocale = target;
    assiConsole.log(`[Assistant] 언어 사전 로드 완료: ${target}`);
  } catch (err) {
    assiConsole.warn("[Assistant] 언어 사전 로드 실패 (한국어 기본값 유지):", err);
  }
}

/**
 * 언어 코드를 i18n 파일명 형식으로 정규화합니다.
 * "ko-KR" → "ko-kr",  "en-US" → "en-us",  "ko" → "ko-kr",  "en" → "en-us"
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeLocale(raw) {
  if (!raw || typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase().replace("_", "-");
  if (lower === "ko" || lower === "ko-kr") return "ko-kr";
  if (lower === "en" || lower === "en-us" || lower === "en-gb") return "en-us";
  const base = lower.split("-")[0];
  if (base === "ko") return "ko-kr";
  if (base === "en") return "en-us";
  return null;
}

// ── [4-C] DOM 헬퍼 ────────────────────────────────────────────────────────────
/**
 * createElement - DOM 요소를 프로그래밍 방식으로 생성하는 헬퍼
 * @param {string} tag - HTML 태그 이름
 * @param {Object} props - className, style(객체), 이벤트(onXxx), 기타 속성
 * @returns {HTMLElement}
 */
function createElement(tag, props = {}) {
  const el = document.createElement(tag);
  const { className, style, ...attrs } = props;
  if (className) el.className = className;
  if (style && typeof style === "object") {
    Object.entries(style).forEach(([k, v]) => {
      el.style[k] = v;
    });
  }
  Object.entries(attrs).forEach(([key, val]) => {
    if (key.startsWith("on") && typeof val === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (val !== null && val !== undefined) {
      el.setAttribute(key, String(val));
    }
  });
  return el;
}

// ========================================
// 탭 시스템 중앙 설정 (ASSISTANT_TABS)
// ========================================
/** 스크립트 자신의 URL 기준으로 ../asset/ 경로를 런타임 해결 */
const _ASSI_ASSET_BASE = (() => {
  try {
    const s = document.currentScript?.src ||
      [...document.querySelectorAll('script')].map(e => e.src).find(src => src.includes('assistant.js')) || '';
    return s ? new URL('../asset/', s).href : '';
  } catch (_) { return ''; }
})();
/** ─── 아이콘: asset 파일 참조 (img 태그) ─── */
const ICONS = {
  // 알림 배지: 리마인더 시계 아이콘 (#0074EB 고정색)
  time: `<img src="${_ASSI_ASSET_BASE}images/ico_time_reminder.svg" width="12" height="12" alt="" style="vertical-align:middle">`,
};

/**
 * 각 탭의 id, icon, label, render 함수를 선언적으로 정의합니다.
 * 새로운 탭을 추가할 때는 이 객체에 항목을 추가하고
 * 해당 render 함수만 작성하면 됩니다.
 */
const ASSISTANT_TABS = {
  memo: {
    id: "memo",
    label: "메모",
    render: () => renderMemoTab(),
  },
  dashboard: {
    id: "dashboard",
    label: "대시보드",
    render: () => renderDashboardTab(),
  },
  settings: {
    id: "settings",
    label: "설정",
    render: () => renderSettingsTab(),
  },
};

/**
 * assistantTabs 배열을 현재 settings에 맞게 재구성
 */
function rebuildAssistantTabs() {
  assistantTabs.length = 0;
  ["memo", "dashboard", "settings"].forEach((id) => {
    if (ASSISTANT_TABS[id]) assistantTabs.push(ASSISTANT_TABS[id]);
  });
}

// ── [Section 2] state 객체 ─────────────────────────────────────────────────
// ⚠️ state는 Worker의 STATE_UPDATE를 통해서만 갱신해야 합니다.
//    직접 대입(state.xxx = yyy)은 handleStateUpdate 내부에서만 허용됩니다.
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  currentTheme: "classic",
  isDarkMode: false,
  selectedArea: "UW",
  selectedMenu: "", // imsmassi-lnb 선택 메뉴 (화면ID, setupStickyLayerObserver 초기화 시 getMenuId()로 설정됨)
  assistantOpen: false,
  activeTab: "memo",
  lastNonSettingsTab: "memo",
  timePeriod: "today",
  lastMenuChangeTime: Date.now(), // 메뉴 변경 시간 추적
  menuTimeStats: {}, // 메뉴별 누적 머문시간 (밀리초 단위)
  isInternalCopy: false, // 앱 내부에서 복사 중인지 확인하는 플래그
  lastCopySource: null, // 마지막 복사 소스 (template 등)
  memoDraftHtml: "", // 메모 입력 임시 HTML (Quill)
  memoDraftText: "", // 메모 입력 임시 텍스트 (Quill)
  autoNavigateToDashboard: true, // 알림 설정 후 대시보드 자동 이동 설정
  isMemoPanelExpanded: false, // 메모 사이드 패널 펼침 상태
  memoFilter: "menu", // 메모 필터: 'menu' | 'area' | 'all'

  // 메모 데이터 (전역 저장소 - IndexedDB에서 로드됨)
  /**
   * memos: Object mapping memoId to memo object
   * {
   *   [memoId: string]: {
   *     id: string,              // Unique memo ID
   *     areaId: string,          // 업무영역 코드 (예: 'underwriting')
   *     menuId: string,          // 메뉴 코드 (예: '조회')
   *     title: string,           // 메모 제목
   *     content: string,         // 메모 본문
   *     labels: string[],        // 라벨 목록
   *     pinned: boolean,         // 상단 고정 여부
   *     reminder: number|null,   // 알림 시각 (timestamp) 또는 null
   *     createdAt: number,       // 생성시각 (timestamp)
   *     updatedAt: number,       // 수정시각 (timestamp)
   *     origin: string,          // 생성 출처(예: 'manual', 'imported', ...)
   *     color: string,           // 배경색 (hex, optional)
   *     ...etc                  // 기타 확장 필드
   *   }
   * }
   */
  memos: {},

  // 포스트잇 메모 (화면에 띄운 메모)
  /**
   * stickyNotes: Array of sticky note objects
   * {
   *   id: string,              // Unique sticky note ID
   *   memoId: string,          // Linked memo ID
   *   areaId: string,          // 업무영역 코드 (예: 'underwriting')
   *   menuId: string,          // 메뉴 코드 (예: '조회')
   *   x: number,               // X 좌표 (px)
   *   y: number,               // Y 좌표 (px)
   *   width: number,           // 너비 (px)
   *   height: number,          // 높이 (px)
   *   color: string,           // 배경색 (hex)
   *   zIndex: number,          // z-index
   *   createdAt: number,       // 생성시각 (timestamp)
   *   updatedAt: number,       // 수정시각 (timestamp)
   *   isCollapsed: boolean     // 접힘 상태
   * }
   */
  stickyNotes: [],

  // 업무영역별 커스텀 컬러 { UW: { primary, sub1, sub2 }, ... }
  areaColors: {},

  // 포스트잇 드래그/리사이즈 진행 중 플래그 — STATE_UPDATE 수신 시 local 변경사항 보호
  stickyDragActive: false,
  stickyResizeActive: false,

  // 미확인 리마인더 표시
  hasUnreadReminder: false,

  // 포스트잇 편집 중 포커스 충돌 방지
  isStickyNoteEditing: false,
  suppressInlineFocus: false,

  // 메모 인덱스 (menuId별 메모 ID 리스트 - 빠른 조회용)
  memosByArea: {},

  /**
   * clipboard: 클립보드 객체 배열 (최근 복사된 항목 저장)
   * {
   *   id: number,           // 고유 ID
   *   content: string,      // 복사된 내용
   *   menu: string,         // 메뉴명 (예: '조회')
   *   areaId: string,       // 업무영역 코드 (예: 'underwriting')
   *   time: string,         // 경과 시간 표시 (예: '2분 전')
   *   timestamp: number     // 복사 시각 (timestamp)
   * }
   */
  clipboard: [],

  /**
   * templates: 템플릿 객체 배열
   * {
   *   id: number,           // 고유 ID
   *   title: string,        // 템플릿 제목
   *   content: string,      // 템플릿 본문
   *   count: number         // 사용 횟수
   * }
   */
  templates: [],

  /**
   * todos: 리마인더용 할 일 객체 배열
   * {
   *   id: number,           // 고유 ID
   *   text: string,         // 할 일 내용
   *   time: string,         // 시간 또는 상태 (예: '14:00', '완료')
   *   imsmassi-done: boolean         // 완료 여부
   * }
   */
  todos: [],

  // 설정 데이터
  settings: {
    autoCleanup: {
      clipboard: 7, // 일
      oldMemos: 90, // 일
    },
    // 디버그 로그
    debugLogs: false,
    // 백업 알림 설정
    backupReminder: false,
    // 최종 백업 날짜
    lastBackup: "2026-01-03",
    // 클립보드 캡처 활성화 (시스템 클립보드 변경 감지)
    enableClipboardCapture: true,
    // 마크다운 단축키 활성화
    markdownEnabled: false,
    // 알림 설정 후 대시보드 자동 이동
    autoNavigateToDashboard: false,
    // 브라우저 알림 on/off
    browserNotificationEnabled: false,
    // 리마인더 알림 on/off (토스트 + 브라우저 알림 통합 스위치)
    reminderNotificationEnabled: true,
    // 토스트 알림 on/off
    toastEnabled: false,
  },

  // 저장 용량 (시뮬레이션)
  storageUsed: 2.5, // MB
  storageLimit: 50, // MB

  // 시간 데이터 (기간별 버킷화된 저장)
  timeBuckets: {
    daily: {}, // YYYY-MM-DD 형식 키로 일별 데이터 저장
    weekly: {}, // YYYY-Www 형식 키로 주별 데이터 저장
    monthly: {}, // YYYY-MM 형식 키로 월별 데이터 저장
  },

  nextMemoId: 10,
  editingMemoId: null,
  editingTemplateId: null,
  nextTemplateId: 10,
  nextClipboardId: 10,

  // 모달 상태
  currentModal: null,
  currentMemoId: null,

  // 패널 높이 (px, null이면 CSS 기본값 사용)
  panelHeight: null,
  // 패널 너비 (px, null이면 CSS 기본값 사용)
  panelWidth: null,
  // 접힌/펼친 상태별 독립 너비 (640 임계값 방식 대체)
  panelWidthCollapsed: null,
  panelWidthExpanded: null,

  // 개발자 도구로 개별 온오프할 수 있는 설정 UI 노출 여부 (기본값 false: 숨김)
  hiddenUI: {
    areaColor: false,
    timeInsight: false,
    markdown: false,
    debugLog: false,
    autoNav: false,
    theme: false,    // 푸터 테마/모드 전환 UI 노줄 여부
    darkMode: false, // 푸터 다크모드 토글 버튼 노줄 여부
    sideTabs: false, // 좌측 사이드 탭 버튼 그룹 (기본값 false: 표시)
    shortcutManual: false, // 헤더 단축키 메뉴얼 버튼 노출 여부
    featureSectionTitle: false, // 기능 설정 섹션 타이틀 노출 여부 (기본값 true: 표시)
  },
};
// state 초기화 완료 — 이후부터 assiConsole 로깅 활성화
_assiDebugReady = true;

// Quill 에디터 인스턴스
let memoQuill = null;

//타겟 컨테이너 설정
const ASSISTANT_DOM_TARGET = window.ASSISTANT_DOM_TARGET || {
  rootId: "mf_VFrames_Root",
  fallbackIds: ["assistant-root"],
  useBodyFallback: true,
};

window.ASSISTANT_DOM_TARGET = ASSISTANT_DOM_TARGET;

//스타일 루트 및 어시스턴트 루트 요소 가져오기
function getAssistantRoot() {
  if (ASSISTANT_DOM_TARGET && ASSISTANT_DOM_TARGET.rootId) {
    const root = document.getElementById(ASSISTANT_DOM_TARGET.rootId);
    if (root) return root;
  }

  const fallbackIds =
    ASSISTANT_DOM_TARGET && Array.isArray(ASSISTANT_DOM_TARGET.fallbackIds)
      ? ASSISTANT_DOM_TARGET.fallbackIds
      : [];

  for (const id of fallbackIds) {
    const fallback = document.getElementById(id);
    if (fallback) return fallback;
  }

  return ASSISTANT_DOM_TARGET && ASSISTANT_DOM_TARGET.useBodyFallback
    ? document.body
    : null;
}

function getAssistantStyleRoot() {
  const styleRoot = document.getElementById("assistant-root");
  return styleRoot || getAssistantRoot() || document.body;
}

// ========================================
// 유틸리티 함수
// ========================================
function getTheme() {
  const meta = themes[state.currentTheme] || themes.classic;
  const root = getAssistantStyleRoot();
  const cs = root ? getComputedStyle(root) : null;
  const v = (name, fallback) =>
    cs ? cs.getPropertyValue(name).trim() || fallback : fallback;
  return {
    name: meta.name,
    primary: v("--imsmassi-primary", "#4A90A4"),
    primaryLight: v("--imsmassi-primary-light", "#E8F4F8"),
    primaryDark: v("--imsmassi-primary-dark", "#2E5A6A"),
  };
}

/**
 * 로컬 타임존 기준 YYYY-MM-DD 문자열 반환
 * toISOString()은 UTC 기준이라 KST(UTC+9) 환경에서 자정~오전9시 사이에
 * 날짜가 하루 밀리는 문제를 방지합니다.
 * @param {Date} [date=new Date()]
 * @returns {string} "YYYY-MM-DD"
 */
function toLocalDateStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}


/**
 * 특정 areaId의 기본(디폴트) 컬러 반환
 * businessAreas 정의값을 기준으로 하며, 없으면 하드코딩 폴백
 * @param {string} areaId
 * @returns {{ primary: string, sub1: string, sub2: string }}
 */
const STICKY_DEFAULT_COLOR = "#FFF9C4"; // 포스트잇 기본 배경색 (노란색)

/**
 * areaId → 표시명(menuNm) 반환 유틸리티
 * getBusinessAreas().name 을 우선 사용하고,
 * 매핑 없으면 areaId 자체를 반환 (긴 숫자ID 대신 '' 방지)
 * @param {string} areaId
 * @param {string} [fallback] - 미발견 시 대체 문자열 (기본: areaId)
 * @returns {string}
 */
function getAreaName(areaId, fallback) {
  if (!areaId) return fallback || "";
  const area = getBusinessAreas().find((a) => a.id === areaId);
  if (area?.name) return area.name;
  // ASSISTANT_AREAS가 주입됐지만 매핑 전인 경우: menuNm 직접 탐색
  if (Array.isArray(window.ASSISTANT_AREAS)) {
    const keys = window.ASSISTANT_AREA_KEYS || {};
    const nameKey = keys.name || "name";
    const idKey = keys.id || "id";
    const raw = window.ASSISTANT_AREAS.find((m) => m[idKey] === areaId);
    if (raw?.[nameKey]) return raw[nameKey];
  }
  return fallback !== undefined ? fallback : areaId;
}

function getDefaultAreaColors(areaId) {
  const areas = getBusinessAreas();
  const base = areas.find((a) => a.id === areaId) || areas[0];
  if (!base)
    return {
      primary: "#191F28",
      sub1: "#E8F1FB",
      sub2: STICKY_DEFAULT_COLOR,
    };
  return {
    primary: base.color || "#191F28",
    sub1: base.bgColor || base.color + "22",
    sub2: base.sub2 || STICKY_DEFAULT_COLOR,
  };
}

/**
 * 특정 areaId의 businessArea 객체에 커스텀 커러를 합쳕하여 반환
 * state.areaColors[areaId]가 있으면 primary/sub1/sub2를 오버라이드
 * @param {string} [areaId] - 업무영역 ID (생락 시 selectedArea 사용)
 * @returns {Object} area 객체 (color, bgColor, sub2 포함)
 */
function getAreaWithColors(areaId) {
  const areas = getBusinessAreas();
  const base = areas.find((a) => a.id === (areaId || state.selectedArea)) ||
    areas[0] || { id: "", name: "", color: "#191F28", bgColor: "#E8F1FB" };
  const def = getDefaultAreaColors(base.id);
  const custom = state.areaColors?.[base.id] || {};
  return {
    ...base,
    color: custom.primary ?? def.primary,
    bgColor: custom.sub1 ?? def.sub1,
    sub2: custom.sub2 ?? def.sub2,
  };
}

function getArea() {
  return getAreaWithColors(state.selectedArea);
}

function getColors() {
  const root = getAssistantStyleRoot();
  const cs = root ? getComputedStyle(root) : null;
  const v = (name, fallback) =>
    cs ? cs.getPropertyValue(name).trim() || fallback : fallback;
  return {
    bg: v("--imsmassi-bg", "#FFFFFF"),
    subBg: v("--imsmassi-sub-bg", "#F8F9FA"),
    text: v("--imsmassi-text", "#191F28"),
    subText: v("--imsmassi-sub-text", "#666666"),
    border: v("--imsmassi-border", "#E0E0E0"),
    headerText: v("--imsmassi-header-text", "#FFFFFF"),
    headerSubText: v("--imsmassi-header-sub-text", "rgba(255,255,255,0.8)"),
  };
}

/**
 * 현재 업무 영역의 컬러를 #assistant-root 에 CSS 변수로 주입합니다.
 * 하위 모든 컴포넌트는 var(--imsmassi-area-color) 등을 통해 자동 참조합니다.
 * @param {{ color: string, bgColor: string }} area - getArea() 반환값
 */
function applyAreaColorVars(area) {
  const styleRoot = getAssistantStyleRoot();
  if (!styleRoot || !area) return;
  styleRoot.style.setProperty("--imsmassi-area-color", area.color);
  styleRoot.style.setProperty("--imsmassi-area-bg", area.bgColor);
  styleRoot.style.setProperty(
    "--imsmassi-area-color-shadow",
    area.color + "33",
  );
}

function showToast(message) {
  if (state.settings && state.settings.toastEnabled === false) return;
  let toast = document.getElementById("imsmassi-toast");
  const panel = document.getElementById("imsmassi-floating-panel");
  const root = getAssistantStyleRoot();
  const target = panel || root;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "imsmassi-toast";
    toast.className = "imsmassi-toast";
    target.appendChild(toast);
  } else if (toast.parentElement !== target) {
    target.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("imsmassi-show");
  setTimeout(() => toast.classList.remove("imsmassi-show"), 2000);
}

// ========================================
// 메모 ID 및 라벨 관리 헬퍼 함수
// ========================================

// 메모 ID 생성 (시퀀스: mdi-{timestamp}-{randomId})
// 메모 ID 시퀀스 (순차적 ID 생성)
let memoIdSequence = 0;

function generateMemoId() {
  const timestamp = Date.now();
  const sequence = ++memoIdSequence;
  return `mdi-${timestamp}-${String(sequence).padStart(6, "0")}`;
}

// areaId 기준으로 메모 조회 (라벨 기반 다중 영역 지원)
function getMemosByArea(areaId) {
  const memoIds = state.memosByArea[areaId] || [];
  return memoIds
    .map((memoId) => {
      const memo = state.memos[memoId];
      if (memo) {
        // 메모 ID를 메모 객체에 추가 (렌더링에서 사용)
        return { ...memo, id: memoId };
      }
      return null;
    })
    .filter((memo) => memo) // 삭제된 메모 필터링
    .sort((a, b) => {
      // pinned > date 순서로 정렬
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
}

// ========================================
// Quill 메모 에디터 유틸리티
// ========================================
function isQuillAvailable() {
  return typeof Quill !== "undefined";
}

/**
 * quill-better-table ↔ Quill 버전 호환 shim
 *
 * quill-better-table 은 내부 paste 핸들러에서
 *   this.quill.scrollSelectionIntoView()
 * 를 호출합니다. 그러나 현재 로드된 Quill 버전에 해당 메서드가 없으면
 *   "TypeError: this.quill.scrollSelectionIntoView is not a function"
 * 에러가 발생해 붙여넣기 자체가 중단됩니다.
 *
 * - Quill 2.x  → scrollSelectionIntoView 가 prototype 에 존재 (정상)
 * - Quill 1.x  → 해당 메서드 없음 → scrollIntoView 로 폴백
 *
 * Quill 로드 직후 prototype 에 shim 을 한 번만 삽입합니다.
 */
function _applyQuillCompatShim() {
  if (typeof Quill === "undefined") return;
  if (Quill.prototype.scrollSelectionIntoView) return; // 이미 존재하면 스킵

  Quill.prototype.scrollSelectionIntoView = function () {
    // Quill 1.x 폴백: scrollIntoView 또는 호환 없으면 조용히 무시
    if (typeof this.scrollIntoView === "function") {
      this.scrollIntoView();
    }
  };
  assiConsole.log("[Quill] scrollSelectionIntoView shim 적용 완료");
}

function sanitizeHtml(input) {
  if (!input) return "";
  if (typeof DOMPurify === "undefined") return input;
  return DOMPurify.sanitize(input, { USE_PROFILES: { html: true } });
}

function getMemoEditorSnapshot(quillInstance, fallbackElement) {
  if (quillInstance) {
    const text = quillInstance.getText();
    const trimmedText = text.replace(/\s+/g, "").trim();
    const html = quillInstance.root.innerHTML || "";
    const hasImage = /<img\b/i.test(html);
    const isEmpty =
      (quillInstance.getLength() <= 1 || trimmedText.length === 0) && !hasImage;
    return { text, html, isEmpty };
  }

  if (fallbackElement) {
    const text = fallbackElement.innerText || "";
    const trimmedText = text.trim();
    return { text, html: trimmedText, isEmpty: trimmedText.length === 0 };
  }

  return { text: "", html: "", isEmpty: true };
}

function normalizeEmptyMemoEditor(quillInstance, fallbackElement) {
  if (quillInstance) {
    const snapshot = getMemoEditorSnapshot(quillInstance);
    if (!snapshot.isEmpty) return false;

    const length = quillInstance.getLength();
    if (length <= 1) return false;

    quillInstance.setContents([{ insert: "\n" }], "silent");
    state.memoDraftHtml = "";
    state.memoDraftText = "";
    return true;
  }

  if (fallbackElement) {
    const text = fallbackElement.innerText || "";
    if (text.replace(/\s+/g, "").length > 0) return false;
    if (fallbackElement.innerHTML && fallbackElement.innerHTML.trim() !== "") {
      fallbackElement.innerHTML = "";
      return true;
    }
  }

  return false;
}

function setQuillContent(quillInstance, content, isRichText) {
  if (!quillInstance) return;
  const safeContent = content || "";

  if (isRichText) {
    quillInstance.clipboard.dangerouslyPasteHTML(sanitizeHtml(safeContent));
  } else {
    quillInstance.setText(safeContent);
  }
}

// ============================================================================
// [Section 5] CORE LAYOUT & LIFECYCLE  🏗️ 레이아웃 및 생명주기
// ============================================================================
// [5-A] 테마/모드/영역: notifyThemeChange, setTheme, setDarkMode,
//                       setSelectedArea, selectMenu  → 이미 헤더 직후에 위치
// [5-B] 렌더링 라이프사이클: renderAll, renderControlPanel, renderSystemPreview,
//                           renderPalette, renderAssistant, renderAssistantTabs,
//                           renderAssistantContent, updateFooterStorageInfo → L6098
// [5-C] 대시보드/탭/패널: cycleAssistantTab, toggleDashboardView, updateDashboardButton,
//                             renderTimeTab, renderAreaColorSection, renderDashboardTab → L7187
// [5-D] 스타일 초기화 & 부트스트랩: initializeStyles, bootstrapAssistant,
//                               initPanelTopLeftResize → L7903
// ✓ connectToWorker → Section 3으로 이동 완료 (L429)
// ============================================================================

// ── [5-A] 테마 / 모드 / 영역 설정 ───────────────────────────────────────
function notifyThemeChange() {
  const theme = getTheme();
  const detail = {
    themeKey: state.currentTheme,
    isDarkMode: state.isDarkMode,
    theme,
  };

  if (typeof window.applyBaseTheme === "function") {
    window.applyBaseTheme(detail);
  }

  if (typeof window.setBaseTheme === "function") {
    window.setBaseTheme(detail);
  }

  if (typeof window.onAssistantThemeChange === "function") {
    window.onAssistantThemeChange(detail);
  }

  window.dispatchEvent(new CustomEvent("assistant:themechange", { detail }));
}

function setTheme(themeKey) {
  if (!themes[themeKey]) return;
  workerSend("SET_THEME", { themeKey });
  state.currentTheme = themeKey;
  // CSS 커스텀 프로퍼티 적용: #assistant-root[data-theme="..."]
  const root = getAssistantStyleRoot();
  if (root) root.dataset.theme = themeKey;
  notifyThemeChange();
}

function setDarkMode(isDark) {
  workerSend("SET_DARK_MODE", { isDark });
  // UI 즉각 반영 (STATE_UPDATE 수신 전까지 로컬 처리)
  state.isDarkMode = isDark;
  const root = getAssistantStyleRoot();
  root.classList.toggle("imsmassi-dark-mode", isDark);
  const btnLight = document.getElementById("btn-light");
  const btnDark = document.getElementById("btn-dark");
  if (btnLight) btnLight.classList.toggle("imsmassi-active", !isDark);
  if (btnDark) {
    btnDark.classList.toggle("imsmassi-active", isDark);
    btnDark.classList.toggle("dark-active", isDark);
  }
  notifyThemeChange();
  renderAll();
}

function setSelectedArea(areaId) {
  const areaSelect = document.getElementById("area-select");
  if (areaSelect) areaSelect.value = areaId;
  workerSend("CONTEXT_CHANGE", { areaId });
  state.selectedArea = areaId;
}

function selectMenu(menu) {
  state.selectedMenu = menu;
  // menuId + areaId를 한 번에 전송 → Worker STATE_UPDATE 1회만 발생 (이중 렌더링 방지)
  const payload = { menuId: menu };
  if (typeof _stickyLayerConfig.getAreaId === "function") {
    const areaId = _stickyLayerConfig.getAreaId(menu);
    if (areaId) {
      state.selectedArea = areaId;
      payload.areaId = areaId;
    }
  }
  workerSend("CONTEXT_CHANGE", payload);
  relocateStickyLayer();
}

// ── [5-B] 렌더링 라이프사이클 ─────────────────────────────────────────────────
function renderAll() {
  initializeStyles();
  rebuildAssistantTabs();
  renderAssistant();
}

function renderControlPanel() {
  const theme = getTheme();
  const themeButtons = document.getElementById("theme-buttons");
  if (!themeButtons) return;

  // 테마 버튼
  let themeBtnsHtml = "";
  Object.entries(themes).forEach(([key, t]) => {
    const isActive = state.currentTheme === key;
    const sw = THEME_SWATCHES[key] || THEME_SWATCHES.classic;
    const dotColor = isActive ? theme.primary : sw.primary;
    const bgColor = isActive ? theme.primaryLight : sw.light;
    const borderStyle = sw.border ? `border: ${sw.border};` : "";
    themeBtnsHtml += `
      <button class="imsmassi-theme-btn ${isActive ? "imsmassi-active" : ""}"
              style="border-color: ${isActive ? theme.primary : "#E0E0E0"}; background: ${bgColor};"
              onclick="setTheme('${key}')">
        <span class="imsmassi-theme-dot" style="background: ${dotColor}; ${borderStyle}"></span>
        ${t.name}
      </button>
    `;
  });
  themeButtons.innerHTML = themeBtnsHtml;
}
function renderSystemPreview() {
  const theme = getTheme();
  const area = getArea();
  const c = getColors();

  // Task 1: 데모 프리뷰에도 업무영역 커러 CSS 변수 적용
  applyAreaColorVars(area);

  // 시스템 미리보기 컨테이너
  const preview = document.getElementById("imsmassi-system-preview");
  if (!preview) return;
  preview.style.background = c.bg;
  preview.style.border = `1px solid ${c.border}`;

  // 헤더
  const header = document.getElementById("imsmassi-header");
  if (!header) return;
  header.style.background = state.isDarkMode
    ? theme.primaryDark
    : theme.primary;
  header.querySelector(".imsmassi-header-logo").style.color = c.headerText;
  header.querySelector(".imsmassi-header-subtitle").style.color =
    c.headerSubText;
  header.querySelector(".imsmassi-header-user").style.color = c.headerSubText;
  header.querySelector(".imsmassi-header-logout").style.color = c.headerText;

  // imsmassi-gnb
  const gnb = document.getElementById("imsmassi-gnb");
  if (!gnb) return;
  gnb.style.background = c.subBg;
  gnb.style.borderBottom = `1px solid ${c.border}`;

  let gnbHtml = "";
  getBusinessAreas()
    .slice(0, 5)
    .forEach((a) => {
      const isActive = state.selectedArea === a.id;
      gnbHtml += `
      <button class="imsmassi-gnb-btn"
              style="border-bottom-color: ${isActive ? a.color : "transparent"};
                     background: ${isActive ? (state.isDarkMode ? a.color + "30" : a.bgColor) : "transparent"};
                     color: ${isActive ? a.color : c.text};
                     font-weight: ${isActive ? "600" : "400"};"
              onclick="setSelectedArea('${a.id}')">
        ${a.name}
      </button>
    `;
    });
  gnb.innerHTML = gnbHtml;

  // imsmassi-lnb
  const lnb = document.getElementById("imsmassi-lnb");
  if (!lnb) return;
  lnb.style.background = state.isDarkMode ? "#252525" : "#FAFAFA";
  lnb.style.borderRight = `1px solid ${c.border}`;

  let lnbHtml = `
    <div class="imsmassi-lnb-header" style="background: ${state.isDarkMode ? area.color + "30" : area.bgColor}; border-left-color: ${area.color}; color: ${area.color};">
      ${area.name}
    </div>
  `;
  ["조회", "등록", "상세", "통계", "보고서"].forEach((menu) => {
    const isSelected = state.selectedMenu === menu;
    lnbHtml += `
      <div class="imsmassi-lnb-item"
           style="color: ${isSelected ? area.color : c.subText}; background: ${isSelected ? (state.isDarkMode ? area.color + "15" : area.bgColor + "80") : "transparent"}; cursor: pointer;"
           onclick="selectMenu('${menu}')">
        ${area.name} ${menu}
      </div>
    `;
  });
  lnb.innerHTML = lnbHtml;

  // 페이지 타이틀
  const pageTitle = document.getElementById("imsmassi-page-title");
  if (!pageTitle) return;
  pageTitle.style.background = state.isDarkMode
    ? area.color + "20"
    : area.bgColor;
  pageTitle.style.borderLeftColor = area.color;
  document.getElementById("page-title-text").style.color = c.text;
  document.getElementById("page-title-text").textContent =
    `${area.name} ${state.selectedMenu}`;

  // 조회 박스
  const searchBox = document.getElementById("imsmassi-search-box");
  if (!searchBox) return;
  searchBox.style.background = c.subBg;
  searchBox.style.border = `1px solid ${c.border}`;
  searchBox
    .querySelectorAll(".imsmassi-search-label")
    .forEach((el) => (el.style.color = c.subText));
  searchBox.querySelectorAll(".imsmassi-search-input").forEach((el) => {
    el.style.background = c.bg;
    el.style.color = c.text;
    el.style.borderColor = c.border;
  });
  document.getElementById("btn-search").style.background = area.color;
  document.getElementById("btn-reset").style.background = state.isDarkMode
    ? "#404040"
    : "#E0E0E0";
  document.getElementById("btn-reset").style.color = c.text;

  // 그리드
  const gridContainer = document.getElementById("imsmassi-grid-container");
  if (!gridContainer) return;
  gridContainer.style.borderColor = c.border;

  const gridToolbar = document.getElementById("imsmassi-grid-toolbar");
  if (!gridToolbar) return;
  gridToolbar.style.background = c.subBg;
  gridToolbar.style.borderBottomColor = c.border;
  gridToolbar.style.color = c.text;
  gridToolbar.querySelectorAll(".imsmassi-grid-toolbar-btn").forEach((el) => {
    el.style.borderColor = c.border;
    el.style.color = c.subText;
  });

  const gridHeader = document.getElementById("imsmassi-grid-header");
  if (!gridHeader) return;
  gridHeader.style.background = state.isDarkMode ? "#353535" : "#F5F5F5";
  gridHeader.style.borderBottomColor = c.border;
  gridHeader.querySelectorAll(".imsmassi-grid-cell").forEach((el) => {
    el.style.color = c.text;
    el.style.borderRightColor = c.border;
  });

  // 그리드 바디
  let gridBodyHtml = "";
  for (let row = 1; row <= 5; row++) {
    gridBodyHtml += `
      <div class="imsmassi-grid-row" style="background: ${row % 2 === 0 ? c.subBg : c.bg}; border-bottom: 1px solid ${c.border};">
        <div class="imsmassi-grid-cell" style="color: ${c.text}; border-right-color: ${c.border};">${row}</div>
        <div class="imsmassi-grid-cell imsmassi-link" style="color: ${area.color}; border-right-color: ${c.border};">C202501${String(row).padStart(4, "0")}</div>
        <div class="imsmassi-grid-cell" style="color: ${c.text}; border-right-color: ${c.border};">홍길동${row}</div>
        <div class="imsmassi-grid-cell" style="color: ${c.text}; border-right-color: ${c.border};">화재보험</div>
        <div class="imsmassi-grid-cell" style="color: ${c.text}; border-right-color: ${c.border};">2025-01-${String(row).padStart(2, "0")}</div>
        <div class="imsmassi-grid-cell imsmassi-right" style="color: ${c.text};">${(row * 1234567).toLocaleString()}원</div>
      </div>
    `;
  }
  const gridBody = document.getElementById("grid-body");
  if (!gridBody) return;
  gridBody.innerHTML = gridBodyHtml;

  // 버튼 영역
  const btnSave = document.getElementById("btn-save");
  const btnCancel = document.getElementById("btn-cancel");
  if (btnSave) {
    btnSave.style.background = state.isDarkMode
      ? theme.primaryDark
      : theme.primary;
    btnSave.style.color = c.headerText;
  }
  if (btnCancel) {
    btnCancel.style.borderColor = c.border;
    btnCancel.style.color = c.text;
  }

  // 포스트잇 메모 렌더링 (화면 변경 시 라벨 필터링)
  renderStickyNotes();
}

function renderPalette() {
  const theme = getTheme();
  const c = getColors();

  const paletteTitle = document.getElementById("imsmassi-palette-title");
  if (!paletteTitle) return;
  paletteTitle.textContent = `현재 테마: ${theme.name} (${state.isDarkMode ? "다크" : "라이트"} 모드)`;

  // 테마 컬러
  let themeColorsHtml = "";
  [
    { label: "Primary", color: theme.primary },
    { label: "Light", color: theme.primaryLight },
    { label: "Dark", color: theme.primaryDark },
  ].forEach((item) => {
    themeColorsHtml += `
      <div class="imsmassi-text-center">
        <div class="imsmassi-color-box" style="background: ${item.color}; border: 1px solid #E0E0E0;"></div>
        <div class="imsmassi-color-name">${item.label}</div>
        <div class="imsmassi-color-code">${item.color}</div>
      </div>
    `;
  });
  const themeColors = document.getElementById("theme-colors");
  if (!themeColors) return;
  themeColors.innerHTML = themeColorsHtml;

  // 영역 컬러
  let areaColorsHtml = "";
  getBusinessAreas().forEach((a) => {
    areaColorsHtml += `
      <div class="imsmassi-text-center">
        <div class="imsmassi-color-box" style="background: ${a.color};"></div>
        <div class="imsmassi-color-name">${a.name}</div>
        <div class="imsmassi-color-code">${a.color}</div>
      </div>
    `;
  });
  const areaColors = document.getElementById("area-colors");
  if (!areaColors) return;
  areaColors.innerHTML = areaColorsHtml;
}
/**
 * fragment HTML의 정적 요소(패널 제목, 푸터 버튼 등)를 현재 언어로 동기화합니다.
 * renderAssistant 조기 반환 여부와 무관하게 setLocale에서 직접 호출됩니다.
 */
function syncStaticLocaleElements() {
  const panelTitleText = document.getElementById("imsmassi-panel-title-text");
  if (panelTitleText) panelTitleText.textContent = t("ui.panelTitle");
  const closeBtnEl = document.getElementById("imsmassi-close-btn");
  if (closeBtnEl) closeBtnEl.title = t("ui.closeBtnTitle");
  const footerSettingsBtnEl = document.getElementById("imsmassi-footer-settings-btn");
  if (footerSettingsBtnEl) footerSettingsBtnEl.textContent = t("ui.footerSettingsBtn");
}

function renderAssistant() {
  const theme = getTheme();
  const area = getArea();
  const c = getColors();

  // Task 1: 업무영역 컬러를 #assistant-root CSS 변수로 주입
  applyAreaColorVars(area);

  // 플로팅 버튼 — 가시성만 JS로 관리, 색상은 CSS var(--imsmassi-primary) 참조
  const floatingBtn = document.getElementById("imsmassi-floating-btn");
  if (floatingBtn) {
    floatingBtn.classList.toggle("imsmassi-hidden", !!state.assistantOpen);
  }

  // 패널 — 가시성 동기화 + 기본 스타일 세팅
  const panel = document.getElementById("imsmassi-floating-panel");
  if (!panel) return;
  // 탭+패널을 묶는 외부 래퍼의 가시성 토글 (panel-outer 구조 대응)
  const panelOuter = document.getElementById("imsmassi-panel-outer");
  if (panelOuter) {
    panelOuter.classList.toggle("imsmassi-hidden", !state.assistantOpen);
  } else {
    // fallback: 구 구조 대응
    panel.classList.toggle("imsmassi-hidden", !state.assistantOpen);
  }
  // 배경/테두리는 CSS var(--imsmassi-bg), var(--imsmassi-border) 참조
  // 저장된 높이 복원
  if (state.panelHeight) {
    panel.style.height = `${state.panelHeight}px`;
  } else {
    panel.style.height = "";
  }
  // 저장된 너비 복원 (접힌/펼친 상태별 독립 필드 사용)
  const _effectiveWidth = state.isMemoPanelExpanded
    ? (state.panelWidthExpanded || null)
    : (state.panelWidthCollapsed || null);
  panel.style.width = _effectiveWidth ? `${_effectiveWidth}px` : "";
  // 리사이즈 핸들 초기화 (처음 한 번만)
  if (!panel._resizeInited) {
    panel._resizeInited = true;
    initPanelTopLeftResize(panel); // [Task 2] 좌측 상단 통합 리사이즈
  }

  // 정적 HTML 요소 로케일 동기화
  syncStaticLocaleElements();

  if (!state.assistantOpen) return;

  // 헤더 — background/color 는 CSS(.imsmassi-assistant-header) 에서 var 참조
  const header = document.getElementById("imsmassi-assistant-header");
  if (!header) return;
  updateDashboardButton();

  // 푸터 — background/border/color 는 CSS(.imsmassi-assistant-footer) 에서 var 참조
  const footer = document.getElementById("imsmassi-assistant-footer");
  if (!footer) return;

  const footerModes = document.getElementById(
    "imsmassi-assistant-footer-modes",
  );
  if (footerModes) {
    if (state.hiddenUI.darkMode) {
      footerModes.style.display = "";
      // 두 아이콘 pill — 어느 쪽 클릭해도 토글 (CSS mask로 currentColor 연동)
      footerModes.innerHTML = `
        <div class="imsmassi-dark-toggle-pill">
          <button class="imsmassi-dtp-btn${!state.isDarkMode ? " imsmassi-active" : ""}" onclick="setDarkMode(!state.isDarkMode)" title="라이트 모드"><span class="imsmassi-dtp-icon imsmassi-dtp-icon--sun"></span></button>
          <button class="imsmassi-dtp-btn${state.isDarkMode ? " imsmassi-active" : ""}" onclick="setDarkMode(!state.isDarkMode)" title="${t("ui.darkModeLabel")}"><span class="imsmassi-dtp-icon imsmassi-dtp-icon--moon"></span></button>
        </div>
      `;
    } else {
      footerModes.style.display = "none";
      footerModes.innerHTML = "";
    }
  }

  const footerThemes = document.getElementById(
    "imsmassi-assistant-footer-themes",
  );
  if (footerThemes) {
    if (state.hiddenUI.theme) {
      // 테마 컬러 버튼 표시
      footerThemes.style.display = "";
      let themeIconsHtml = "";
      Object.entries(themes).forEach(([key, t]) => {
        const isActive = state.currentTheme === key;
        const activeRing = isActive
          ? `box-shadow: 0 0 0 2px ${state.isDarkMode ? "#FFF" : "#191F28"};`
          : "";
        const sw = THEME_SWATCHES[key] || THEME_SWATCHES.classic;
        const dotColor = isActive ? theme.primary : sw.primary;
        themeIconsHtml += `
          <button class="imsmassi-assistant-footer-theme-btn ${isActive ? "imsmassi-active" : ""}"
                  title="${t.name}"
                  onclick="setTheme('${key}')"
                  style="background: ${dotColor}; border-color: ${c.border}; ${activeRing}"></button>
        `;
      });
      footerThemes.innerHTML = themeIconsHtml;
    } else {
      // 빈 껍데기가 남지 않도록 완전히 숨김
      footerThemes.style.display = "none";
      footerThemes.innerHTML = "";
    }
  }

  updateFooterStorageInfo(c);
  updateStorageEstimate();

  renderAssistantTabs();
  renderAssistantContent();
}

function updateFooterStorageInfo(colors) {
  const storageInfo = document.getElementById("footer-storage-info");
  if (!storageInfo) return;

  const usagePercent =
    state.storageLimit > 0 ? (state.storageUsed / state.storageLimit) * 100 : 0;
  const usedMB = state.storageUsed.toFixed(1);
  const limitMB = state.storageLimit.toFixed(0);
  let statusText = `${usedMB}MB / ${limitMB}MB`;

  // Task 3: 직접 style.color → CSS 클래스 토글
  storageInfo.classList.remove(
    "imsmassi-capacity-warning",
    "imsmassi-capacity-danger",
  );
  if (usagePercent >= 80) {
    statusText = `⚠️ ${usedMB}MB / ${limitMB}MB`;
    storageInfo.classList.add("imsmassi-capacity-danger");
  }

  storageInfo.textContent = statusText;
}

/**
 * 앱 실제 데이터를 JSON으로 직렬화하여 Blob 크기를 측정하고,
 * IndexedDB 오버헤드 1.5배 보정한 추정 용량(MB)를 반환합니다.
 */
function calculateAppUsageMB() {
  try {
    const payload = {
      memos: state.memos,
      stickyNotes: state.stickyNotes,
      clipboard: state.clipboard,
      templates: state.templates,
      menuTimeStats: state.menuTimeStats,
      timeBuckets: state.timeBuckets,
    };
    const bytes = new Blob([JSON.stringify(payload)]).size;
    return (bytes * 1.5) / (1024 * 1024);
  } catch (_) {
    return 0;
  }
}

async function updateStorageEstimate() {
  // Worker 모드: storageUsed/storageLimit 은 Worker가 STATE_UPDATE로 이미 제공합니다.
  // 모든 탭이 동일한 Worker 값을 공유하므로 클라이언트에서 재계산하지 않습니다.
  if (workerPort) {
    updateFooterStorageInfo(getColors());
    return;
  }

  // 폴백 모드 (Worker 연결 없음): 직접 계산
  const limitMB = 50;
  let usedMB = calculateAppUsageMB();

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      if (estimate.usage && estimate.usage > 0) {
        usedMB = estimate.usage / (1024 * 1024);
      }
    }
  } catch (_) {
    // navigator.storage 미지원 환경 → calculateAppUsageMB 폴백 유지
  }

  state.storageUsed = usedMB;
  state.storageLimit = limitMB;

  const c = getColors();
  updateFooterStorageInfo(c);
}

function renderAssistantTabs() {
  const tabsContainer = document.getElementById("imsmassi-assistant-tabs");
  if (!tabsContainer) return;
  // 헤더 버튼 기반 탭 전환으로 이관됨: 사이드 탭 DOM 렌더링 비활성화
  tabsContainer.innerHTML = "";
  tabsContainer.style.display = "none";
}
// [Task 1] 탭 사이드바 하단 사이드 패널 토글 버튼 제거
// 펼치기/접기 기능은 패널 좌측 .imsmassi-btn-collapse-expand 버튼으로 이관됨

function renderAssistantContent(previousTab) {
  const content = document.getElementById("imsmassi-assistant-content");
  if (!content) return;
  const previousScrollTop = content ? content.scrollTop : 0;

  const transitionTabs = new Set(["memo", "dashboard", "settings"]);
  const shouldAnimate =
    transitionTabs.has(previousTab) &&
    transitionTabs.has(state.activeTab) &&
    previousTab !== state.activeTab;

  const renderContent = () => {
    // ASSISTANT_TABS 설정에서 현재 탭의 render 함수를 조회합니다.
    // render()가 DOM 노드를 반환하면 직접 appendChild, 문자열이면 파싱 후 삽입합니다.
    // 이 구조 덕분에 탭 렌더러를 HTML 문자열 또는 DOM 노드 방식으로 자유롭게 전환할 수 있습니다.
    const tabConfig = ASSISTANT_TABS[state.activeTab];
    const result = tabConfig ? tabConfig.render() : renderMemoTab();
    content.innerHTML = "";
    if (result instanceof Node) {
      content.appendChild(result);
    } else {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = result;
      const fragment = document.createDocumentFragment();
      while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);
      content.appendChild(fragment);
    }

    if (state.activeTab === "memo") {
      // 패널 너비를 DOM 삽입 직후 동기적으로 반영 → 첫 페인트 전에 적용되어 움찔거림 방지
      updateMemoSidePanelState();
      setTimeout(() => {
        initMemoEditor();
        initMemoListEditors();
        initInlineMemoEditors();
        focusInlineMemoEditor();
        if (content) content.scrollTop = previousScrollTop;
      }, 0);
    } else if (state.activeTab === "settings") {
      memoQuill = null;
      setTimeout(() => {
        initSettingsTab();
        if (content) content.scrollTop = 0;
      }, 0);
    } else {
      memoQuill = null;
      if (content) content.scrollTop = previousScrollTop;
    }
  };

  if (shouldAnimate) {
    // Task 3: 직접 style 조작 → CSS 클래스 토글로 변경
    content.classList.add(
      "imsmassi-content-transitioning",
      "imsmassi-content-out",
    );
    setTimeout(() => {
      renderContent();
      requestAnimationFrame(() => {
        content.classList.remove("imsmassi-content-out");
      });
    }, 120);
  } else {
    content.classList.remove(
      "imsmassi-content-out",
      "imsmassi-content-transitioning",
    );
    renderContent();
  }
}

// ── [5-C] 대시보드 / 탭 / 패널 컨트롤 ─────────────────────────────────────────
function cycleAssistantTab() {
  const currentIndex = order.indexOf(state.activeTab);
  const nextTab = order[(currentIndex + 1) % order.length];
  setActiveTab(nextTab);
}

// 하위 호환: toggleDashboardView → cycleAssistantTab 위임
function toggleDashboardView() {
  cycleAssistantTab();
}

// ========================================
// 단축키 메뉴얼
// ========================================
function openShortcutManual() {
  openModal("shortcutManual");
}

function updateDashboardButton() {
  const actionsEl = document.querySelector(
    "#assistant-root .imsmassi-assistant-header-actions",
  );
  if (!actionsEl) return;

  // 단축키 메뉴얼 버튼 (탭 그룹 좌측 고정 — hiddenUI.shortcutManual이 true일 때만 표시)
  let manualBtn = actionsEl.querySelector(".imsmassi-shortcut-manual-btn");
  if (!state.hiddenUI?.shortcutManual) {
    // 숨김 상태: 이미 있으면 제거
    if (manualBtn) manualBtn.remove();
    manualBtn = null;
  } else {
    if (!manualBtn) {
      manualBtn = document.createElement("button");
      manualBtn.className = "imsmassi-shortcut-manual-btn";
      manualBtn.onclick = () => openShortcutManual();

      // 탭 그룹 또는 닫기 버튼 앞에 삽입
      const existingTabGroup = actionsEl.querySelector(".imsmassi-header-tab-group");
      const closeBtn2 = actionsEl.querySelector(".imsmassi-assistant-close");
      const insertRef = existingTabGroup || closeBtn2 || null;
      if (insertRef) {
        actionsEl.insertBefore(manualBtn, insertRef);
      } else {
        actionsEl.appendChild(manualBtn);
      }
    }
    // 다국어 라벨 항상 동기화
    manualBtn.title = t("ui.shortcutTitle");
    const manualLabelEl = manualBtn.querySelector(".imsmassi-shortcut-manual-label");
    if (manualLabelEl) {
      manualLabelEl.textContent = t("ui.shortcutBtnLabel");
    } else {
      manualBtn.innerHTML = `<span class="imsmassi-shortcut-manual-icon">⌨</span><span class="imsmassi-shortcut-manual-label">${t("ui.shortcutBtnLabel")}</span>`;
    }
  }

  // 패널 실제 너비가 640px 미만이면 레이블 숨기고 아이콘만 표시
  // offsetWidth는 CSS transition 중 중간값을 반환하므로 state 기반으로 판단
  const isExpanded = !!state.isMemoPanelExpanded;
  const targetWidth = isExpanded
    ? (state.panelWidthExpanded || AssistantConfig.ui.panelMinWidthExpanded)
    : (state.panelWidthCollapsed || AssistantConfig.ui.panelMinWidthCollapsed);
  const isCompact = targetWidth < AssistantConfig.ui.panelMinWidthExpanded;
  if (manualBtn) manualBtn.classList.toggle("imsmassi-compact", isCompact);

  // 헤더 타이틀 글자도 compact 시 숨김 (줄바꿈 방지)
  const floatingPanel = document.querySelector("#assistant-root .imsmassi-floating-panel");
  if (floatingPanel) floatingPanel.classList.toggle("imsmassi-compact", isCompact);

  // 탭 그룹 없으면 동적 생성
  let tabGroup = actionsEl.querySelector(".imsmassi-header-tab-group");
  if (!tabGroup) {
    tabGroup = document.createElement("div");
    tabGroup.className = "imsmassi-header-tab-group";

    const tabs = [
      { id: "memo",      iconClass: "imsmassi-icon-memo",      label: t("ui.tabMemo") },
      { id: "dashboard", iconClass: "imsmassi-icon-dashboard", label: t("ui.tabDashboard") },
      { id: "settings",  iconClass: "imsmassi-icon-settings",  label: t("ui.tabSettings") },
    ];

    tabs.forEach(({ id, iconClass, label }) => {
      const btn = document.createElement("button");
      btn.className = "imsmassi-header-tab-btn";
      btn.dataset.tabId = id;
      btn.title = label;
      btn.innerHTML = `<span class="imsmassi-tab-icon ${iconClass}"></span><span class="imsmassi-tab-label">${label}</span>`;
      btn.onclick = () => setActiveTab(id);
      tabGroup.appendChild(btn);
    });

    const closeBtn = actionsEl.querySelector(".imsmassi-assistant-close");
    if (closeBtn) {
      actionsEl.insertBefore(tabGroup, closeBtn);
    } else {
      actionsEl.appendChild(tabGroup);
    }
  }

  // 현재 탭에 맞게 active 상태 갱신 + 다국어 라벨 동기화
  const tabLabelMap = {
    memo:      t("ui.tabMemo"),
    dashboard: t("ui.tabDashboard"),
    settings:  t("ui.tabSettings"),
  };
  tabGroup.querySelectorAll(".imsmassi-header-tab-btn").forEach((btn) => {
    btn.classList.toggle("imsmassi-active", btn.dataset.tabId === state.activeTab);

    const labelEl = btn.querySelector(".imsmassi-tab-label");
    if (labelEl && tabLabelMap[btn.dataset.tabId]) {
      labelEl.textContent = tabLabelMap[btn.dataset.tabId];
    }
    btn.title = tabLabelMap[btn.dataset.tabId] || btn.title;
  });
}

// ── [5-D] 스타일 초기화 & 부트스트랩 ──────────────────────────────────────────
function initializeStyles() {
  // 이식(embedded) 모드에서 호스트 페이지 바닥화면 보호:
  // getAssistantRoot()가 mf_VFrames_Root 등 호스트 컨테이너를 반환할 수 있으므로
  // #assistant-root 스코프 요소에만 배경/글자색을 적용하고, 호스트 컨테이너에는 미적용.
  const root = getAssistantRoot();
  if (!root) return;

  // data-theme, dark-mode 클래스는 CSS 변수로 자동 처리
  // (handleStateUpdate에서 dataset.theme, classList.toggle 처리 참조)
  // 현재 업무영역 CSS 변수 초기 적용
  applyAreaColorVars(getArea());
}

let assistantInitialized = window.assistantInitialized ?? false;

async function bootstrapAssistant(config = {}) {
  if (window.assistantInitialized) return;
  const root =
    typeof getAssistantRoot === "function"
      ? getAssistantRoot()
      : document.getElementById(
          ASSISTANT_DOM_TARGET?.rootId || "assistant-root",
        );
  if (!root) return;

  window.assistantInitialized = true;
  _assistantConfig = config; // hooks / stickyLayerSelectors 등 IoC config 보존
  assiConsole.log("[Assistant] 초기화 시작 (Shared Worker 모드)...");

  // 1단계: 초기 스타일 적용 (깨짐 방지)
  initializeStyles();

  // 1-1단계: 언어 사전 로드 (renderAll 전에 완료)
  await loadLocale(config.locale || "ko-kr");

  renderAll();

  // 2단계: Shared Worker 연결
  // 초기 컨텍스트(menuId/areaId)를 INIT 페이로드에 포함 → 비동기 레이스 없이 원자적 처리
  // (별도 CONTEXT_CHANGE 메시지를 보내면 INIT의 await ensureInit() 도중 선처리되어 덮어쓰이는 문제 방지)
  const workerPath = config.workerPath || "assistant/assistant-worker.js";
  const _selCfg = config.stickyLayerSelectors;
  const _initialCtx = { locale: config.locale || "ko-kr" };
  if (_selCfg && _selCfg !== false && typeof _selCfg.getMenuId === "function") {
    const _menuId = _selCfg.getMenuId();
    if (_menuId) {
      _initialCtx.menuId = _menuId;
      state.selectedMenu = _menuId;
      if (typeof _selCfg.getAreaId === "function") {
        const _areaId = _selCfg.getAreaId(_menuId);
        if (_areaId) {
          _initialCtx.areaId = _areaId;
          state.selectedArea = _areaId;
        }
      }
      assiConsole.log(
        `[Assistant] 초기 컨텍스트 수집 → menuId: ${_initialCtx.menuId}, areaId: ${_initialCtx.areaId || "-"}`,
      );
    }
  }
  connectToWorker(workerPath, config.loginId, _initialCtx);

  // 2-1단계: UserInfo 암호화 저장 (loginId + getUserInfo 모두 있을 때만)
  if (config.loginId && config.getUserInfo) {
    Promise.resolve().then(() =>
      saveUserInfoToWorker(config.loginId, config.getUserInfo),
    );
  }

  // 포스트잇 드롭 영역 초기화
  initStickyNoteDrop();

  // 3단계: 알림 시스템 초기화
  initReminderSystem();

  // 4단계: sticky-layer 재배치 옵저버
  // config.stickyLayerSelectors = false 로 비활성화 가능
  if (config.stickyLayerSelectors !== false) {
    setupStickyLayerObserver(config.stickyLayerSelectors || {});
  }

  // 5단계: 앱 구동 후 백그라운드 자동 정리 (오래된 데이터 제거)
  setTimeout(() => {
    if (typeof runAutoCleanup === "function") {
      runAutoCleanup({ silent: true, refreshUI: true, reason: "startup" });
    }
  }, AssistantConfig.advanced.startupCleanupDelay);

  assiConsole.log("[Assistant] 초기화 완료 (Shared Worker 연결 중)");
}

window.bootstrapAssistant = bootstrapAssistant;

window.addEventListener("assistant:mounted", (event) => {
  bootstrapAssistant(event.detail || {});
});

// ── 탭 포커스/Visibility 추적 ──────────────────────────────
// 탭이 여러 개 열려 있을 때 비활성 탭은 시간 누적을 중단하여
// 여러 사용자가 쓰는 것처럼 시간이 중복 집계되는 문제를 방지합니다.
(function setupTabActiveTracking() {
  function notifyActive(isActive) {
    if (!window.assistantInitialized) return;
    workerSend("TAB_ACTIVE", { isActive });

  }

  // Page Visibility API: 탭 전환/최소화 감지
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveAllDirtyNotes(); // 탭 비활성화 시 미저장 포스트잇 강제 플러시
    }
    notifyActive(document.visibilityState === "visible");
  });

  // 창 포커스 이벤트: 같은 브라우저 내 다른 창으로 전환 감지
  window.addEventListener("focus", () => notifyActive(true));
  window.addEventListener("blur", () => notifyActive(false));
})();

// 페이지 닫기 전 Worker에 저장 요청
window.addEventListener("beforeunload", () => {
  if (!window.assistantInitialized) return;
  saveAllDirtyNotes(); // 창 닫기 전 미저장 포스트잇 강제 플러시
  // Worker에게 저장 요청 (sync-over-async 불필요, Worker가 자체 처리)
  workerSend("BEFORE_UNLOAD", {});
  stopReminderSystem();
  // sticky-layer 옵저버 및 바운드 리소스 해제
  if (_stickyLayerObserver) {
    _stickyLayerObserver.disconnect();
    _stickyLayerObserver = null;
  }
  if (_stickyLayerResizeObserver) {
    _stickyLayerResizeObserver.disconnect();
    _stickyLayerResizeObserver = null;
  }
});
/**
 * [개발자 도구 전용] 특정 고급 설정 UI 항목 노출/숨김 개별 토글
 * @param {string} key - 'areaColor' | 'timeInsight' | 'markdown' | 'debugLog' | 'autoNav' | 'theme' | 'darkMode' | 'sideTabs' | 'shortcutManual' | 'featureSectionTitle'
 * @param {boolean} visible - 노출 여부 (true: 표시, false: 숨김)
 *
 * 사용 예시 (브라우저 콘솔):
 *   toggleAssistantHiddenUI('sideTabs', false);              // 좌측 사이드 탭 버튼 그룹 숨김
 *   toggleAssistantHiddenUI('sideTabs', true);               // 좌측 사이드 탭 버튼 그룹 표시
 *   toggleAssistantHiddenUI('theme', true);                  // 푸터 테마 UI 표시
 *   toggleAssistantHiddenUI('darkMode', true);               // 푸터 다크모드 버튼 표시
 *   toggleAssistantHiddenUI('areaColor', true);              // 업무 컬러 설정 표시
 *   toggleAssistantHiddenUI('markdown', false);              // 마크다운 단축키 숨김
 *   toggleAssistantHiddenUI('shortcutManual', true);         // 헤더 단축키 메뉴얼 버튼 표시
 *   toggleAssistantHiddenUI('featureSectionTitle', false);   // 기능 설정 섹션 타이틀 숨김
 */
window.toggleAssistantHiddenUI = function (key, visible = true) {
  // 상태 안전성 검사
  if (!state.hiddenUI) {
    state.hiddenUI = {
      areaColor: false,
      timeInsight: false,
      markdown: false,
      debugLog: false,
      autoNav: false,
      theme: false,
      darkMode: false,
      sideTabs: false,
      shortcutManual: false,
      featureSectionTitle: true,
    };
  }

  if (key in state.hiddenUI) {
    state.hiddenUI[key] = !!visible;
    assiConsole.log(
      `[Assistant] 설정 UI '${key}' 상태가 ${visible ? "표시" : "숨김"}로 변경되었습니다.`,
    );

    // sideTabs 변경 시 탭 사이드바 즉각 반영
    if (key === "sideTabs") {
      renderAssistantTabs();
      return;
    }

    // shortcutManual 버튼 변경 시 헤더 즉각 반영
    if (key === "shortcutManual") {
      updateDashboardButton();
      return;
    }

    // darkMode 버튼 변경 시 패널 푸터 즉각 반영
    if (key === "darkMode" || key === "theme") {
      renderAssistant();
      return;
    }

    // UI 즉각 반영 (설정 모달이 열려있거나 설정 탭인 경우 리렌더링)
    if (state.currentModal === "settings") {
      openModal("settings");
    } else if (state.activeTab === "settings") {
      renderAssistantContent();
    }
  } else {
    assiConsole.warn(
      `[Assistant] 유효하지 않은 키입니다. 사용 가능한 키: ${Object.keys(state.hiddenUI).join(", ")}`,
    );
  }
};

/**
 * [개발자 도구 전용] 모든 기능 설정 UI 항목을 한 번에 노출/숨김
 * @param {boolean} visible - true: 전체 표시, false: 전체 숨김 (기본값: true)
 *
 * 사용 예시 (브라우저 콘솔):
 *   showAllAssistantHiddenUI();       // 모두 표시
 *   showAllAssistantHiddenUI(false);  // 모두 숨김
 */
window.showAllAssistantHiddenUI = function (visible = true) {
  if (!state.hiddenUI) return;
  Object.keys(state.hiddenUI).forEach((key) => {
    state.hiddenUI[key] = !!visible;
  });
  assiConsole.log(
    `[Assistant] 모든 설정 UI 항목이 ${visible ? "표시" : "숨김"}로 변경되었습니다.`,
  );
  // sideTabs 포함 시 사이드바 즉각 반영
  renderAssistantTabs();
  if (state.currentModal === "settings") {
    openModal("settings");
  } else if (state.activeTab === "settings") {
    renderAssistantContent();
  }
};

// ========================================
// 패널 좌측 상단 통합 리사이즈 (대각선)
// ========================================
function initPanelTopLeftResize(panel) {
  // 기존 핸들이 있으면 제거
  const existing = panel.querySelector(".imsmassi-panel-resize-handle-nw");
  if (existing) existing.remove();

  const handle = document.createElement("div");
  handle.className = "imsmassi-panel-resize-handle-nw";
  handle.title = "크기 조절 (더블클릭: 기본값 복원)";
  panel.appendChild(handle);

  const MIN_H = 300;
  const MAX_H_OFFSET = 64;
  const MAX_W_RATIO = 0.85;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;

    // [Task 3] 드래그 중 transition 무력화로 고무줄 현상 방지
    const root = document.getElementById("assistant-root");
    if (root) root.classList.add("imsmassi-resizing");

    function onMove(ev) {
      // 너비 계산 (왼쪽으로 당기면 너비 증가)
      const MIN_W = panel.classList.contains("imsmassi-expanded")
        ? AssistantConfig.ui.panelMinWidthExpanded
        : AssistantConfig.ui.panelMinWidthCollapsed;
      const deltaX = startX - ev.clientX;
      const newW = Math.min(
        Math.max(startW + deltaX, MIN_W),
        Math.floor(window.innerWidth * MAX_W_RATIO),
      );

      // 높이 계산 (위로 당기면 높이 증가)
      const deltaY = startY - ev.clientY;
      const newH = Math.min(
        Math.max(startH + deltaY, MIN_H),
        window.innerHeight - MAX_H_OFFSET,
      );

      // 상태 저장 및 DOM 업데이트
      state.panelWidth = newW;
      state.panelHeight = newH;
      // 접힌/펼친 상태별 독립 필드에도 저장
      if (state.isMemoPanelExpanded) {
        state.panelWidthExpanded = newW;
      } else {
        state.panelWidthCollapsed = newW;
      }
      panel.style.width = `${newW}px`;
      panel.style.height = `${newH}px`;
      // [Issue 3] memo-main max-width 실시간 동기화 (fixed 포지셔닝 보정)
      const memoMain = document.querySelector("#assistant-root .imsmassi-memo-main");
      if (memoMain) memoMain.style.maxWidth = `${newW - 25}px`;
      // 단축키 메뉴얼 버튼 compact 여부 실시간 갱신
      updateDashboardButton();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // [Task 3] 드래그 종료 후 transition 복원
      if (root) root.classList.remove("imsmassi-resizing");
      if (workerPort) {
        workerSend("SAVE_UI_PREFS", {
          panelWidth: state.panelWidth,
          panelWidthCollapsed: state.panelWidthCollapsed ?? null,
          panelWidthExpanded: state.panelWidthExpanded ?? null,
          panelHeight: state.panelHeight,
        });
      } else if (db) {
        // 폴백 모드: IndexedDB 직접 저장
        db.transaction("settings", "readwrite", (store) => {
          store.put(state.panelWidth ?? null, "panelWidth");
          store.put(state.panelWidthCollapsed ?? null, "panelWidthCollapsed");
          store.put(state.panelWidthExpanded ?? null, "panelWidthExpanded");
          store.put(state.panelHeight ?? null, "panelHeight");
        }).catch((e) => assiConsole.warn("[resize] 패널 크기 저장 실패:", e));
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // 더블클릭: 가로/세로 모두 기본값 복원
  handle.addEventListener("dblclick", () => {
    state.panelWidth = null;
    state.panelWidthCollapsed = null;
    state.panelWidthExpanded = null;
    state.panelHeight = null;
    panel.style.width = "";
    panel.style.height = "";
    const memoMain = document.querySelector("#assistant-root .imsmassi-memo-main");
    if (memoMain) memoMain.style.maxWidth = ""; // CSS 기본값 복원
    workerSend("SAVE_UI_PREFS", { panelWidth: null, panelWidthCollapsed: null, panelWidthExpanded: null, panelHeight: null });
  });
}

// ========================================
// 온보딩 가이드 (5단계)
// ========================================
const AssistantGuide = {
  // ── 각 단계 정의 ──────────────────────────────────────────────────────────────
  // setup()   : 해당 단계를 보여주기 직전에 항상 실행 (next/prev 방향 무관)
  // 공통 헬퍼는 AssistantGuide._ensurePanel() 등을 사용
  steps: [
    /* ─── STEP 1 : 플로팅 버튼 ──────────────────────────────────────────── */
    {
      targetSelector: "#imsmassi-floating-btn",
      get title() { return t("onboarding.step1Title"); },
      get description() { return t("onboarding.step1Desc"); },
      setup: async function () {
        AssistantGuide._removeDemoPostit();
        // 패널이 열려 있으면 닫아야 플로팅 버튼이 보임
        if (state.assistantOpen) {
          closeAssistant();
          await AssistantGuide._wait(400);
        }
        if (state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await AssistantGuide._wait(200);
        }
      },
    },
    /* ─── STEP 2 : 메모 입력창 ──────────────────────────────────────────── */
    {
      targetSelector:
        "#memo-editor-wrapper .ql-editor, #memo-input, #memo-editor-wrapper, .imsmassi-memo-quill-wrapper",
      get title() { return t("onboarding.step2Title"); },
      get description() { return t("onboarding.step2Desc"); },
      setup: async function () {
        AssistantGuide._removeDemoPostit();
        await AssistantGuide._ensurePanel();
        if (state.activeTab !== "memo") {
          setActiveTab("memo");
          await AssistantGuide._wait(350);
        }
        if (state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await AssistantGuide._wait(200);
        }
      },
    },
    /* ─── STEP 3 : 포스트잇 데모 ────────────────────────────────────────── */
    {
      targetSelector: '[data-guide-demo="postit"]',
      get title() { return t("onboarding.step3Title"); },
      get description() { return t("onboarding.step3Desc"); },
      setup: async function () {
        await AssistantGuide._ensurePanel();
        if (state.activeTab !== "memo") {
          setActiveTab("memo");
          await AssistantGuide._wait(350);
        }
        if (state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await AssistantGuide._wait(200);
        }
        // 기존 데모 포스트잇 제거 후 새로 생성
        AssistantGuide._removeDemoPostit();
        AssistantGuide._createDemoPostit();
        await AssistantGuide._wait(250);
      },
    },
    /* ─── STEP 4 : 클립보드 & 템플릿 ────────────────────────────────────── */
    {
      targetSelector: "#memo-side-panel",
      get title() { return t("onboarding.step4Title"); },
      get description() { return t("onboarding.step4Desc"); },
      setup: async function () {
        AssistantGuide._removeDemoPostit();
        await AssistantGuide._ensurePanel();
        if (state.activeTab !== "memo") {
          setActiveTab("memo");
          await AssistantGuide._wait(350);
        }
        // step 4는 사이드 패널을 열어서 보여줌
        if (!state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await AssistantGuide._wait(300);
        }
      },
    },
    /* ─── STEP 5 : 리마인더 (대시보드) ──────────────────────────────────── */
    {
      targetSelector: "#imsmassi-dashboard-today",
      get title() { return t("onboarding.step5Title"); },
      get description() { return t("onboarding.step5Desc"); },
      setup: async function () {
        AssistantGuide._removeDemoPostit();
        await AssistantGuide._ensurePanel();
        if (state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await AssistantGuide._wait(200);
        }
        setActiveTab("dashboard");
        await AssistantGuide._wait(450);
        const todayEl = document.getElementById("imsmassi-dashboard-today");
        if (todayEl) {
          todayEl.scrollIntoView({ behavior: "smooth", block: "start" });
          await AssistantGuide._wait(200);
        }
      },
    },
  ],

  // ── 내부 상태 ────────────────────────────────────────────────────────────────
  currentStep: 0,
  overlayEl: null,
  spotlightEl: null,
  tooltipEl: null,
  _resizeHandler: null,
  _active: false,
  _padding: 10,
  _demoPostitEl: null,

  // ── 공개 API ──────────────────────────────────────────────────────────────────
  async start() {
    if (this._active) return;
    this._active = true;
    this.currentStep = 0;
    this._createDOM();
    await this._gotoStep(0);
    assiConsole.log("[Assistant] 온보딩 가이드 시작");
  },

  async next() {
    if (!this._active) return;
    if (this.currentStep < this.steps.length - 1) {
      await this._gotoStep(this.currentStep + 1);
    } else {
      this._finish();
    }
  },

  async prev() {
    if (!this._active) return;
    if (this.currentStep > 0) {
      await this._gotoStep(this.currentStep - 1);
    }
  },

  skip() {
    this._finish();
  },

  replay() {
    this._active = false;
    this._cleanup();
    this._removeDemoPostit();
    _guideTriggered = true; // handleStateUpdate 재트리거 방지
    // 모달 → 패널 닫고, 플로팅 버튼이 노출된 상태에서 가이드 시작 (step 1 타겟)
    closeModal();
    setTimeout(() => {
      closeAssistant();
      setTimeout(() => this.start(), 300);
    }, 120);
  },

  // ── 내부 헬퍼 ──────────────────────────────────────────────────────────────────
  /** n ms 대기 */
  _wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  /** 패널이 닫혀 있으면 열기 */
  async _ensurePanel() {
    if (!state.assistantOpen) {
      openAssistant();
      await this._wait(450);
    }
  },

  /** 단계 이동 핵심 함수 — setup 실행 후 렌더링 */
  async _gotoStep(idx) {
    this.currentStep = idx;
    const step = this.steps[idx];
    if (typeof step.setup === "function") {
      await step.setup();
    }
    // 가이드가 skip/finish 됐으면 렌더 중단
    if (!this._active) return;
    this._renderStep();
  },

  // ── DOM 생성/렌더 ──────────────────────────────────────────────────────────────
  _createDOM() {
    this._cleanup();
    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "imsmassi-guide-overlay";

    this.spotlightEl = document.createElement("div");
    this.spotlightEl.className = "imsmassi-guide-spotlight";

    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "imsmassi-guide-tooltip";

    document.body.appendChild(this.overlayEl);
    document.body.appendChild(this.spotlightEl);
    document.body.appendChild(this.tooltipEl);

    this._resizeHandler = () => this._positionElements();
    window.addEventListener("resize", this._resizeHandler);
    window.addEventListener("scroll", this._resizeHandler, true);
  },

  _getTarget(selector) {
    if (!selector) return null;
    // 어시스턴트 패널 내부를 먼저 탐색 (외부 시스템 DOM과 셀렉터 충돌 방지)
    const panelEl =
      document.getElementById("imsmassi-floating-panel") ||
      document.getElementById("assistant-root");

    const selList = selector.split(",").map((s) => s.trim());

    // 1차: 패널 스코프 내 탐색
    if (panelEl) {
      for (const sel of selList) {
        try {
          const el = panelEl.querySelector(sel);
          if (el) return el;
        } catch (_) {
          /* 잘못된 selector는 무시 */
        }
      }
    }

    // 2차: document 전체 탐색 (sticky layer 등 패널 외부 요소)
    for (const sel of selList) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {
        /* 잘못된 selector는 무시 */
      }
    }
    return null;
  },

  _renderStep() {
    if (!this.tooltipEl) return;
    const step = this.steps[this.currentStep];
    const total = this.steps.length;
    const isLast = this.currentStep === total - 1;
    const isFirst = this.currentStep === 0;

    // transition 없이 즉시 스냅 위치 → 좌표 불일치 방지
    const target = this._getTarget(step.targetSelector);
    this._positionSpotlight(target, false);

    const dots = Array.from(
      { length: total },
      (_, i) =>
        `<span class="imsmassi-guide-dot${i === this.currentStep ? " imsmassi-guide-dot-active" : ""}"></span>`,
    ).join("");

    this.tooltipEl.innerHTML = `
      <div class="imsmassi-guide-progress">${dots}</div>
      <div class="imsmassi-guide-title">${step.title}</div>
      <div class="imsmassi-guide-desc">${step.description}</div>
      <div class="imsmassi-guide-controls">
        <button class="imsmassi-guide-btn imsmassi-guide-btn-skip" onclick="AssistantGuide.skip()">${t("onboarding.btnSkip")}</button>
        <div class="imsmassi-guide-nav">
          ${!isFirst ? `<button class="imsmassi-guide-btn imsmassi-guide-btn-prev" onclick="AssistantGuide.prev()">${t("onboarding.btnPrev")}</button>` : ""}
          <button class="imsmassi-guide-btn imsmassi-guide-btn-next${isLast ? " imsmassi-guide-btn-finish" : ""}" onclick="AssistantGuide.next()">
            ${isLast ? t("onboarding.btnStart") : t("onboarding.btnNext")}
          </button>
        </div>
      </div>
    `;

    // tooltip 위치 + spotlight 재확인(레이아웃 완료 후)
    requestAnimationFrame(() => {
      const t = this._getTarget(step.targetSelector);
      this._positionSpotlight(t, false);
      this._positionTooltip(t);
    });
  },

  _positionElements() {
    if (!this._active) return;
    const step = this.steps[this.currentStep];
    const target = this._getTarget(step.targetSelector);
    this._positionSpotlight(target, true); // 스크롤/리사이즈는 부드러운 이동
    this._positionTooltip(target);
  },

  /**
   * @param {Element|null} target
   * @param {boolean} animate - true: transition 사용(scroll/resize), false: 즉시 스냅(단계 전환)
   */
  _positionSpotlight(target, animate = true) {
    if (!this.spotlightEl) return;
    const transition = animate
      ? "transition:top 0.3s ease,left 0.3s ease,width 0.3s ease,height 0.3s ease"
      : "transition:none";
    if (!target) {
      this.spotlightEl.style.cssText =
        `position:fixed;top:50%;left:50%;width:0;height:0;border-radius:8px;` +
        `box-shadow:0 0 0 9999px rgba(0,0,0,0.65);z-index:99999;pointer-events:none;${transition};`;
      return;
    }
    const r = target.getBoundingClientRect();
    const p = this._padding;
    this.spotlightEl.style.cssText = [
      "position:fixed",
      `top:${r.top - p}px`,
      `left:${r.left - p}px`,
      `width:${r.width + p * 2}px`,
      `height:${r.height + p * 2}px`,
      "border-radius:8px",
      "box-shadow:0 0 0 9999px rgba(0,0,0,0.65)",
      "z-index:99999",
      "pointer-events:none",
      transition,
    ].join(";");
  },

  _positionTooltip(target) {
    if (!this.tooltipEl) return;
    const tw = this.tooltipEl.offsetWidth || 290;
    const th = this.tooltipEl.offsetHeight || 190;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const p = this._padding;
    const gap = 18;
    let top, left;

    if (!target) {
      top = vh / 2 - th / 2;
      left = vw / 2 - tw / 2;
    } else {
      const r = target.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      if (r.bottom + p + gap + th <= vh) {
        top = r.bottom + p + gap;
        left = cx - tw / 2;
      } else if (r.top - p - gap - th >= 0) {
        top = r.top - p - gap - th;
        left = cx - tw / 2;
      } else if (r.right + p + gap + tw <= vw) {
        top = r.top + r.height / 2 - th / 2;
        left = r.right + p + gap;
      } else {
        top = r.top + r.height / 2 - th / 2;
        left = r.left - p - gap - tw;
      }
      left = Math.max(16, Math.min(left, vw - tw - 16));
      top = Math.max(16, Math.min(top, vh - th - 16));
    }
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  },

  // ── 데모 포스트잇 ──────────────────────────────────────────────────────────────
  _createDemoPostit() {
    this._removeDemoPostit();
    const el = document.createElement("div");
    el.setAttribute("data-guide-demo", "postit");
    // 픽셀 좌표로 직접 정렬: transform/animation 충돌 방지
    const postitW = 230;
    const postitH = 120;
    const postitTop = Math.round(window.innerHeight / 2 - postitH / 2);
    const postitLeft = Math.round(window.innerWidth / 2 - postitW / 2);
    el.style.cssText = [
      "position:fixed",
      `top:${postitTop}px`,
      `left:${postitLeft}px`,
      `width:${postitW}px`,
      "min-height:90px",
      "background:#FFFDE7",
      "border-radius:10px",
      "border-top:4px solid #FFD54F",
      "box-shadow:0 6px 24px rgba(0,0,0,0.22)",
      "padding:14px 18px 16px",
      "z-index:98000",
      "font-size:13px",
      "color:#333",
      "line-height:1.6",
      "pointer-events:none",
    ].join(";");
    el.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;color:#E65100;font-size:12px;">${t("onboarding.exampleStickyTitle")}</div>
      <div style="font-size:12px;color:#555;">
        ${t("onboarding.exampleItem1")}<br>
        ${t("onboarding.exampleItem2")}<br>
        ${t("onboarding.exampleItem3")}
      </div>
    `;
    document.body.appendChild(el);
    this._demoPostitEl = el;
  },

  _removeDemoPostit() {
    if (this._demoPostitEl) {
      this._demoPostitEl.remove();
      this._demoPostitEl = null;
    }
    document
      .querySelectorAll('[data-guide-demo="postit"]')
      .forEach((el) => el.remove());
  },

  // ── 종료 & 정리 ────────────────────────────────────────────────────────────────
  _finish() {
    this._active = false;
    this._removeDemoPostit();
    this._cleanup();
    workerSend("MARK_GUIDE_SEEN", {});
    state.hasSeenGuide = true;
    assiConsole.log("[Assistant] 온보딩 가이드 완료");
  },

  _cleanup() {
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    if (this.spotlightEl) {
      this.spotlightEl.remove();
      this.spotlightEl = null;
    }
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      window.removeEventListener("scroll", this._resizeHandler, true);
      this._resizeHandler = null;
    }
  },
};

// ============================================================================
// [Section 6] FEATURE: MEMO & STICKY NOTES  📝 메모 및 포스트잇
// ============================================================================
// [6-A] 메모 액션: addMemo, togglePin, confirmDeleteMemo, copyMemoToCurrentContext
// [6-B] 메모 에디터: initMemoEditor, initInlineMemoEditors, saveInlineMemoEdit
// [6-C] 포스트잇: addStickyNote, renderStickyNotes, enableStickyNoteDrag, relocateStickyLayer
// [6-D] 메모 렌더링: renderMemoItemDOM, renderMemoTab, setMemoFilter
// ============================================================================
// ============================================================================

// ── [6-A] 메모 액션 ───────────────────────────────────────────────────────────
async function addMemo() {
  const memoInput = document.getElementById("memo-input");
  const snapshot = getMemoEditorSnapshot(memoQuill, memoInput);

  if (!state.selectedMenu) {
    showToast(t("system.menuNotSelected"));
    return;
  }

  if (snapshot.isEmpty) {
    showToast(t("system.memoContentRequired"));
    return;
  }

  // 앱 전체 용량 제한 검사 (50MB)
  if (state.storageUsed >= state.storageLimit) {
    showToast(t("system.storageExceeded"));
    return;
  }

  // 용량 초과 체크 (2MB 제한)
  const MEMO_LIMIT = 2 * 1024 * 1024; // 2MB in bytes
  const useRichText = !!memoQuill;
  const contentForSize = useRichText ? snapshot.html : snapshot.text;
  const currentSize = new Blob([contentForSize]).size;
  if (currentSize > MEMO_LIMIT) {
    showToast(t("system.memo2mbExceeded"));
    return;
  }

  // 새로운 메모 객체 (시퀀스 기반 ID)
  const memoId = generateMemoId();
  const newMemo = {
    title: "", // 메모 제목 (알림 제목 통합)
    content: useRichText ? sanitizeHtml(snapshot.html) : snapshot.text.trim(),
    pinned: false,
    createdAreaId: state.selectedArea, // 원본 생성 위치
    menuId: state.selectedMenu,
    labels: [state.selectedMenu], // 현재 menuId만 포함
    reminder: null,
    date: toLocalDateStr(),
    isRichText: useRichText,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Worker에 ADD_MEMO 전송 (DB 저장 + 상태 브로드캐스트)
  if (workerPort) {
    workerSend("ADD_MEMO", { memoId, memoData: newMemo });
  } else if (db) {
    // 폴백 모드: IndexedDB 직접 저장 후 로컬 state 갱신
    try {
      await db.addMemo(memoId, newMemo);
      state.memos = state.memos || {};
      state.memos[memoId] = { ...newMemo, id: memoId };
      assiConsole.log("[addMemo] 폴백 저장 완료:", memoId);
      showToast(t("system.memoSaveSuccess"));
      // 에디터 초기화 후 리스트 갱신 (아래 로직 진행 후 renderAssistantContent)
    } catch (e) {
      console.error("[addMemo] 저장 실패:", e);
      showToast(t("system.memoSaveFail"));
      return; // 실패 시 에디터 초기화 없이 종료
    }
  } else {
    assiConsole.warn("[addMemo] Worker도 DB도 준비되지 않았습니다");
    showToast(t("system.storageNotInitialized"));
    return;
  }

  // 에디터 즉시 초기화 (UI-only 로컬 처리)
  if (memoQuill) {
    memoQuill.setText("");
    state.memoDraftHtml = "";
    state.memoDraftText = "";
  } else if (memoInput) {
    memoInput.innerText = "";
  }
  updateMemoCapacity();

  // 폴백 모드에서는 Worker STATE_UPDATE가 없으므로 직접 리스트 갱신
  if (!workerPort) {
    renderAssistantContent();
  }
}

// ========================================
// 메모 입력 이벤트 핸들러
// ========================================
function handleMemoKeydown(event) {
  // Ctrl+Enter로 메모 추가
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    addMemo();
    return;
  }

  if (event.key === "Backspace") {
    const memoInput = document.getElementById("memo-input");
    if (normalizeEmptyMemoEditor(null, memoInput)) {
      event.preventDefault();
      updateMemoCapacity();
    }
  }
}

function updateMemoCapacity() {
  // 메모 용량 표시 업데이트 (2MB 제한)
  const memoInput = document.getElementById("memo-input");
  const capacityDisplay = document.getElementById("imsmassi-memo-capacity");

  if (!capacityDisplay) return;
  if (!memoInput && !memoQuill) return;

  const MEMO_LIMIT = 2 * 1024 * 1024; // 2MB

  let currentSize = 0;

  // Quill 에디터 사용 시 - 이미지가 있으면 HTML, 없으면 텍스트 사용
  if (memoQuill && memoQuill.root) {
    const html = memoQuill.root.innerHTML || "";
    const hasImage = html.includes("img") || html.includes("data:");

    if (hasImage) {
      // 이미지가 있으면 HTML 전체 크기로 계산 (base64 포함)
      currentSize = new Blob([html]).size;
    } else {
      // 이미지가 없으면 텍스트만 계산
      const text = memoQuill.getText() || "";
      currentSize = new Blob([text]).size;
    }
  }
  // contenteditable 사용 시
  else if (memoInput) {
    const text = memoInput.innerText || "";
    currentSize = new Blob([text]).size;
  }

  const percent = ((currentSize / MEMO_LIMIT) * 100).toFixed(1);

  // 용량 포맷팅
  let sizeText = "";
  if (currentSize < 1024) {
    sizeText = currentSize + " B";
  } else if (currentSize < 1024 * 1024) {
    sizeText = (currentSize / 1024).toFixed(1) + " KB";
  } else {
    sizeText = (currentSize / (1024 * 1024)).toFixed(2) + " MB";
  }

  // Task 3: 직접 style.color 주입 → CSS 클래스 토글
  const c = getColors();
  capacityDisplay.classList.remove(
    "imsmassi-capacity-warning",
    "imsmassi-capacity-danger",
  );
  if (percent > 90) {
    capacityDisplay.classList.add("imsmassi-capacity-danger");
    capacityDisplay.textContent = `⚠️ ${sizeText} / 2 MB (${percent}%)`;
  } else if (percent > 70) {
    capacityDisplay.classList.add("imsmassi-capacity-warning");
    capacityDisplay.textContent = `${sizeText} / 2 MB (${percent}%)`;
  } else {
    capacityDisplay.textContent = `${sizeText} / 2 MB`;
  }

  // 용량 초과 시 입력 방지
  if (currentSize > MEMO_LIMIT) {
    if (memoQuill) {
      const length = memoQuill.getLength();
      if (length > 1) {
        memoQuill.deleteText(length - 2, 1, "silent");
      }
    } else {
      memoInput.innerText = memoInput.innerText.slice(0, -1);
    }
    showToast(t("system.memoSizeExceeded"));
  }
}

function handleMemoPaste(event) {
  // 붙여넣기 시 테이블/텍스트 처리
  event.preventDefault();

  const html = event.clipboardData.getData("text/html");
  const text = event.clipboardData.getData("text/plain");

  // 메모 용량 제한 확인 (2MB)
  const MEMO_LIMIT = 2 * 1024 * 1024; // 2MB
  const memoInput = document.getElementById("memo-input");
  const currentSize = new Blob([memoInput.innerText]).size;
  const pastingSize = new Blob([text]).size;

  if (currentSize + pastingSize > MEMO_LIMIT) {
    showToast(t("system.memoSizeExceeded"));
    return;
  }

  // 1. HTML 테이블인 경우 - 그대로 삽입
  if (html.includes("<table")) {
    document.execCommand("insertHTML", false, html);
    return;
  }

  // 2. 일반 텍스트 - 그냥 삽입
  document.execCommand("insertText", false, text);
}

function openDeleteConfirmModal(memoId) {
  if (!memoId) {
    console.error("[openDeleteConfirmModal] memoId가 없습니다");
    showToast(t("system.memoIdFindFail"));
    return;
  }

  const memo = state.memos[memoId];
  if (!memo) {
    console.error("[openDeleteConfirmModal] 메모를 찾을 수 없습니다:", memoId);
    showToast(t("system.memoFindFail"));
    return;
  }

  state.currentMemoId = memoId;
  openModal("deleteConfirm", { memoId: memoId });
  assiConsole.log("[openDeleteConfirmModal] 삭제 확인 모달 열음:", memoId);

  // 리마인더가 설정되어 있으면 모달에 표시
  setTimeout(() => {
    const reminderDisplay = document.getElementById(
      "modal-delete-reminder-display",
    );
    if (reminderDisplay && memo.reminder) {
      reminderDisplay.innerHTML = `<div style="padding: 8px 12px; background: rgba(230, 126, 34, 0.1); border-left: 3px solid #E67E22; border-radius: 4px; margin: 8px 0; font-size: 13px;">
        <strong>${ICONS.time} 알림 설정됨:</strong><br>
        ${memo.reminder}
      </div>`;
    } else if (reminderDisplay) {
      reminderDisplay.innerHTML = "";
    }
  }, 100);
}

function confirmDeleteMemo() {
  const memoId = state.currentMemoId;
  if (!memoId) {
    showToast(t("system.memoFindFail"));
    return;
  }
  if (!state.memos[memoId]) {
    showToast(t("system.memoFindFail"));
    state.currentMemoId = null;
    closeModal();
    return;
  }
  // Worker에 DELETE_MEMO 전송 → STATE_UPDATE 수신 후 자동 재렌더
  workerSend("DELETE_MEMO", { memoId });
  state.currentMemoId = null;
  closeModal();
}

function cancelDeleteMemo() {
  assiConsole.log("[cancelDeleteMemo] 삭제 취소");
  state.currentMemoId = null;
  closeModal();
}

function togglePin(memoId) {
  const memo = state.memos[memoId];
  if (!memo) {
    showToast(t("system.memoFindFail"));
    return;
  }
  workerSend("TOGGLE_PIN", { memoId });
}

function toggleTemplatePin(templateId) {
  workerSend("TOGGLE_TEMPLATE_PIN", { templateId });
}

// 고정 기능 디버깅 헬퍼
async function confirmAddTag() {
  const input = document.getElementById("modal-tag-input");
  const tag = input.value.trim();

  if (!tag) {
    showToast(t("system.tagNameRequired"));
    return;
  }

  const memoId = state.currentMemoId;
  const memo = state.memos[memoId];

  if (!memo) {
    showToast(t("system.memoFindFail"));
    closeModal();
    return;
  }

  if (memo.tags && memo.tags.includes(tag)) {
    showToast(t("system.tagDuplicate"));
    return;
  }

  if (!memo.tags) memo.tags = [];
  memo.tags.push(tag);
  // Worker에 태그 포함 메모 저장
  workerSend("SAVE_INLINE_EDIT", {
    memoId,
    content: memo.content,
    isRichText: memo.isRichText,
    meta: { tags: memo.tags },
  });
  renderAssistantContent();
  showToast(t("system.tagAdded", { tag }));
  closeModal();
}

// ========================================
// 클립보드 기능: 저장된 항목을 시스템 클립보드에 복사
// ========================================
function copyToClipboard(content) {
  if (!content || typeof content !== "string") {
    assiConsole.warn("[copyToClipboard] Invalid content:", content);
    showToast(t("system.nothingToCopy"));
    return false;
  }

  // 내부 클립보드에 즉시 반영 (복사 성공 여부와 무관하게 기록)
  addClipboardItem(content);

  // ① 현대 Clipboard API (포커스 빼앗지 않음)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        assiConsole.log(
          "[copyToClipboard] Clipboard API 복사:",
          content.substring(0, 30),
        );
        showToast(t("system.clipboardCopySuccess", { preview: content.substring(0, 20) + (content.length > 20 ? "..." : "") }));
      })
      .catch((err) => {
        assiConsole.warn(
          "[copyToClipboard] Clipboard API 실패, fallback 사용:",
          err,
        );
        _copyToClipboardFallback(content);
      });
    return true;
  }

  // ② fallback: execCommand (포커스 복구 포함)
  return _copyToClipboardFallback(content);
}

function _copyToClipboardFallback(content) {
  // 복사 전 포커스 엘리먼트 저장 (Quill 에디터 포커스 보호)
  const prevFocused = document.activeElement;

  const tempElement = document.createElement("textarea");
  tempElement.value = content;
  tempElement.style.cssText =
    "position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:-9999;";
  getAssistantRoot().appendChild(tempElement);

  // quill-better-table 등 외부 라이브러리가 document 레벨 copy 이벤트를 가로채
  // null.table 접근 오류를 일으키는 문제를 방지:
  // 캡처 단계(capture phase)에서 먼저 실행하여 clipboardData를 직접 채우고
  // stopImmediatePropagation()으로 이후 모든 리스너 실행을 차단한다.
  const guardCopyHandler = (e) => {
    e.stopImmediatePropagation();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", content);
      e.preventDefault();
    }
  };
  document.addEventListener("copy", guardCopyHandler, { capture: true });

  try {
    tempElement.focus();
    tempElement.select();
    tempElement.setSelectionRange(0, 99999);
    const success = document.execCommand("copy");
    if (success) {
      assiConsole.log(
        "[copyToClipboard] execCommand 복사:",
        content.substring(0, 30),
      );
      showToast(t("system.clipboardCopySuccess", { preview: content.substring(0, 20) + (content.length > 20 ? "..." : "") }));
      return true;
    } else {
      console.error("[copyToClipboard] execCommand 실패");
      showToast(t("system.clipboardCopyFail"));
      return false;
    }
  } catch (error) {
    console.error("[copyToClipboard] 예외 발생:", error);
    showToast(t("system.clipboardCopyFail"));
    return false;
  } finally {
    document.removeEventListener("copy", guardCopyHandler, { capture: true });
    getAssistantRoot().removeChild(tempElement);
    // 포커스 복구 (Quill 에디터 등 이전 포커스 상태로 되돌림)
    if (prevFocused && typeof prevFocused.focus === "function") {
      try {
        prevFocused.focus();
      } catch (e) { assiConsole.warn("[복사] 이전 포커스 복구 실패", e); }
    }
  }
}

function addCurrentAreaLabel(memoId) {
  const memo = state.memos[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  if (memo.labels?.includes(currentMenu)) {
    showToast(t("system.memoLabelAlreadyAdded", { currentMenu }));
    return;
  }
  workerSend("TOGGLE_LABEL", { memoId, menuId: currentMenu, force: true });
}

function toggleCurrentAreaLabel(memoId) {
  const memo = state.memos[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  if (!memo.labels) memo.labels = [];
  workerSend("TOGGLE_LABEL", { memoId, menuId: currentMenu });
}

// 업무 화면의 메모를 현재 컨텍스트로 복사 (reminder/done 상태 초기화)
function copyMemoToCurrentContext(memoId) {
  const targetMenuId = state.selectedMenu;
  const targetAreaId = state.selectedArea;
  if (!targetMenuId) {
    showToast(t("system.menuNotSelected"));
    return;
  }
  workerSend('COPY_MEMO', { memoId, targetMenuId, targetAreaId });
}

// 개별 알림 읽음 토글
function toggleNotificationRead(notifId) {
  workerSend('MARK_NOTIFICATION_READ', { notifId });
}

// 모든 알림 읽음 처리
function markAllNotificationsRead() {
  workerSend('MARK_ALL_NOTIFICATIONS_READ', {});
}

// 알림 발송 시각 상대적 표시 (firedAt ms 타임스탬프 입력)
function formatNotifTime(firedAt) {
  const diffMs = Date.now() - firedAt;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('timeInsight.justNow');
  if (diffMin < 60) return t('timeInsight.nMinutesAgo', { n: diffMin });
  const diffHours = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffHours < 24) return t('timeInsight.nHoursAgo', { hours: diffHours, minutes: remMin });
  return t('timeInsight.nDaysAgo', { n: Math.floor(diffHours / 24) });
}

function openMemoContextActionModal(memoId, placement) {
  openModal("memoContextAction", { memoId, placement: placement || null });
}

function createStickyNoteForMemo(memoId) {
  const memo = state.memos[memoId];
  if (!memo) return;

  const currentMenu = state.selectedMenu;
  if (!currentMenu) {
    showToast(t("system.stickyNoScreen"), "warning");
    return;
  }

  // 현재 화면(menuId) 기준으로 이미 포스트잇이 있는지 확인 (다른 화면 포스트잇과 혼동 방지)
  const alreadyOnScreen = (state.stickyNotes || []).some(
    (n) => n.memoId === memoId && n.menuId === currentMenu,
  );
  if (alreadyOnScreen) {
    removeStickyNote(memoId);
    return;
  }

  // 다른 화면의 메모 → 복사/공유 선택 모달 호출
  const isCurrentMenuMemo = !!(
    memo.labels?.includes(currentMenu) || memo.menuId === currentMenu
  );
  if (!isCurrentMenuMemo) {
    openMemoContextActionModal(memoId, null);
    return;
  }

  addStickyNote(memoId);
  showToast(t("system.stickyCreated"));
}

function deleteClipboardItem(itemId) {
  workerSend("DELETE_CLIPBOARD", { itemId });
}

// ========================================
// 템플릿 기능
// ========================================
function openAddTemplateModal() {
  openModal("addTemplate");
}

function openEditTemplateModal(templateId) {
  const template = state.templates.find((t) => t.id === templateId);
  if (!template) return;

  // state.editingTemplateId를 설정한 뒤 openModal을 호출합니다.
  // buildEditTemplateModal 빌더가 state.editingTemplateId를 읽어 값을 즉시 채웁니다.
  // (기존 setTimeout 해킹이 완전히 제거됩니다.)
  state.editingTemplateId = templateId;
  openModal("editTemplate", { templateId: templateId });
}

function confirmAddSuggestedTemplate(suggestedText) {
  if (state.storageUsed >= state.storageLimit) {
    showToast(t("system.storageExceededShort"));
    return;
  }
  const safeContent = decodeURIComponent(suggestedText);
  const title = document
    .getElementById("modal-suggested-template-title")
    ?.value.trim();
  const pinned = document.getElementById("modal-suggested-template-pinned")?.checked || false;
  if (!title) {
    showToast(t("system.templateNameRequired"));
    return;
  }
  const template = {
    title,
    content: safeContent,
    pinned,
    count: 0,
  };
  workerSend("ADD_TEMPLATE", { template });
  closeModal();
}

function confirmAddTemplate() {
  if (state.storageUsed >= state.storageLimit) {
    showToast(t("system.storageExceededShort"));
    return;
  }
  const title = document.getElementById("modal-template-title")?.value.trim();
  const content = document
    .getElementById("modal-template-content")
    ?.value.trim();
  if (!title) {
    showToast(t("system.templateTitleRequired"));
    return;
  }
  if (!content) {
    showToast(t("system.templateContentRequired"));
    return;
  }
  const pinned = document.getElementById("modal-template-pinned")?.checked || false;
  const template = { title, content, pinned, count: 0 };
  workerSend("ADD_TEMPLATE", { template });
  closeModal();
}

function confirmEditTemplate() {
  const title = document
    .getElementById("modal-edit-template-title")
    ?.value.trim();
  const content = document
    .getElementById("modal-edit-template-content")
    ?.value.trim();
  if (!title) {
    showToast(t("system.templateTitleRequired"));
    return;
  }
  if (!content) {
    showToast(t("system.templateContentRequired"));
    return;
  }
  if (!state.editingTemplateId) {
    showToast(t("system.templateNotFound"));
    return;
  }
  const pinned = document.getElementById("modal-edit-template-pinned")?.checked || false;
  workerSend("EDIT_TEMPLATE", {
    templateId: state.editingTemplateId,
    title,
    content,
    pinned,
  });
  closeModal();
}

function useTemplate(templateId) {
  const template = state.templates.find((t) => t.id === templateId);
  if (!template) return;
  state.lastCopySource = "template";
  copyToClipboard(template.content);
  workerSend("USE_TEMPLATE", { templateId });
}

function deleteTemplate(templateId) {
  workerSend("DELETE_TEMPLATE", { templateId });
}

// ========================================
// 시간 기능
// ========================================
function setTimePeriod(period) {
  state.timePeriod = period;
  assiConsole.log("시간 기간 변경:", period);

  // 디버깅: 현재 버킷 데이터 출력
  const now = new Date();
  let debugKey = "";
  if (period === "today") {
    debugKey = getDailyBucket(now);
  } else if (period === "week") {
    debugKey = getWeeklyBucket(now);
  } else if (period === "month") {
    debugKey = getMonthlyBucket(now);
  }

  assiConsole.log(`[setTimePeriod] ${period} (키: ${debugKey})`);
  assiConsole.log("[setTimePeriod] 전체 버킷:", state.timeBuckets);

  // 강제 렌더링
  const assistantContent = document.getElementById(
    "imsmassi-assistant-content",
  );
  if (assistantContent) {
    if (state.activeTab === "dashboard") {
      assistantContent.innerHTML = renderDashboardTab();
    } else {
      assistantContent.innerHTML = renderTimeTab();
    }
  }
}

function goToMemoTab() {
  setActiveTab("memo");
}

// ========================================
// 설정 기능
// ========================================
// ========================================
// 업무 영역 컬러 커스터마이징 핸들러
// ========================================

/**
 * 업무 영역의 특정 컬러 키를 변경하고 Worker에 저장 요청
 * @param {string} areaId - 업무영역 ID (예: 'UW')
 * @param {string} key - 컬러 키 ('primary' | 'sub1' | 'sub2')
 * @param {string} value - 새 컬러 hex 값
 */
function onAreaColorChange(areaId, key, value) {
  if (!state.areaColors) state.areaColors = {};
  if (!state.areaColors[areaId]) {
    // 해당 영역의 기본값으로 초기화
    state.areaColors[areaId] = { ...getDefaultAreaColors(areaId) };
  }
  state.areaColors[areaId][key] = value;
  workerSend("SAVE_AREA_COLORS", { areaId, colors: state.areaColors[areaId] });
  renderAssistant();
  renderStickyNotes();
}

/**
 * 업무 영역 컬러를 기본값으로 초기화
 * @param {string} areaId - 업무영역 ID
 */
function resetAreaColors(areaId) {
  if (!state.areaColors) return;
  delete state.areaColors[areaId];
  workerSend("SAVE_AREA_COLORS", { areaId, colors: null });
  renderAssistant();
  renderStickyNotes();
  if (state.activeTab === "dashboard") renderAssistantContent();
}

function openSettingsModal() {
  if (state.activeTab !== "settings") {
    state.lastNonSettingsTab = state.activeTab || "memo";
  }
  if (state.activeTab === "settings") {
    closeSettingsTab();
  } else {
    setActiveTab("settings");
  }
}

function closeSettingsTab() {
  const targetTab = state.lastNonSettingsTab || "memo";
  setActiveTab(targetTab);
}

/**
 * DOM에서 설정 값을 읽어 객체로 반환하는 헬퍼
 */
function _readSettingsFromDOM() {
  const g = (id) => document.getElementById(id);
  return {
    autoCleanup: {
      clipboard:
        parseInt(g("setting-clipboard")?.value) ||
        state.settings.autoCleanup.clipboard,
      oldMemos: (() => {
        const raw = g("setting-oldmemos")?.value;
        if (raw === undefined || raw === null) return state.settings.autoCleanup.oldMemos;
        return Number(raw); // 0 입력이면 0 (삭제안함)
      })(),
    },
    backupReminder:
      g("setting-backup")?.checked ?? state.settings.backupReminder,
    markdownEnabled:
      g("setting-markdown")?.checked ?? state.settings.markdownEnabled,
    debugLogs: g("setting-debug-logs")?.checked ?? state.settings.debugLogs,
    autoNavigateToDashboard:
      g("setting-auto-dashboard")?.checked ??
      state.settings.autoNavigateToDashboard,
    reminderNotificationEnabled:
      g("setting-reminder-notification")?.checked ?? state.settings.reminderNotificationEnabled,
    toastEnabled: g("setting-toast")?.checked ?? state.settings.toastEnabled,
    showTimeTab: g("setting-show-time-tab")
      ? g("setting-show-time-tab").checked
      : state.settings.showTimeTab !== false,
    showAreaColorSection: g("setting-show-area-color")
      ? g("setting-show-area-color").checked
      : state.settings.showAreaColorSection !== false,
    // Task 2.3: lastBackup은 DOM에 없으므로 항상 현재 state 값을 유지
    // (downloadExportData()에서 갱신된 값이 Worker에 전달되도록 보장)
    lastBackup: state.settings.lastBackup,
  };
}

async function saveSettings(options = {}) {
  const { silent = false } = options;
  const newSettings = _readSettingsFromDOM();
  const prev = { ...state.settings };

  // 로컬 즉각 반영 (UI 반응성)
  Object.assign(state.settings, newSettings);
  state.autoNavigateToDashboard = newSettings.autoNavigateToDashboard;

  if (
    newSettings.browserNotificationEnabled &&
    !prev.browserNotificationEnabled
  )
    requestNotificationPermission();

  // Worker에 SAVE_SETTINGS 전송 (DB 저장 + 브로드캐스트)
  workerSend("SAVE_SETTINGS", { settings: newSettings });

  if (!silent) showToast(t("system.settingsSaved"));
  renderAssistant();
}

function exportAllData() {
  // Worker가 EXPORT_DATA_RESULT 메시지로 데이터를 전달하면
  // downloadExportData()가 자동 호출됩니다.
  workerSend("EXPORT_DATA", {});
}

function importData() {
  openModal("importConfirm");
}

function clearOldData() {
  const settings = _readSettingsFromDOM();
  workerSend("CLEAR_OLD_DATA", { settings });
}

async function runAutoCleanup(options = {}) {
  const { silent = true, refreshUI = false, reason = "auto" } = options;
  // Worker가 CLEAR_OLD_DATA를 처리하고 STATE_UPDATE로 브로드캐스트
  workerSend("CLEAR_OLD_DATA", { settings: state.settings, silent, reason });
  if (refreshUI) {
    renderStickyNotes();
    renderAssistantContent();
    updateFooterStorageInfo(getColors());
    updateStorageEstimate();
  }
}

// ========================================
// [Worker 위임] IndexedDB에서 상태 로드
// Worker가 INIT 처리 후 STATE_UPDATE로 전체 상태 복원하므로 stub으로 대체
// ========================================
function loadStateFromDB() {
  // Worker 연결 모드에서는 connectToWorker() → 'INIT' 메시지 → STATE_UPDATE 로 처리됨
  // 폴백(_bootstrapFallback) 경로에서만 직접 DB 로드가 필요하므로 여기선 no-op
  assiConsole.log("[loadStateFromDB] Worker 모드 - STATE_UPDATE 대기 중");
}


// ── [6-B] 메모 에디터 ─────────────────────────────────────────────────────────

function initMemoEditor() {
  if (!isQuillAvailable()) return;
  const editor = document.getElementById("imsmassi-memo-editor");
  const wrapper = document.getElementById("memo-editor-wrapper");

  if (!editor || !wrapper) return;

  // 이미 이 엘리먼트에 살아있는 Quill이 있으면 중복 초기화 방지
  // (saveSettings → renderAssistant 순으로 두 번 호출될 때 이중 인스턴스 생성 차단)
  if (memoQuill && memoQuill.root && document.body.contains(memoQuill.root))
    return;

  // quill-table-better 모듈 등록 (로드되어 있을 때만)
  // 전역: window.QuillTableBetter, 모듈명: 'modules/table-better'
  const hasBetterTable = typeof window.QuillTableBetter !== "undefined";
  if (hasBetterTable) {
    try {
      Quill.register({ "modules/table-better": window.QuillTableBetter }, true);
    } catch (_) {
      /* 이미 등록된 경우 무시 */
    }
  }

  const modules = {
    clipboard: { matchVisual: false },
  };

  if (hasBetterTable) {
    modules.table = false; // 기본 table 모듈 비활성화
    modules["table-better"] = {
      language: "en_US",
      menus: [],
    };
    modules.keyboard = {
      bindings: window.QuillTableBetter.keyboardBindings,
    };
  }

  if (
    typeof MarkdownShortcuts !== "undefined" &&
    state.settings.markdownEnabled
  ) {
    modules.markdownShortcuts = {};
  }

  const area = getArea();
  const _quillPlaceholder = area?.name
    ? t("ui.memoPlaceholder", { areaName: area.name })
    : t("ui.memoPlaceholderDefault");
  memoQuill = new Quill(editor, {
    theme: "bubble",
    placeholder: _quillPlaceholder,
    modules: modules,
  });

  // 테이블 셀 내부 커서 선택 시 bubble 툴팁 없애기
  memoQuill.on("selection-change", function (range) {
    if (!range) return;
    const tooltip = memoQuill.theme?.tooltip;
    if (!tooltip) return;
    try {
      const [leaf] = memoQuill.getLeaf(range.index);
      if (leaf?.domNode?.closest?.("td, th")) {
        tooltip.hide();
      }
    } catch (e) { assiConsole.warn("[Quill] tooltip hide 실패", e); }
  });

  (function installPasteHandler(quillInst) {
    const cb = quillInst.clipboard;
    const origOnPaste = cb.onPaste.bind(cb);
    function buildTableHtml(parsedRows) {
      let html = '<table style="border-collapse:collapse;width:100%;">';
      parsedRows.forEach((cells) => {
        html += "<tr>";
        cells.forEach((cell) => {
          const safe = String(cell != null ? cell : "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
          html += `<td style="border:1px solid #ccc;padding:4px 8px;">${safe}</td>`;
        });
        html += "</tr>";
      });
      return html + "</table>";
    }

    cb.onPaste = function (range, { html = "", text = "" } = {}) {
      // ① HTML 테이블: table-better 또는 기본 Quill에 위임
      if (html && html.includes("<table")) {
        return origOnPaste(range, { html, text });
      }

      // ② TSV (탭 포함 텍스트, html에 테이블 없는 경우)
      if (text && text.includes("\t")) {
        const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        if (norm) {
          const rows = norm
            .split("\n")
            .filter((r) => r.trim() !== "")
            .map((l) => l.split("\t"));
          if (rows.length > 0) {
            const sel =
              range && range.index != null
                ? range
                : quillInst.getSelection() || { index: 0, length: 0 };
            if (sel.length > 0)
              quillInst.deleteText(sel.index, sel.length, "user");
            quillInst.clipboard.dangerouslyPasteHTML(
              sel.index,
              buildTableHtml(rows),
              "user",
            );
            return;
          }
        }
      }

      // ③ 일반 텍스트/서식: 기본 처리
      return origOnPaste(range, { html, text });
    };
  })(memoQuill);

  if (state.memoDraftHtml) {
    setQuillContent(memoQuill, state.memoDraftHtml, true);
  }

  let previousContent = null;

  memoQuill.on("text-change", (delta, oldDelta, source) => {
    const MEMO_LIMIT = 2 * 1024 * 1024; // 2MB
    const html = memoQuill.root.innerHTML || "";
    const currentSize = new Blob([html]).size;

    if (currentSize > MEMO_LIMIT) {
      // 용량 초과 시 이전 상태로 되돌리기
      if (previousContent) {
        memoQuill.setContents(previousContent);
      }
      showToast(t("system.memoSizeExceeded"));
      return;
    }

    // 정상 범위 내일 때만 상태 저장
    previousContent = memoQuill.getContents();
    state.memoDraftHtml = html;
    state.memoDraftText = memoQuill.getText() || "";
    updateMemoCapacity();

    if (normalizeEmptyMemoEditor(memoQuill)) {
      updateMemoCapacity();
    }
  });

  memoQuill.on("selection-change", (range) => {
    wrapper.classList.toggle("imsmassi-focused", !!range);
  });

  memoQuill.keyboard.addBinding({ key: 13, shortKey: true }, () => {
    addMemo();
    return false;
  });

  updateMemoCapacity();
}

let inlineMemoQuillMap = {};
let inlineMemoDirtyMap = {};
let inlineMemoSavingMap = {};

function initInlineMemoEditors() {
  const nodes = document.querySelectorAll(".imsmassi-memo-inline-editor");
  inlineMemoDirtyMap = {};

  // table-better 등록 (미등록 시)
  const hasBetterTable = typeof window.QuillTableBetter !== "undefined";
  if (hasBetterTable) {
    try {
      Quill.register({ "modules/table-better": window.QuillTableBetter }, true);
    } catch (e) { assiConsole.warn("[Quill] table-better 등록 실패 (중복 무시)", e); }
  }
  // quill-better-table 버전 호환 shim (scrollSelectionIntoView 미존재 시 폴백)
  _applyQuillCompatShim();

  nodes.forEach((node) => {
    if (node.dataset.quillInit === "true") return;
    const memoId = node.dataset.memoId;
    const encoded = node.dataset.content || "";
    const html = sanitizeHtml(decodeURIComponent(encoded));
    const modules = { toolbar: true };
    if (hasBetterTable) {
      modules.table = false;
      modules["table-better"] = {
        language: "en_US",
        menus: [],
      };
      modules.keyboard = { bindings: window.QuillTableBetter.keyboardBindings };
    }
    if (
      typeof MarkdownShortcuts !== "undefined" &&
      state.settings.markdownEnabled
    ) {
      modules.markdownShortcuts = {};
    }
    const quill = new Quill(node, {
      theme: "bubble",
      modules,
    });
    // table-better matchers가 등록된 상태에서 convert가 동작하도록
    // dangerouslyPasteHTML 대신 root.innerHTML 직접 주입 후 history 초기화
    quill.root.innerHTML = html;
    quill.history.clear();
    quill.on("text-change", () => {
      if (memoId) inlineMemoDirtyMap[memoId] = true;
    });
    quill.on("selection-change", (range, oldRange, source) => {
      if (!range && source === "user" && memoId && inlineMemoDirtyMap[memoId]) {
        saveInlineMemoEdit(memoId);
      }
    });
    node.dataset.quillInit = "true";
    if (memoId) inlineMemoQuillMap[memoId] = quill;
  });
}

async function saveInlineMemoEdit(memoId) {
  if (!memoId) return;
  if (inlineMemoSavingMap[memoId]) return;
  const memo = state.memos[memoId];
  if (!memo) return;
  inlineMemoSavingMap[memoId] = true;

  let newContent = "";
  let isRichText = memo.isRichText;

  if (inlineMemoQuillMap[memoId]) {
    newContent = sanitizeHtml(inlineMemoQuillMap[memoId].root.innerHTML || "");
    isRichText = true;
  } else {
    const el = document.querySelector(
      `.imsmassi-memo-inline-text[data-memo-id="${memoId}"]`,
    );
    newContent = (el?.innerText || "").trim();
    isRichText = false;
  }

  // Worker에 SAVE_INLINE_EDIT 전송
  workerSend("SAVE_INLINE_EDIT", { memoId, content: newContent, isRichText });

  inlineMemoDirtyMap[memoId] = false;
  inlineMemoSavingMap[memoId] = false;
  state.editingMemoId = null;
  renderAssistantContent();
  renderStickyNotes();
}

function saveMemoTitle(memoId, newTitle) {
  if (!memoId) return;
  const memo = state.memos?.[memoId];
  if (!memo || memo.title === newTitle) return;
  workerSend("SAVE_MEMO_TITLE", { memoId, title: newTitle });
  // 제목 span 즉각 동기화 (STATE_UPDATE 대기 없이)
  document
    .querySelectorAll(`.imsmassi-memo-title-editable[data-memo-id="${memoId}"]`)
    .forEach((el) => {
      if (document.activeElement !== el) el.innerText = newTitle;
    });
  document
    .querySelectorAll(
      `.imsmassi-sticky-title-editable[data-memo-id="${memoId}"]`,
    )
    .forEach((el) => {
      if (document.activeElement !== el) el.innerText = newTitle;
    });
}

function initMemoListEditors() {
  if (!isQuillAvailable()) return;
  const nodes = document.querySelectorAll(".imsmassi-memo-richtext");
  nodes.forEach((node) => {
    if (node.dataset.quillInit === "true") return;
    const encoded = node.dataset.content || "";
    const html = sanitizeHtml(decodeURIComponent(encoded));
    const quill = new Quill(node, {
      theme: "bubble",
      readOnly: true,
      modules: { toolbar: false },
    });
    // dangerouslyPasteHTML은 내부 convert()를 통해 table HTML을 손실시킬 수 있음.
    // 읽기 전용 표시이므로 root.innerHTML 직접 주입으로 table 구조를 보존.
    quill.root.innerHTML = html;
    node.dataset.quillInit = "true";
  });
}

function getMemoPlainText(memo) {
  if (!memo) return "";
  if (!memo.isRichText) return memo.content || "";

  const temp = document.createElement("div");
  temp.innerHTML = memo.content || "";
  return temp.innerText || temp.textContent || "";
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function handleMemoDragStart(event, memoId) {
  if (!memoId) return;
  if (!event.dataTransfer) return;
  event.dataTransfer.setData("text/memo-id", memoId);
  event.dataTransfer.setData("text/plain", memoId);
  event.dataTransfer.setData("text/menu-id", state.selectedMenu || "");
  event.dataTransfer.setData("text/area-id", state.selectedArea || "");
  event.dataTransfer.effectAllowed = "copy";
}


// ── [6-C] 포스트잇 (Sticky Notes) ─────────────────────────────────────────────

function saveStickyNotes() {
  workerSend("SAVE_STICKY_NOTES", { stickyNotes: state.stickyNotes || [] });
}

// 1. 상태 업데이트 헬퍼 (배열 전체를 매번 복사하지 않고 해당 객체만 수정)
function upsertStickyNote(memoId, patch) {
  if (!memoId) return null;

  if (!state.stickyNotes) state.stickyNotes = [];

  // patch에 menuId가 있으면 화면(menuId)까지 일치하는 노트를 찾아야
  // 다른 화면 포스트잇을 덮어쓰는 버그를 방지합니다.
  const menuId = patch?.menuId;
  let note = menuId
    ? state.stickyNotes.find((n) => n.memoId === memoId && n.menuId === menuId)
    : state.stickyNotes.find((n) => n.memoId === memoId);

  if (!note) {
    note = { memoId, x: 0, y: 0, width: AssistantConfig.ui.stickyNoteDefaultWidth, height: AssistantConfig.ui.stickyNoteDefaultHeight };
    state.stickyNotes.push(note);
  }

  Object.assign(note, patch);
  return note;
}

function setStickyNotePosition(memoId, x, y) {
  const nextX = Math.max(0, Number.isFinite(Number(x)) ? Number(x) : 0);
  const nextY = Math.max(0, Number.isFinite(Number(y)) ? Number(y) : 0);
  return upsertStickyNote(memoId, { x: nextX, y: nextY });
}

// 2. 포스트잇 생성 위치 계산 로직 개선
function getDefaultStickyPlacement(memoId) {
  const layer = document.getElementById("sticky-layer");
  const panel = document.getElementById("imsmassi-floating-panel");
  const margin       = AssistantConfig.ui.stickyNoteMargin;
  const defaultWidth = AssistantConfig.ui.stickyNoteDefaultWidth;
  const defaultHeight = AssistantConfig.ui.stickyNoteDefaultHeight;

  // sticky-layer 컨테이너 기준 상대좌표 계산
  const layerRect = layer?.getBoundingClientRect();
  // sticky-layer가 아직 없거나 크기가 0이면 뷰포트 기준 사용
  const baseRect = (layerRect && layerRect.width > 0)
    ? layerRect
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  const panelRect = panel?.getBoundingClientRect();

  // 어시스턴트 패널 왼쪽 공간에 배치, 없으면 좌측 상단
  const x = panelRect
    ? Math.max(margin, panelRect.left - baseRect.left - defaultWidth - margin)
    : margin;
  const baseY = panelRect
    ? Math.max(margin, panelRect.top - baseRect.top)
    : margin;

  // 배치 가능한 최대 Y (레이어 높이를 벗어나지 않도록)
  const maxY = baseRect.height - defaultHeight - margin;

  let y = baseY;

  // 기존 포스트잇들과 겹치지 않도록 Y 좌표 조정
  const notes = (state.stickyNotes || []).filter((n) => n.memoId !== memoId);
  const isOverlapping = (ax, ay, aw, ah, bx, by, bw, bh) =>
    ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

  const sorted = notes
    .map((n) => ({
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      width: Number(n.width) || defaultWidth,
      height: Number(n.height) || defaultHeight,
    }))
    .sort((a, b) => a.y - b.y);

  sorted.forEach((n) => {
    if (
      isOverlapping(
        x,
        y,
        defaultWidth,
        defaultHeight,
        n.x,
        n.y,
        n.width,
        n.height,
      )
    ) {
      y = n.y + n.height + margin;
    }
  });

  // 화면 밖으로 나가면 baseY 로 되돌림 (겹치더라도 화면 안에 표시)
  if (maxY > 0 && y > maxY) y = baseY;

  return { x, y, width: defaultWidth, height: defaultHeight };
}

// 3. 포스트잇 추가 로직
function addStickyNote(memoId, x, y) {
  if (!memoId) return;
  const memo = state.memos?.[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  if (!currentMenu) {
    assiConsole.warn(
      "[Assistant] addStickyNote: 화면 ID(menuId) 미확인 — 포스트잇 생성 취소",
    );
    showToast(t("system.stickyNoScreen"), "warning");
    return;
  }
  const hasDropPosition =
    Number.isFinite(Number(x)) && Number.isFinite(Number(y));
  // 현재 화면(currentMenu) 기준으로만 기존 노트 확인 — memoId만 비교하면
  // 다른 화면의 포스트잇을 "이미 존재"로 잘못 인식해 생성을 건너뜁니다.
  const existing =
    (state.stickyNotes || []).find(
      (n) => n.memoId === memoId && n.menuId === currentMenu,
    ) || null;
  let placement;
  if (existing) {
    if (hasDropPosition) setStickyNotePosition(memoId, x, y);
    placement = null; // 이미 존재, 위치만 변경
  } else {
    placement = hasDropPosition
      ? { x, y, width: AssistantConfig.ui.stickyNoteDefaultWidth, height: AssistantConfig.ui.stickyNoteDefaultHeight }
      : getDefaultStickyPlacement(memoId);
    upsertStickyNote(memoId, { ...placement, menuId: currentMenu });
  }
  workerSend("ADD_STICKY_NOTE", { memoId, placement, menuId: currentMenu });
  renderStickyNotes();
  renderAssistantContent();
}

function removeStickyNote(memoId) {
  const memo = state.memos?.[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  workerSend("REMOVE_STICKY_NOTE", { memoId, menuId: currentMenu });
  // 로컬 상태 즉각 반영 — 현재 화면(currentMenu)의 노트만 제거 (다른 화면 포스트잇 보존)
  state.stickyNotes = (state.stickyNotes || []).filter(
    (n) => !(n.memoId === memoId && n.menuId === currentMenu),
  );
  renderStickyNotes();
  renderAssistantContent();
}

function toggleStickyNoteCollapse(memoId) {
  if (!memoId || !state.stickyNotes) return;
  const currentMenu = state.selectedMenu;
  // menuId+memoId 기준으로 현재 화면의 포스트잇만 토글 (다른 화면 포스트잇 오동작 방지)
  const note =
    state.stickyNotes.find(
      (n) => n.memoId === memoId && (!currentMenu || n.menuId === currentMenu),
    ) || state.stickyNotes.find((n) => n.memoId === memoId);
  if (!note) return;
  note.isCollapsed = !note.isCollapsed;
  saveStickyNotes();
  renderStickyNotes();
}

// 6. 드래그 로직 (기존과 동일하게 유지하되 약간의 방어코드 추가)
function enableStickyNoteDrag(wrapperEl, note) {
  const memoId = wrapperEl.dataset.memoId || note?.memoId;
  const menuId = note?.menuId; // 화면 ID — menuId 기반 정확한 노트 탐색에 사용
  if (!memoId) return;
  const handle = wrapperEl.querySelector(".imsmassi-sticky-note-header");
  if (!handle) return;
  // 드래그 전용 핸들 (⠿ 아이콘) - 없으면 헤더 전체를 폴백으로 사용
  const dragHandle =
    wrapperEl.querySelector(".imsmassi-sticky-drag-handle") || handle;

  // 포스트잇 어디를 클릭/터치해도 (접기·닫기 버튼 제외) 메모리스트 포커스
  wrapperEl.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".imsmassi-sticky-note-btn")) {
      scrollToMemoItem(memoId);
    }
  });

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  // AbortController로 이 wrapperEl이 DOM에서 제거될 때 리스너 일괄 정리
  const ac = new AbortController();
  const { signal } = ac;

  // wrapperEl이 DOM에서 제거되면 리스너 정리
  const cleanupObserver = new MutationObserver(() => {
    if (!document.contains(wrapperEl)) {
      if (isDragging) {
        isDragging = false;
        state.stickyDragActive = false;
      }
      ac.abort();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  dragHandle.addEventListener("mousedown", (event) => {
    if (!document.contains(wrapperEl)) return; // stale 요소 방어
    isDragging = true;
    state.stickyDragActive = true;
    startX = event.pageX;
    startY = event.pageY;
    // menuId 포함 정확한 노트 탐색 (memoId 단독 탐색 시 다른 화면 노트를 잘못 참조하는 버그 방지)
    const current =
      (state.stickyNotes || []).find(
        (n) => n.memoId === memoId && n.menuId === menuId,
      ) ||
      (state.stickyNotes || []).find((n) => n.memoId === memoId) ||
      {};
    originX = current.x || 0;
    originY = current.y || 0;
    event.preventDefault(); // 텍스트 선택 방지
  });

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!isDragging) return;
      // stale 요소 방어 — 이미 AbortController가 처리하지만 이중 보호
      if (!document.contains(wrapperEl)) {
        isDragging = false;
        state.stickyDragActive = false;
        return;
      }
      const dx = event.pageX - startX;
      const dy = event.pageY - startY;
      const nextX = Math.max(0, originX + dx);
      const nextY = Math.max(0, originY + dy);

      // menuId 포함 상태 업데이트 (다른 화면 노트를 건드리지 않음)
      upsertStickyNote(memoId, { x: nextX, y: nextY, menuId });

      // UI 즉각 반영
      wrapperEl.style.left = `${nextX}px`;
      wrapperEl.style.top = `${nextY}px`;
    },
    { signal, capture: true },
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (isDragging) {
        isDragging = false;
        state.stickyDragActive = false;
        saveStickyNotes();
      }
    },
    { signal, capture: true },
  );
}

// 4. 포스트잇 렌더링 로직 (초기화 방지)
// 포스트잇 클릭 시 메모 리스트에서 해당 메모로 스크롤 포커스
function scrollToMemoItem(memoId) {
  if (!memoId) return;

  // 메모 탭이 아니면 먼저 이동
  if (state.activeTab !== "memo") {
    setActiveTab("memo");
    // 탭 전환 후 DOM 렌더링 기다렸다가 스크롤
    setTimeout(() => _doScrollToMemoItem(memoId), 150);
  } else {
    _doScrollToMemoItem(memoId);
  }
}

function _doScrollToMemoItem(memoId) {
  const target = document.querySelector(
    `.imsmassi-memo-item[data-id="${memoId}"]`,
  );
  if (!target) return;

  target.scrollIntoView({ behavior: "smooth", block: "center" });

  // 하이라이트 효과
  target.classList.add("imsmassi-memo-item-highlight");
  setTimeout(
    () => target.classList.remove("imsmassi-memo-item-highlight"),
    1800,
  );
}

/**
 * 포스트잇이 현재 sticky-layer 가시 영역(뷰포트 클립 영역) 밖에 위치하는지 확인합니다.
 * clip-path 기반 클리핑 기능에 영향을 주지 않으며 읽기(read-only) 전용입니다.
 * @param {Object} note - stickyNote 객체 (x, y, width, height, isCollapsed)
 * @returns {boolean} true이면 뷰포트 밖
 */
function isStickyNoteOutOfViewport(note) {
  if (!note) return false;
  const layer = document.getElementById("sticky-layer");
  if (!layer || layer.style.display === "none") return false;

  // 레이어가 컨테이너와 동일한 크기(position:absolute 100%)이므로
  // 단순히 포스트잇 좌표가 레이어 범위를 벗어났는지만 검사합니다.
  const layerW = layer.offsetWidth;
  const layerH = layer.offsetHeight;
  if (layerW <= 0 || layerH <= 0) return false;

  const renderWidth = note.width ? Math.max(AssistantConfig.ui.stickyNoteMinSize, note.width) : AssistantConfig.ui.stickyNoteDefaultWidth;
  const renderHeight = note.isCollapsed
    ? 22
    : note.height
      ? Math.max(AssistantConfig.ui.stickyNoteMinSize, note.height)
      : AssistantConfig.ui.stickyNoteDefaultHeight;
  const noteLeft = note.x || 0;
  const noteTop = note.y || 0;
  const noteRight = noteLeft + renderWidth;
  const noteBottom = noteTop + renderHeight;

  return (
    noteRight <= 0 || noteLeft >= layerW || noteBottom <= 0 || noteTop >= layerH
  );
}

function renderStickyNotes() {
  const layer = document.getElementById("sticky-layer");
  if (!layer) return;

  // [핵심] 여기서 syncStickyNoteSizesFromDOM()을 호출하지 않습니다.
  // 화면을 다시 그릴 때마다 DOM 크기를 읽어오면, 숨겨진 상태나 초기화 과정에서 0으로 덮어써집니다.

  // 기존 포스트잇 완전 제거
  layer.innerHTML = "";

  const currentMenu = state.selectedMenu;
  assiConsole.log(
    `[Assistant] renderStickyNotes: currentMenu=${currentMenu}, currentArea=${state.selectedArea}, notes=${(state.stickyNotes || []).length}`,
  );

  (state.stickyNotes || []).forEach((note) => {
    const memo = state.memos?.[note.memoId];
    if (!memo) return;

    // note.menuId가 현재 화면ID와 일치하는 포스트잇만 표시
    // matchesArea 체크는 제거: note.menuId만으로 화면 특정이 완전하며,
    // state.selectedArea가 미세하게 어긋날 경우 올바른 포스트잇까지 차단되는 문제 방지
    const matchesMenu = !currentMenu || note.menuId === currentMenu;
    if (!matchesMenu) return;

    const areaIdText = getAreaName(memo.createdAreaId || memo.areaId, "화면");
    const content = getMemoPlainText(memo).trim();
    const displayText =
      content.length > 140 ? `${content.substring(0, 140)}...` : content;
    const isRichText = !!memo.isRichText;
    const isCollapsed = !!note.isCollapsed;
    const collapsedPreviewRaw = content || "내용 없음";
    const collapsedPreview =
      collapsedPreviewRaw.length > 12
        ? `${collapsedPreviewRaw.substring(0, 12)}...`
        : collapsedPreviewRaw;
    const headerText = isCollapsed
      ? memo.title || collapsedPreview
      : memo.title || areaIdText;
    const collapseClass = isCollapsed ? "imsmassi-sticky-btn-expand" : "imsmassi-sticky-btn-minimize";
    const collapseTitle = isCollapsed ? "펼치기" : "최소화";

    const wrapperEl = document.createElement("div");
    wrapperEl.className = `imsmassi-sticky-note-wrapper${isCollapsed ? " imsmassi-is-collapsed" : ""}`;
    wrapperEl.dataset.memoId = note.memoId;

    // [핵심] 상태에 저장된 크기를 CSS 변수로 주입 (단위 px 확인)
    const renderWidth = note.width ? Math.max(AssistantConfig.ui.stickyNoteMinSize, note.width) : AssistantConfig.ui.stickyNoteDefaultWidth;
    const renderHeight = isCollapsed
      ? 22
      : note.height
        ? Math.max(AssistantConfig.ui.stickyNoteMinSize, note.height)
        : AssistantConfig.ui.stickyNoteDefaultHeight;

    wrapperEl.style.setProperty("--sticky-width", `${renderWidth}px`);
    wrapperEl.style.setProperty("--sticky-height", `${renderHeight}px`);
    wrapperEl.style.left = `${Math.max(0, note.x || 0)}px`;
    wrapperEl.style.top = `${Math.max(0, note.y || 0)}px`;

    const noteEl = document.createElement("div");
    noteEl.className = `imsmassi-sticky-note${isCollapsed ? " imsmassi-is-collapsed" : ""}`;
    noteEl.innerHTML = `
      <div class="imsmassi-sticky-note-header" data-memo-id="${note.memoId}">
        <span class="imsmassi-sticky-drag-handle" draggable="false" title="드래그하여 이동">⠿</span>
        <span
          class="imsmassi-sticky-title-editable"
          contenteditable="true"
          data-memo-id="${note.memoId}"
          data-placeholder="제목 없음"
          onblur="saveMemoTitle('${note.memoId}', this.innerText.trim())"
          onkeydown="if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();this.blur();}"
          onmousedown="scrollToMemoItem('${note.memoId}')"
          style="outline:none; cursor:text; flex:1; min-width:0; overflow:hidden; white-space:nowrap;"
        >${memo.title || ""}</span>
        <div class="imsmassi-sticky-note-actions">
          <button class="imsmassi-sticky-note-btn ${collapseClass}" onclick="toggleStickyNoteCollapse('${note.memoId}')" title="${collapseTitle}"></button>
          <button class="imsmassi-sticky-note-btn imsmassi-sticky-btn-close" onclick="removeStickyNote('${note.memoId}')" title="닫기">✕</button>
        </div>
      </div>
      ${
        isCollapsed
          ? ""
          : isRichText
            ? `<div class="imsmassi-sticky-note-body imsmassi-sticky-note-richtext" data-memo-id="${note.memoId}" data-content="${encodeURIComponent(sanitizeHtml(memo.content || ""))}"></div>`
            : `<div class="imsmassi-sticky-note-body" contenteditable="true" data-memo-id="${note.memoId}" onfocus="state.isStickyNoteEditing = true; scrollToMemoItem('${note.memoId}')" oninput="stickyNotePlainDirtyMap['${note.memoId}'] = true" onblur="saveStickyNoteEdit('${note.memoId}', this)" style="outline: none;">${displayText || "내용 없음"}</div>`
      }
      ${isCollapsed ? "" : '<div class="imsmassi-sticky-resize-handle" title="크기 조절"></div>'}
    `;
    wrapperEl.appendChild(noteEl);
    layer.appendChild(wrapperEl);

    enableStickyNoteDrag(wrapperEl, note);
    if (!isCollapsed) {
      enableStickyNoteResize(wrapperEl, note);
    }
  });

  initStickyNoteRichText();
}

// 5. 크기 조절 (커스텀 핸들 드래그) 로직
function enableStickyNoteResize(wrapperEl, note) {
  const memoId = wrapperEl.dataset.memoId || note?.memoId;
  const menuId = note?.menuId;
  if (!memoId) return;

  const handle = wrapperEl.querySelector(".imsmassi-sticky-resize-handle");
  if (!handle) return;

  let isResizing = false;
  let startX = 0,
    startY = 0;
  let startW = 0,
    startH = 0;
  let saveTimer = null;

  const ac = new AbortController();
  const { signal } = ac;

  // wrapperEl이 DOM에서 제거되면 리스너 정리
  const cleanupObserver = new MutationObserver(() => {
    if (!document.contains(wrapperEl)) {
      if (isResizing) {
        isResizing = false;
        state.stickyResizeActive = false;
      }
      ac.abort();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  handle.addEventListener("mousedown", (e) => {
    if (!document.contains(wrapperEl)) return;
    isResizing = true;
    state.stickyResizeActive = true;
    startX = e.pageX;
    startY = e.pageY;
    const curr =
      (state.stickyNotes || []).find(
        (n) => n.memoId === memoId && n.menuId === menuId,
      ) ||
      (state.stickyNotes || []).find((n) => n.memoId === memoId) ||
      {};
    startW = curr.width || AssistantConfig.ui.stickyNoteDefaultWidth;
    startH = curr.height || AssistantConfig.ui.stickyNoteDefaultHeight;
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isResizing) return;
      if (!document.contains(wrapperEl)) {
        isResizing = false;
        state.stickyResizeActive = false;
        return;
      }
      const nextW = Math.max(AssistantConfig.ui.stickyNoteMinSize, Math.min(1200, startW + (e.pageX - startX)));
      const nextH = Math.max(AssistantConfig.ui.stickyNoteMinSize, Math.min(900, startH + (e.pageY - startY)));
      wrapperEl.style.setProperty("--sticky-width", `${nextW}px`);
      wrapperEl.style.setProperty("--sticky-height", `${nextH}px`);
      upsertStickyNote(memoId, { width: nextW, height: nextH, menuId });
    },
    { signal, capture: true },
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (isResizing) {
        isResizing = false;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          state.stickyResizeActive = false;
          saveStickyNotes();
        }, 300);
      }
    },
    { signal, capture: true },
  );
}

let stickyNoteQuillMap = {};
let stickyNoteDirtyMap = {};
let stickyNotePlainDirtyMap = {}; // plain contenteditable dirty 플래그

function initStickyNoteRichText() {
  if (!isQuillAvailable()) return;
  stickyNoteQuillMap = {};
  stickyNoteDirtyMap = {};
  stickyNotePlainDirtyMap = {};

  // table-better 등록 (미등록 시)
  const hasBetterTable = typeof window.QuillTableBetter !== "undefined";
  if (hasBetterTable) {
    try {
      Quill.register({ "modules/table-better": window.QuillTableBetter }, true);
    } catch (e) { assiConsole.warn("[Quill] table-better 등록 실패 (중복 무시)", e); }
  }
  // quill-better-table 버전 호환 shim (scrollSelectionIntoView 미존재 시 폴백)
  _applyQuillCompatShim();

  const nodes = document.querySelectorAll(".imsmassi-sticky-note-richtext");
  nodes.forEach((node) => {
    if (node.dataset.quillInit === "true") return;
    const memoId = node.dataset.memoId;
    const encoded = node.dataset.content || "";
    const html = sanitizeHtml(decodeURIComponent(encoded));
    // toolbar: [] → 빈 툴바 컨테이너를 생성해 table-better의 initWhiteList가
    // toolbar.imsmassi-container에 접근할 수 있도록 함 (toolbar: false 시 null 오류 발생)
    // 빈 툴바 div는 CSS에서 display:none 처리
    const modules = { toolbar: [] };
    if (hasBetterTable) {
      modules.table = false;
      modules["table-better"] = {
        language: "en_US",
        menus: [],
      };
      modules.keyboard = { bindings: window.QuillTableBetter.keyboardBindings };
    }
    if (
      typeof MarkdownShortcuts !== "undefined" &&
      state.settings.markdownEnabled
    ) {
      modules.markdownShortcuts = {};
    }
    const quill = new Quill(node, {
      theme: "bubble",
      modules,
    });
    quill.root.innerHTML = html;
    quill.history.clear();
    node.dataset.quillInit = "true";
    if (memoId) stickyNoteQuillMap[memoId] = quill;
    if (memoId) stickyNoteDirtyMap[memoId] = false;

    quill.on("text-change", () => {
      if (memoId) stickyNoteDirtyMap[memoId] = true;
    });

    quill.on("selection-change", (range) => {
      if (range) {
        state.isStickyNoteEditing = true;
        scrollToMemoItem(memoId);
      } else {
        if (memoId && stickyNoteDirtyMap[memoId]) {
          // map 리셋으로 참조 유실 방지: 클로저의 quill 직접 전달
          saveStickyNoteRichText(memoId, quill);
        } else {
          state.isStickyNoteEditing = false;
        }
      }
    });
  });
}

async function saveStickyNoteRichText(memoId, quillInst) {
  const memo = state.memos?.[memoId];
  // quillInst: selection-change 클로저에서 직접 전달된 것 우선, 없으면 map fallback
  const quill =
    quillInst && document.body.contains(quillInst.root)
      ? quillInst
      : stickyNoteQuillMap[memoId];
  if (!memo || !quill) return;
  // 좌비 인스턴스 방어 (DOM에서 제거된 quill root)
  if (!document.body.contains(quill.root)) return;

  const content = sanitizeHtml(quill.root.innerHTML || "");
  state.suppressInlineFocus = true;
  workerSend("SAVE_INLINE_EDIT", { memoId, content, isRichText: true });
  if (memoId) stickyNoteDirtyMap[memoId] = false;
  state.isStickyNoteEditing = false;
  state.suppressInlineFocus = false;
  renderAssistantContent();
  renderStickyNotes();
}

function saveStickyNoteEdit(memoId, element) {
  const memo = state.memos?.[memoId];
  if (!memo || !element) return;
  // oninput으로 dirty 플래그가 세팅된 경우에만 저장
  if (!stickyNotePlainDirtyMap[memoId]) return;
  const content = (element.innerText || "").trim();
  stickyNotePlainDirtyMap[memoId] = false;
  state.suppressInlineFocus = true;
  workerSend("SAVE_INLINE_EDIT", { memoId, content, isRichText: false });
  state.isStickyNoteEditing = false;
  state.suppressInlineFocus = false;
  renderAssistantContent();
  renderStickyNotes();
}

/**
 * saveAllDirtyNotes()
 * dirty 상태인 모든 포스트잇(Quill + plain contenteditable)을 강제 저장합니다.
 * closeAssistant / relocateStickyLayer / beforeunload / visibilitychange 에서 호출합니다.
 */
function saveAllDirtyNotes() {
  // ① Quill rich-text dirty 노트 저장
  Object.entries(stickyNoteDirtyMap).forEach(([memoId, dirty]) => {
    if (!dirty) return;
    const quill = stickyNoteQuillMap[memoId];
    if (quill && document.body.contains(quill.root)) {
      saveStickyNoteRichText(memoId, quill);
    }
  });

  // ② plain contenteditable dirty 노트 저장
  Object.entries(stickyNotePlainDirtyMap).forEach(([memoId, dirty]) => {
    if (!dirty) return;
    const el = document.querySelector(
      `#sticky-layer .imsmassi-sticky-note-body[data-memo-id="${memoId}"]`
    );
    if (el) {
      saveStickyNoteEdit(memoId, el);
    } else {
      // DOM이 없어도 state.memos에 현재 표시 텍스트가 없다면 스킵
      stickyNotePlainDirtyMap[memoId] = false;
    }
  });
}

function focusInlineMemoEditor() {
  if (state.isStickyNoteEditing || state.suppressInlineFocus) return;
  if (!state.editingMemoId) return;
  const inlineText = document.querySelector(
    `.imsmassi-memo-inline-text[data-memo-id="${state.editingMemoId}"]`,
  );
  if (inlineText) {
    inlineText.focus();
    return;
  }
  const inlineEditor = document.querySelector(
    `.imsmassi-memo-inline-editor[data-memo-id="${state.editingMemoId}"]`,
  );
  if (inlineEditor && inlineMemoQuillMap[state.editingMemoId]) {
    inlineMemoQuillMap[state.editingMemoId].focus();
  }
}

function initStickyNoteDrop() {
  const layer = document.getElementById("sticky-layer");
  if (!layer || layer.dataset.stickyDropBound === "true") return;
  layer.dataset.stickyDropBound = "true";

  const root = getAssistantRoot();

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────
  /** drag 데이터에 memo-id 포함 여부 확인 */
  function _isMemoIdDrag(event) {
    return (
      event.dataTransfer?.types?.includes("text/memo-id") ||
      event.dataTransfer?.types?.includes("text/plain")
    );
  }

  /**
   * cursor 위치가 sticky-layer 가시 영역 내에 있는지 확인
   * clip-path 로 가려진 영역은 드롭 대상에서 제외합니다.
   */
  function _isInsideStickyLayer(event) {
    const layerEl = document.getElementById("sticky-layer");
    if (!layerEl || layerEl.style.display === "none") return false;
    const lr = layerEl.getBoundingClientRect();
    return (
      event.clientX >= lr.left &&
      event.clientX <= lr.right &&
      event.clientY >= lr.top &&
      event.clientY <= lr.bottom
    );
  }

  /** clientX/Y → sticky-layer 기준 상대좌표 변환 */
  function _toLayerCoords(event) {
    const layerEl = document.getElementById("sticky-layer");
    if (!layerEl) return { x: 0, y: 0 };
    const lr = layerEl.getBoundingClientRect();
    return {
      x: Math.max(0, event.clientX - lr.left),
      y: Math.max(0, event.clientY - lr.top),
    };
  }

  // ── 1. 어시스턴트 패널 내 dragover/drop ──────────────────────────────────
  root.addEventListener("dragover", (event) => {
    if (_isMemoIdDrag(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });

  root.addEventListener("drop", (event) => {
    const memoId =
      event.dataTransfer?.getData("text/memo-id") ||
      event.dataTransfer?.getData("text/plain");
    if (!memoId) return;
    event.preventDefault();
    const memo = state.memos[memoId];
    const currentMenu = state.selectedMenu;
    const isCurrentMenuMemo = !!(
      memo?.labels?.includes(currentMenu) || memo?.menuId === currentMenu
    );
    if (memo && !isCurrentMenuMemo) {
      // 다른 화면의 메모 → 복사/공유 선택 모달 호출
      openMemoContextActionModal(memoId, null);
    } else {
      // 현재 화면 메모 → 바로 포스트잇 배치
      addStickyNote(memoId);
    }
  });

  // ── 2. sticky-layer 오버레이 영역 dragover/drop (내부시스템 오버레이 대응) ─
  // sticky-layer 는 pointer-events: none 이므로 HTML5 DnD 이벤트를 직접 받지 못합니다.
  // 따라서 document 캡처 단계에서 커서 위치를 체크하여 드롭을 처리합니다.
  document.addEventListener(
    "dragover",
    (event) => {
      if (!_isMemoIdDrag(event)) return;
      if (_isInsideStickyLayer(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    true /* capture */,
  );

  document.addEventListener(
    "drop",
    (event) => {
      if (!_isMemoIdDrag(event)) return;
      // 패널 내 드롭은 위의 root 핸들러에서 처리
      if (root.contains(event.target)) return;
      if (!_isInsideStickyLayer(event)) return;

      event.preventDefault();
      event.stopPropagation(); // 호스트 시스템의 drop 처리 방지

      const memoId =
        event.dataTransfer?.getData("text/memo-id") ||
        event.dataTransfer?.getData("text/plain");
      if (!memoId) return;

      const { x, y } = _toLayerCoords(event);
      const memo = state.memos[memoId];
      const currentMenu = state.selectedMenu;
      const isCurrentMenuMemo = !!(
        memo?.labels?.includes(currentMenu) || memo?.menuId === currentMenu
      );
      if (memo && !isCurrentMenuMemo) {
        // 다른 화면의 메모 → 복사/공유 선택 모달 호출
        openMemoContextActionModal(memoId, { x, y, width: AssistantConfig.ui.stickyNoteDefaultWidth, height: AssistantConfig.ui.stickyNoteDefaultHeight });
      } else {
        addStickyNote(memoId, x, y);
      }
    },
    true /* capture */,
  );
}

// ========================================
// 컨텍스트 감지 & sticky-layer 동적 주입
// ========================================

/** @type {MutationObserver|null} sticky-layer 재배치 전용 */
let _stickyLayerObserver = null;

/** @type {number|null} */
let _stickyLayerTimer = null;

/** @type {Object} */
let _stickyLayerConfig = {};

/** @type {Object|null} bootstrapAssistant에서 주입된 config 보존 (hooks, stickyLayerSelectors 접근용) */
let _assistantConfig = null;

/** @type {boolean} relocateStickyLayer 실행 중 재진입 방지 플래그 */
let _stickyLayerRelocating = false;

/** @type {Element|null} sticky-layer가 현재 추적 중인 타겟 컨테이너 */
let _stickyLayerTargetEl = null;

/** @type {ResizeObserver|null} 타겟 크기 변화 감지 */
let _stickyLayerResizeObserver = null;

/** @type {AbortController|null} scroll 리스너 정리용 */
let _stickyLayerScrollAC = null;

/** @type {MutationObserver|null} .pg-id 미발견 시 DOM 변화 감지 후 relocate 재시도 */
let _resolveRetryObserver = null;

/** @type {string|null} 재시도 옵저버가 대기 중인 menuId */
let _resolveRetryMenuId = null;

/**
 * #sticky-layer(position:fixed)의 top/left/width/height를
 * 타겟의 parentElement 기준 getBoundingClientRect()으로 갱신합니다.
 * parentElement가 없을 경우 타겟 자신의 rect를 사용합니다.
 * 호스트 DOM 스타일 수정 없음.
 */
function _syncStickyLayerBounds() {
  const layer = document.getElementById("sticky-layer");
  if (!layer || !_stickyLayerTargetEl) return;
  if (!_stickyLayerTargetEl.isConnected) {
    layer.style.display = "none";
    return;
  }
  const boundsEl = _stickyLayerTargetEl.parentElement || _stickyLayerTargetEl;
  const r = boundsEl.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  layer.style.setProperty("top", `${r.top}px`, "important");
  layer.style.setProperty("left", `${r.left}px`, "important");
  layer.style.setProperty("width", `${r.width}px`, "important");
  layer.style.setProperty("height", `${r.height}px`, "important");
  layer.style.removeProperty("display");
}

/**
 * MutationObserver를 설정하여 sticky-layer 재배치를 담당합니다.
 *
 * @param {Object} [cfg={}]
 * @param {string} [cfg.containerSelector='.selected']
 *   - sticky-layer를 주입할 활성 화면 컨테이너 셀렉터
 *   - .selected 클래스를 가진 요소 = 화면 컨테이너 div 를 직접 대상으로 합니다.
 */
function setupStickyLayerObserver(cfg = {}) {
  if (_stickyLayerObserver) {
    _stickyLayerObserver.disconnect();
    _stickyLayerObserver = null;
  }

  _stickyLayerConfig = {
    windowContainerClass:
      cfg.windowContainerClass || "w2windowContainer_selectedNameLayer",
    pgIdClass: cfg.pgIdClass || "pg-id",
    // pgEl.parentElement 기준으로 몇 단계 이동할지 (0=기본, 양수=더 내려감, 음수=더 올라감)
    targetDepth: cfg.targetDepth ?? 0,
    // windowContainerClass 요소 발견 후 몇 단계 이동할지 (0=발견된 요소 그대로, 양수=firstElementChild 내려감, 음수=parentElement 올라감)
    anchorDepth: cfg.anchorDepth ?? 0,
    // 앵커 클래스 변경 시 최신 menuId를 반환하는 함수 (호스트 측에서 주입)
    getMenuId: cfg.getMenuId || null,
    // menuId로부터 areaId를 파생하는 함수 (호스트 측에서 주입)
    // 예: getAreaId: (menuId) => menuId.split('-')[0]
    getAreaId: cfg.getAreaId || null,
    // 현재 locale 코드를 반환하는 함수 (선택) — 변경 감지 시 setLocale() 자동 호출
    // 예: getLocale: () => gcm.gv_LANG_CD
    getLocale: cfg.getLocale || null,
    // [IoC] 포스트잇 타겟 컨테이너를 직접 반환하는 함수 (주입 시 클래스 탐색 로직 대체)
    // 예: resolveStickyTarget: (menuId) => document.querySelector(`#screen_${menuId}`)
    resolveStickyTarget: cfg.resolveStickyTarget || null,
    // [IoC] MutationObserver 기준 요소를 직접 반환하는 함수 (주입 시 windowContainerClass 탐색 대체)
    // 예: getObserverAnchor: () => document.getElementById('main-app-container')
    getObserverAnchor: cfg.getObserverAnchor || null,
    _prevLocale: null,
  };

  // getLocale 주입 시: 초기 locale 상태 기록
  if (typeof _stickyLayerConfig.getLocale === "function") {
    _stickyLayerConfig._prevLocale = normalizeLocale(_stickyLayerConfig.getLocale());
  }

  _stickyLayerObserver = new MutationObserver((mutations) => {
    // relocateStickyLayer 실행 중 발생한 DOM 변경은 무시 (무한루프 방지)
    if (_stickyLayerRelocating) return;

    const stickyLayer = document.getElementById("sticky-layer");
    const hasClassChange = mutations.some(
      (m) =>
        m.type === "attributes" &&
        m.attributeName === "class" &&
        // sticky-layer 내부에서 발생한 클래스 변경은 이미지 실쿜 컨테이너 처리에 의한 부수효과 → 무시
        !(stickyLayer && stickyLayer.contains(m.target)),
    );
    if (!hasClassChange) return;

    // locale 변경 감지 (getLocale이 주입된 경우)
    if (typeof _stickyLayerConfig.getLocale === "function") {
      const nextLocale = normalizeLocale(_stickyLayerConfig.getLocale());
      if (nextLocale && nextLocale !== _stickyLayerConfig._prevLocale) {
        _stickyLayerConfig._prevLocale = nextLocale;
        assiConsole.log(`[Assistant] locale 변경 감지 (stickyLayerObserver): ${nextLocale}`);
        setLocale(nextLocale);
      }
    }

    // 윈도우 컨테이너 범위 내 클래스 변경 → getMenuId()로 현재 화면 확인
    // menuId + areaId를 한 번에 전송 → Worker가 STATE_UPDATE 1회만 응답
    // (분리 전송 시 첫 STATE_UPDATE에서 menuId는 신규·areaId는 구값인 채로 리렌더링되는 문제 방지)
    if (typeof _stickyLayerConfig.getMenuId === "function") {
      const newMenuId = _stickyLayerConfig.getMenuId();
      if (newMenuId && newMenuId !== state.selectedMenu) {
        const newAreaId =
          typeof _stickyLayerConfig.getAreaId === "function"
            ? _stickyLayerConfig.getAreaId(newMenuId)
            : null;
        // 로컬 state 먼저 동기 업데이트 (렌더 함수가 즉시 올바른 값 읽도록)
        state.selectedMenu = newMenuId;
        if (newAreaId) state.selectedArea = newAreaId;
        // menuId + areaId 한 번에 전송
        workerSend("CONTEXT_CHANGE", {
          menuId: newMenuId,
          ...(newAreaId ? { areaId: newAreaId } : {}),
        });
        assiConsole.log(
          `[Assistant] 화면 전환 감지 → menuId: ${newMenuId}, areaId: ${state.selectedArea}`,
        );
      }
    }

    if (_stickyLayerTimer) clearTimeout(_stickyLayerTimer);
    _stickyLayerTimer = setTimeout(() => {
      _stickyLayerTimer = null;
      relocateStickyLayer();
    }, 80);
  });

  // 앵커 요소 탐색 후 옵저버 활성화
  // 웹스퀘어 init() 이후 동적으로 DOM이 생성되는 경우를 위해 폴링으로 재시도
  function _attachObserver() {
    let observeTarget;
    if (typeof _stickyLayerConfig.getObserverAnchor === "function") {
      // [IoC] 호스트가 직접 기준 요소를 주입한 경우 우선 사용
      observeTarget = _stickyLayerConfig.getObserverAnchor();
      if (!observeTarget) return false;
    } else {
      // 폴백: windowContainerClass 클래스명으로 앵커 탐색
      const anchorEl = document.querySelector(
        `.${_stickyLayerConfig.windowContainerClass}`,
      );
      if (!anchorEl) return false;
      observeTarget = anchorEl.parentElement || document.body;
    }

    // 기준 요소만 감시 — body 전체 감시보다 범위 최소화
    _stickyLayerObserver.observe(observeTarget, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    // 초기 menuId/areaId 즉시 설정 (옵저버 발화 전에 state를 올바른 값으로)
    // 앵커가 즉시 발견된 경우: INIT 페이로드에 이미 포함됨 (bootstrapAssistant에서 수집)
    // 앵커가 지연 발견된 경우(DOM watcher 경유): Worker가 이미 초기화된 후이므로 CONTEXT_CHANGE 필요
    if (typeof _stickyLayerConfig.getMenuId === "function") {
      const initMenuId = _stickyLayerConfig.getMenuId();
      if (initMenuId) {
        state.selectedMenu = initMenuId;
        const initAreaId =
          typeof _stickyLayerConfig.getAreaId === "function"
            ? _stickyLayerConfig.getAreaId(initMenuId)
            : null;
        if (initAreaId) state.selectedArea = initAreaId;
        // menuId + areaId를 한 번에 전송 (STATE_UPDATE 1회로 감소)
        workerSend("CONTEXT_CHANGE", {
          menuId: initMenuId,
          ...(initAreaId ? { areaId: initAreaId } : {}),
        });
        assiConsole.log(
          `[Assistant] 초기 컨텍스트 설정 → menuId: ${initMenuId}, areaId: ${state.selectedArea}`,
        );
      }
    }

    // 초기 배치
    relocateStickyLayer();
    assiConsole.log("[Assistant] sticky-layer 옵저버 활성화:", _stickyLayerConfig);
    return true;
  }

  if (!_attachObserver()) {
    // 앵커 미발견 → DOM 추가 감지 옵저버로 대기 (웹스퀘어 init() 이후 동적 생성 대응)
    assiConsole.warn(
      `[Assistant] .${_stickyLayerConfig.windowContainerClass} 미발견 → DOM 추가 감지 대기 중`,
    );
    const _domWatcher = new MutationObserver(() => {
      if (_attachObserver()) {
        _domWatcher.disconnect();
      }
    });
    _domWatcher.observe(document.body, { subtree: true, childList: true });
  }
}

/**
/**
 * sticky-layer 주입 타겟 탐색
 *
 *   .{windowContainerClass} (앵커) 범위 내 .{pgIdClass} 를 모두 탐색하여
 *   innerText === state.selectedMenu 인 요소의 부모를 타겟으로 사용.
 *   → 여러 .pg-id 가 존재하는 내부시스템에서 현재 화면과 레이어가 항상 일치함.
 *   → state 를 건드리지 않으므로 race condition 없음.
 */
// windowContainerClass 자체가 DOM에 없을 때 반환하는 sentinel (pg-id 미발견과 구분)
const _ANCHOR_MISSING = Symbol("ANCHOR_MISSING");
function _resolveTargetContainer() {
  const cfg = _stickyLayerConfig;
  const currentMenuId = state.selectedMenu;

  // [IoC] resolveStickyTarget 주입 시 호스트 함수 우선 호출 (폴백: 클래스 탐색)
  if (typeof cfg.resolveStickyTarget === "function") {
    return cfg.resolveStickyTarget(currentMenuId) ?? null;
  }

  const anchorClass = cfg.windowContainerClass;
  const pgIdClass = cfg.pgIdClass || "pg-id";

  if (!currentMenuId || !anchorClass) return null;

  let anchorEl = document.querySelector(`.${anchorClass}`);
  if (!anchorEl) {
    assiConsole.warn(`[Assistant] _resolveTargetContainer: .${anchorClass} 미발견`);
    return _ANCHOR_MISSING;
  }

  // anchorDepth: 발견된 anchorEl 기준으로 추가 이동 (0=그대로, 양수=firstElementChild 내려감, 음수=parentElement 올라감)
  const anchorDepth = cfg.anchorDepth ?? 0;
  if (anchorDepth > 0) {
    for (let i = 0; i < anchorDepth; i++) {
      anchorEl = anchorEl.firstElementChild || anchorEl;
    }
  } else if (anchorDepth < 0) {
    for (let i = 0; i < -anchorDepth; i++) {
      anchorEl = anchorEl.parentElement || anchorEl;
    }
  }

  // anchorEl 범위 내에서 pg-id 텍스트가 현재 menuId와 일치하는 요소를 찾는다
  const allPgEls = anchorEl.querySelectorAll(`.${pgIdClass}`);
  const pgEl = Array.from(allPgEls).find(
    (el) => el.textContent.trim() === currentMenuId,
  );

  if (!pgEl) {
    assiConsole.warn(`[Assistant] _resolveTargetContainer: .${anchorClass} 내 "${currentMenuId}" 미발견`);
    return null;
  }

  // depth=0 : pgEl.parentElement (기본)
  // depth>0 : 그 안으로 더 내려감 (firstElementChild 반복)
  // depth<0 : 더 위로 올라감 (parentElement 반복)
  let el = pgEl.parentElement;
  if (!el) return null;

  const depth = cfg.targetDepth ?? 0;
  if (depth > 0) {
    for (let i = 0; i < depth; i++) {
      el = el.firstElementChild || el;
    }
  } else if (depth < 0) {
    for (let i = 0; i < -depth; i++) {
      el = el.parentElement || el;
    }
  }

  return el || null;
}

/**
 * #sticky-layer를 타겟의 positioned 조상에 appendChild하고 JS로 bounds를 동기화합니다.
 *
 * ▸ 타겟 컨테이너에 직접 append하지 않으므로 타겟 내부 레이아웃 영향 없음
 * ▸ host DOM 스타일(position 등) 수정 없음
 * ▸ document.body 직속 유지 — 호스트 DOM 수정 없음
 * ▸ ResizeObserver + scroll 리스너로 bounds 자동 동기화
 * ▸ rAF 2회 지연 렌더로 순간이동 깜빡임 방지
 */

/**
 * sticky-layer 가시 상태를 관리하는 전용 헬퍼.
 * display / visibility 두 속성을 항상 쌍으로 처리해
 * 각 속성을 개별 코드에서 흩어 쓸 때 생기는 불일치를 방지합니다.
 *
 * @param {'show'|'hide'|'pending'} mode
 *   'show'    - 완전 표시  (display:'', visibility:'')
 *   'hide'    - 완전 숨김  (display:'none', visibility:'')
 *   'pending' - 레이아웃 준비 중 (display:'', visibility:'hidden')
 *               rAF 완료 후 반드시 _setStickyLayerVisibility('show') 호출 필요
 */
function _setStickyLayerVisibility(layer, mode) {
  if (!layer) return;
  switch (mode) {
    case 'show':
      layer.style.display = '';
      layer.style.visibility = '';
      break;
    case 'hide':
      layer.style.display = 'none';
      layer.style.visibility = '';
      break;
    case 'pending':
      layer.style.display = '';
      layer.style.visibility = 'hidden';
      break;
  }
}

function relocateStickyLayer() {
  if (_stickyLayerRelocating) return;
  saveAllDirtyNotes(); // 화면 컨텍스트 전환 전 미저장 내용 강제 플러시

  let layer = document.getElementById("sticky-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "sticky-layer";
  }
  // 항상 body 직속 유지 — #assistant-root(z-index:2000) 앞에 삽입해
  // DOM 순서와 z-index(1000<2000) 두 경로 모두 sticky < assistant 를 보장합니다.
  // (appendChildlike 후 삽입 시 일부 브라우저에서 DOM 순서가 z-index를 역전시키는 버그 방지)
  const _assistantRoot = document.getElementById("assistant-root");
  if (layer.parentElement !== document.body) {
    if (_assistantRoot && _assistantRoot.parentElement === document.body) {
      document.body.insertBefore(layer, _assistantRoot);
    } else {
      document.body.appendChild(layer);
    }
  } else if (
    _assistantRoot &&
    _assistantRoot.parentElement === document.body &&
    _assistantRoot.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING
  ) {
    // 이미 body에 있지만 #assistant-root 뒤에 있는 경우 → 앞으로 이동
    document.body.insertBefore(layer, _assistantRoot);
  }


  // menuId가 바뀌었을 때만 재시도 옵저버 해제
  // (같은 menuId를 이미 기다리는 중이라면 옵저버를 유지 → warn 로그 반복 방지)
  if (_resolveRetryObserver && _resolveRetryMenuId !== state.selectedMenu) {
    _resolveRetryObserver.disconnect();
    _resolveRetryObserver = null;
  }

  const targetElement = _resolveTargetContainer();

  // ── windowContainerClass 자체가 DOM에 없는 경우 ──
  // sticky-layer DOM 제거 + 화면 ID 초기화 (pg-id 미발견과 구분)
  if (targetElement === _ANCHOR_MISSING) {
    _setStickyLayerVisibility(layer, 'hide');
    if (_stickyLayerResizeObserver) {
      _stickyLayerResizeObserver.disconnect();
      _stickyLayerResizeObserver = null;
    }
    if (_stickyLayerScrollAC) {
      _stickyLayerScrollAC.abort();
      _stickyLayerScrollAC = null;
    }
    _stickyLayerTargetEl = null;
    // 화면 ID 초기화 (컨텍스트 무효)
    if (state.selectedMenu) {
      assiConsole.warn(`[Assistant] windowContainerClass 소실 → selectedMenu(${state.selectedMenu}) 초기화`);
      state.selectedMenu = null;
      workerSend("CONTEXT_CHANGE", { menuId: null });
    }
    _stickyLayerRelocating = false;
    return;
  }
  if (_stickyLayerTargetEl === targetElement && targetElement) {
    _syncStickyLayerBounds();
    renderStickyNotes();
    return;
  }

  _stickyLayerRelocating = true;

  // ① 이전 ResizeObserver 정리
  if (_stickyLayerResizeObserver) {
    _stickyLayerResizeObserver.disconnect();
    _stickyLayerResizeObserver = null;
  }

  if (_stickyLayerScrollAC) {
    _stickyLayerScrollAC.abort();
    _stickyLayerScrollAC = null;
  }

  // ② 전환 중 포스트잇 즉시 숨김 (순간이동 방지)
  _setStickyLayerVisibility(layer, 'pending');
  layer.innerHTML = "";

  _stickyLayerTargetEl = targetElement;

  if (targetElement && targetElement.isConnected) {
    // ③ ResizeObserver: 타겟 및 부모 컨테이너 크기 변화 → bounds 재계산
    _stickyLayerResizeObserver = new ResizeObserver(() =>
      _syncStickyLayerBounds(),
    );
    _stickyLayerResizeObserver.observe(targetElement);
    if (targetElement.parentElement) {
      _stickyLayerResizeObserver.observe(targetElement.parentElement);
    }

    // ③ rAF 2회: 레이아웃 확정 후 bounds 주입 → 렌더 → 표시
    // _setStickyLayerVisibility('pending') 상태에서 진입하므로
    // display는 이미 '' — visibility만 rAF 완료 후 복원
    requestAnimationFrame(() => {
      _syncStickyLayerBounds();
      renderStickyNotes();
      requestAnimationFrame(() => {
        _setStickyLayerVisibility(layer, 'show');
      });
    });

    // ④ Scroll 리스너: 스크롤 시 sticky-layer bounds 재동기화
    // capture:true 로 window 하위 모든 스크롤 이벤트를 단일 리스너로 포착
    _stickyLayerScrollAC = new AbortController();
    window.addEventListener("scroll", _syncStickyLayerBounds, {
      passive: true,
      capture: true,
      signal: _stickyLayerScrollAC.signal,
    });

    assiConsole.log(
      `[Assistant] sticky-layer fixed → 타겟: ${targetElement.tagName}#${targetElement.id || ""}`,
    );
  } else {
    _setStickyLayerVisibility(layer, 'hide');
    assiConsole.log("[Assistant] sticky-layer 비활성화 (대상 없음)");

    // pg-id 미발견 시 DOM 변화 감지 후 relocate 재시도
    // ① 같은 menuId를 이미 기다리는 중이면 옵저버 재생성 금지 → 무한 재호출 차단
    if (!_resolveRetryObserver && state.selectedMenu) {
      _resolveRetryMenuId = state.selectedMenu;
      const _retryAnchorEl = document.querySelector(
        `.${_stickyLayerConfig.windowContainerClass}`,
      );
      if (_retryAnchorEl) {
        _resolveRetryObserver = new MutationObserver(() => {
          // ② pg-id 텍스트가 selectedMenu와 일치할 때만 relocate 재시도
          //    일치하지 않으면 아무것도 하지 않고 계속 대기
          //    → relocateStickyLayer() 미호출 = 옵저버 재생성 없음 = 무한루프 차단
          const found = _resolveTargetContainer();
          if (found) {
            _resolveRetryObserver.disconnect();
            _resolveRetryObserver = null;
            _resolveRetryMenuId = null;
            relocateStickyLayer();
          }
        });
        // childList/characterData 감시: pg-id 텍스트 갱신 감지용
        // (class 변화 감시 시 CSS 전환 애니메이션마다 발화 → 과호출 위험)
        _resolveRetryObserver.observe(
          _retryAnchorEl.parentElement || document.body,
          { subtree: true, childList: true, characterData: true },
        );
        assiConsole.log(
          `[Assistant] pg-id retry 감시 시작 → 대기 menuId: "${_resolveRetryMenuId}"`,
        );
      }
    }
  }

  _stickyLayerRelocating = false;
}

// ── [6-D] 메모 렌더링 ────────────────────────────────────────────────────────
/**
 * renderMemoItemDOM(memo) - 메모 아이템 하나의 DOM 요소를 생성하는 컴포넌트 함수.
 * HTML 문자열 대신 DOM을 직접 빌드하여 이벤트를 addEventListener로 바인딩합니다.
 * @param {Object} memo - 메모 데이터 객체
 * @returns {HTMLElement} - 완성된 메모 아이템 DOM 요소
 */
function renderMemoItemDOM(memo) {
  // ── 루트 컨테이너 ──
  const item = createElement("div", {
    className: "imsmassi-memo-item",
    "data-id": memo.id,
  });
  if (memo.pinned) {
    item.classList.add("imsmassi-memo-item-pinned");
    // --memo-pin-border는 CSS .imsmassi-memo-item-pinned { --memo-pin-border: var(--imsmassi-area-color) }에서 자동 연결
  } else {
    item.classList.add("imsmassi-memo-item-normal");
  }

  // ── 헤더 (드래그 핸들) ──
  const header = createElement("div", {
    className: "imsmassi-memo-item-header imsmassi-memo-drag-handle",
    draggable: "true",
  });
  header.addEventListener("dragstart", (e) => handleMemoDragStart(e, memo.id));

  // 헤더 좌측: 고정 버튼 + 제목 + 알림 시간 뱃지
  const headerLeft = createElement("div", {
    className: "imsmassi-memo-header-left",
  });

  const pinBtn = createElement("button", {
    className: "imsmassi-memo-header-pin-btn",
    draggable: "false",
    title: memo.pinned ? t("memoTab.unpinTitle") : t("memoTab.pinTitle"),
  });
  pinBtn.addEventListener("click", () => togglePin(memo.id));
  pinBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  const titleSpan = createElement("span", {
    className: "imsmassi-memo-title-editable",
    contenteditable: "true",
    "data-memo-id": memo.id,
    "data-placeholder": t("memoTab.titleLabel"),
    draggable: "false",
  });
  titleSpan.textContent = memo.title || "";
  titleSpan.addEventListener("blur", () =>
    saveMemoTitle(memo.id, titleSpan.innerText.trim()),
  );
  titleSpan.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      titleSpan.blur();
    }
  });
  titleSpan.addEventListener("mousedown", (e) => e.stopPropagation());

  headerLeft.append(pinBtn, titleSpan);

  const reminderTime = memo.reminder ? memo.reminder.split(" ")[1] || "" : "";
  if (reminderTime) {
    const reminderBadge = createElement("span", {
      className: "imsmassi-memo-reminder-badge",
    });
    reminderBadge.innerHTML = `${ICONS.time} ${reminderTime}`;
    headerLeft.appendChild(reminderBadge);
  }

  // 헤더 우측: 삭제 버튼
  const headerRight = createElement("div", {
    className: "imsmassi-memo-header-right",
  });

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-header-delete-btn",
    draggable: "false",
    title: t("memoTab.deleteTitle"),
  });
  deleteBtn.addEventListener("click", () => openDeleteConfirmModal(memo.id));
  deleteBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  headerRight.appendChild(deleteBtn);
  header.append(headerLeft, headerRight);

  // ── 콘텐츠 ──
  const contentDiv = createElement("div", {
    className: "imsmassi-memo-item-content",
  });
  if (isQuillAvailable()) {
    const inlineHtml = memo.isRichText
      ? sanitizeHtml(memo.content || "")
      : escapeHtml(getMemoPlainText(memo)).replace(/\n/g, "<br>");
    const inlineEditor = createElement("div", {
      className: "imsmassi-memo-inline-editor",
      "data-memo-id": memo.id,
      "data-content": encodeURIComponent(inlineHtml),
    });
    contentDiv.appendChild(inlineEditor);
  } else {
    const inlineText = createElement("div", {
      className: "imsmassi-memo-inline-text",
      contenteditable: "true",
      "data-memo-id": memo.id,
    });
    inlineText.innerHTML = escapeHtml(getMemoPlainText(memo)); // 이미 escape된 안전한 문자열
    inlineText.addEventListener("blur", () => saveInlineMemoEdit(memo.id));
    contentDiv.appendChild(inlineText);
  }

  // ── 날짜 행 (날짜 + 컨텍스트 바 토글) ──
  const dateRow = createElement("div", {
    className: "imsmassi-memo-date-row",
  });

  const dateSpan = createElement("span", { className: "imsmassi-memo-date" });
  dateSpan.textContent = memo.date;
  dateRow.appendChild(dateSpan);

  // ── 하단 푸터 (화면ID · 스티커추가 · 알림설정) ──
  const footer = createElement("div", {
    className: "imsmassi-memo-item-tags imsmassi-memo-item-footer",
  });

  const createdAreaName = memo.menuId;

  const originBadge = createElement("span", {
    className: "imsmassi-memo-origin-badge",
  });
  originBadge.textContent = createdAreaName;

  const currentMenu = state.selectedMenu;
  const currentStickyNote = (state.stickyNotes || []).find(
    (n) => n.memoId === memo.id && (!currentMenu || n.menuId === currentMenu),
  );
  const hasStickyNote = !!currentStickyNote;
  // 뷰포트 밖 여부 (현재 메뉴에 포스트잇이 있을 때만 체크)
  const isStickyOutOfView =
    hasStickyNote && isStickyNoteOutOfViewport(currentStickyNote);
  const actionsDiv = createElement("div", {
    className: "imsmassi-memo-actions",
  });

  const screenBtn = createElement("button", {
    className: `imsmassi-memo-action-btn imsmassi-screen-btn${hasStickyNote ? " imsmassi-screen-btn-active" : ""}${isStickyOutOfView ? " imsmassi-screen-btn-offview" : ""}`,
    draggable: "false",
    title: isStickyOutOfView ? t("memoTab.offScreenBadgeTitle") : hasStickyNote ? t("memoTab.btnRemoveSticky") : t("memoTab.btnAddSticky"),
  });
  screenBtn.innerHTML = `${isStickyOutOfView ? t("memoTab.offScreenBadge") : hasStickyNote ? t("memoTab.btnRemoveSticky") : t("memoTab.btnAddSticky")}`;
  // --screen-btn-color/shadow는 CSS .imsmassi-screen-btn:not(.imsmassi-screen-btn-active)에서 var(--imsmassi-area-color)로 자동 연결
  screenBtn.addEventListener("click", () => createStickyNoteForMemo(memo.id));
  screenBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  const reminderBtn = createElement("button", {
    className: `imsmassi-memo-action-btn imsmassi-reminder-btn${memo.reminder ? " imsmassi-reminder-btn-active" : ""}`,
    draggable: "false",
    title: memo.reminder ? t("memoTab.reminderEditTitle") : t("memoTab.reminderSetTitle"),
  });
  reminderBtn.innerHTML = `${memo.reminder ? t("memoTab.btnClearReminder") : t("memoTab.btnSetReminder")}`;
  reminderBtn.addEventListener("click", () => openReminderModal(memo.id));
  reminderBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  actionsDiv.append(screenBtn, reminderBtn);

  footer.append(originBadge, actionsDiv);

  item.append(header, contentDiv, dateRow, footer);

  return item;
}

// ========================================
// 메모 탭 렌더러 (DOM 기반)
// ========================================
/**
 * renderMemoTab() - 메모 탭 전체 레이아웃을 DOM으로 빌드하여 반환합니다.
 * renderMemoItemDOM 컴포넌트를 조립하는 역할만 수행합니다.
 * @returns {HTMLElement} - 완성된 메모 탭 레이아웃 DOM 요소
 */
function renderMemoTab() {
  const area = getArea();
  const allMemos = Object.values(state.memos || {});
  const getMemoTime = (memo) =>
    Number.isFinite(memo?.createdAt)
      ? memo.createdAt
      : Date.parse(memo?.date || "") || 0;
  const sortByTimeDesc = (a, b) => getMemoTime(b) - getMemoTime(a);

  // ── 필터 적용 ──────────────────────────────────────────
  const currentFilter = state.memoFilter || "menu";
  let filteredMemos;
  if (currentFilter === "menu") {
    // menuId만으로 화면을 완전히 특정 — areaId 이중 검사 불필요
    // (menuId/areaId가 별도 STATE_UPDATE로 오는 타이밍 차에 메모 목록이 비는 문제 방지)
    filteredMemos = allMemos.filter(
      (m) =>
        m.menuId === state.selectedMenu ||
        m.labels?.includes(state.selectedMenu),
    );
  } else if (currentFilter === "area") {
    filteredMemos = allMemos.filter(
      (m) =>
        m.createdAreaId === state.selectedArea ||
        m.areaId === state.selectedArea,
    );
  } else {
    filteredMemos = allMemos;
  }

  const pinnedMemos = filteredMemos
    .filter((memo) => memo.pinned)
    .sort(sortByTimeDesc);
  const unpinnedMemos = filteredMemos
    .filter((memo) => !memo.pinned)
    .sort(sortByTimeDesc);
  const memos = [...pinnedMemos, ...unpinnedMemos];
  const useQuill = isQuillAvailable();
  const isExpanded = !!state.isMemoPanelExpanded;

  // ── 메모 에디터 영역 ──
  let editorSection;
  if (useQuill) {
    editorSection = createElement("div", {
      className: "imsmassi-memo-quill-wrapper",
      id: "memo-editor-wrapper",
    });
    // CSS .imsmassi-memo-quill-wrapper에서 --memo-* 변수가 var(--imsmassi-*)로 자동 연결되므로 JS 주입 불필요
    const editorDiv = createElement("div", {
      id: "imsmassi-memo-editor",
      className: "imsmassi-memo-editor",
    });
    const capacityDiv = createElement("div", {
      id: "imsmassi-memo-capacity",
      className: "imsmassi-memo-capacity",
    });
    // 기본 색상은 CSS .imsmassi-memo-capacity { color: var(--imsmassi-sub-text) }
    capacityDiv.textContent = "0 B / 2 MB";
    editorSection.append(editorDiv, capacityDiv);
  } else {
    editorSection = createElement("div", {
      className: "imsmassi-memo-editor-fallback",
    });
    // position: relative는 CSS .imsmassi-memo-editor-fallback에서 지정
    const textarea = createElement("div", {
      className: "imsmassi-memo-textarea",
      id: "memo-input",
      contenteditable: "true",
      placeholder: t("ui.memoPlaceholder", {areaName: area.name}),
    });
    // 기본 색상은 CSS .imsmassi-memo-textarea { color: var(--imsmassi-text); border-color: var(--imsmassi-border) }
    // placeholder 표시용 클래스 관리 (contenteditable은 :empty가 <br>로 인해 동작 안 함)
    const _updateEmptyClass = () => {
      const isEmpty =
        textarea.innerText.trim() === "" ||
        textarea.innerHTML === "" ||
        textarea.innerHTML === "<br>";
      textarea.classList.toggle("imsmassi-is-empty", isEmpty);
    };
    textarea.classList.add("imsmassi-is-empty"); // 초기 빈 상태
    textarea.addEventListener("focus", () => {
      textarea.classList.remove("imsmassi-is-empty");
      // Task 3: 포커스 시 .imsmassi-focused 클래스를 추가 (border-color, box-shadow는 CSS에서 var 참조)
      textarea.classList.add("imsmassi-focused");
    });
    textarea.addEventListener("blur", () => {
      _updateEmptyClass();
      // Task 3: 포커스 해제 시 .imsmassi-focused 클래스 제거
      textarea.classList.remove("imsmassi-focused");
    });
    textarea.addEventListener("paste", (e) => handleMemoPaste(e));
    textarea.addEventListener("keydown", (e) => handleMemoKeydown(e));
    textarea.addEventListener("input", () => {
      updateMemoCapacity();
      _updateEmptyClass();
    });
    const capacityDiv = createElement("div", {
      id: "imsmassi-memo-capacity",
      className: "imsmassi-memo-capacity",
    });
    // 기본 색상은 CSS .imsmassi-memo-capacity { color: var(--imsmassi-sub-text) }
    capacityDiv.textContent = "0 B / 2 MB";
    editorSection.append(textarea, capacityDiv);
  }

  // ── 옵션 바 (추가 / 패널 토글) ──
  const optionsBar = createElement("div", {
    className: "imsmassi-memo-options",
  });
  const addBtn = createElement("button", {
    className: "imsmassi-memo-option-btn",
  });
  addBtn.textContent = t("ui.btnMemoAdd");
  addBtn.addEventListener("click", addMemo);
  // [Task 4] 구버전 사이드 토글 버튼 제거 (기능은 .imsmassi-btn-collapse-expand 로 이관)
  optionsBar.append(addBtn);

  const mainSection = createElement("div", { className: "imsmassi-memo-main" });
  mainSection.append(editorSection, optionsBar);

  // ── 사이드 패널 (클립보드 · 템플릿 카드) ──
  const sidePanel = createElement("div", {
    className: `imsmassi-memo-side${isExpanded ? "" : " imsmassi-hidden"}`,
    id: "memo-side-panel",
  });
  const sidePanelContent = createElement("div", {
    className: "imsmassi-memo-side-content",
  });

  // 클립보드 카드
  const clipboardCard = createElement("div", {
    className: "imsmassi-memo-card",
    id: "memo-card-clipboard",
  });
  // 기본 색상은 CSS .imsmassi-memo-card { border-color: var(--imsmassi-border) }
  const clipboardCardHeader = createElement("div", {
    className: "imsmassi-memo-card-header",
  });
  // 기본 색상은 CSS .imsmassi-memo-card-header { color: var(--imsmassi-text) }
  const clipboardTitleSpan = createElement("span");
  clipboardTitleSpan.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-clipboard"></span>${t("memoTab.clipboardPanelHeader")}`;
  clipboardCardHeader.appendChild(clipboardTitleSpan);
  const clipboardBody = createElement("div", {
    className: "imsmassi-memo-card-body",
    id: "clipboard-panel-body",
  });
  clipboardBody.appendChild(renderClipboardTabDOM());
  clipboardCard.append(clipboardCardHeader, clipboardBody);

  // 템플릿 카드
  const templateCard = createElement("div", {
    className: "imsmassi-memo-card",
    id: "memo-card-template",
  });
  // 기본 색상은 CSS .imsmassi-memo-card { border-color: var(--imsmassi-border) }
  const templateCardHeader = createElement("div", {
    className: "imsmassi-memo-card-header",
  });
  // 기본 색상은 CSS .imsmassi-memo-card-header { color: var(--imsmassi-text) }
  const templateTitleSpan = createElement("span");
  templateTitleSpan.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-template"></span>${t("memoTab.templatePanelHeader")}`;
  const addTemplateBtn = createElement("button", {
    className: "imsmassi-memo-option-btn imsmassi-template-add-btn",
  });
  // 테두리 색상은 CSS .imsmassi-template-add-btn { border-color: var(--imsmassi-area-color) }
  addTemplateBtn.innerHTML = `<img src="${_ASSI_ASSET_BASE}images/ico_template_add.svg" width="16" height="16" alt="" style="vertical-align:middle"> ${t("ui.btnTemplateNew")}`;
  addTemplateBtn.addEventListener("click", openAddTemplateModal);
  templateCardHeader.append(templateTitleSpan, addTemplateBtn);
  const templateBody = createElement("div", {
    className: "imsmassi-memo-card-body",
  });
  templateBody.appendChild(renderTemplateTabDOM());
  templateCard.append(templateCardHeader, templateBody);

  sidePanelContent.append(clipboardCard, templateCard);
  sidePanel.appendChild(sidePanelContent);

  // ── 메모 리스트 영역 ──
  const listArea = createElement("div", {
    className: "imsmassi-memo-list-area",
  });
  const listHeader = createElement("div", {
    className: "imsmassi-memo-list-header",
  });
  // 기본 색상은 CSS .imsmassi-memo-list-header { color: var(--imsmassi-sub-text) }

  const filterBar = createElement("div", {
    className: "imsmassi-memo-filter-bar",
  });
  [
    [
      "menu",
      t("memoTab.filterCurrentScreen"),
      `<span class="imsmassi-fi imsmassi-fi--screen"></span>`,
    ],
    [
      "area",
      t("memoTab.filterCurrentArea"),
      `<span class="imsmassi-fi imsmassi-fi--area"></span>`,
    ],
    [
      "all",
      t("memoTab.filterAll"),
      `<span class="imsmassi-fi imsmassi-fi--all"></span>`,
    ],
  ].forEach(([val, label, icon]) => {
    const filterBtn = createElement("button", {
      className: `imsmassi-memo-filter-btn${currentFilter === val ? " imsmassi-memo-filter-active" : ""}`,
    });
    // --filter-color는 CSS .imsmassi-memo-filter-btn { --filter-color: var(--imsmassi-area-color) }에서 자동 연결
    filterBtn.innerHTML = icon + "<br>" + label;
    filterBtn.addEventListener("click", () => setMemoFilter(val));
    filterBar.appendChild(filterBtn);
  });
  const memoCountSpan = createElement("span", {
    className: "imsmassi-memo-count",
  });
  memoCountSpan.innerHTML = t("memoTab.countLabel", {count: `<span class="imsmassi-memo-count-num">${memos.length}</span>`});
  listHeader.append(filterBar, memoCountSpan);
  listArea.appendChild(listHeader);

  // 빈 메시지 헬퍼
  const makeEmptyMsg = (text) => {
    const msg = createElement("div", { className: "imsmassi-memo-empty-msg" });
    // 기본 색상은 CSS .imsmassi-memo-empty-msg { color: var(--imsmassi-sub-text) }
    msg.textContent = text;
    return msg;
  };

  // 메모 목록 렌더링: renderMemoItemDOM 컴포넌트를 조립합니다.
  if (!isExpanded) {
    // 단일 리스트 모드
    if (memos.length === 0) {
      listArea.appendChild(makeEmptyMsg(t("memoTab.listEmpty")));
    } else {
      memos.forEach((memo) => listArea.appendChild(renderMemoItemDOM(memo)));
    }
  } else {
    // 2단 분할 모드 (일반 / 고정)
    const splitDiv = createElement("div", {
      className: "imsmassi-memo-list-split",
    });

    const unpinnedCol = createElement("div", {
      className: "imsmassi-memo-list-column",
    });
    const unpinnedSubheader = createElement("div", {
      className: "imsmassi-memo-list-subheader",
    });
    // 기본 색상은 CSS .imsmassi-memo-list-subheader { color: var(--imsmassi-sub-text) }
    unpinnedSubheader.textContent = t("memoTab.generalSubheader", {count: unpinnedMemos.length});
    unpinnedCol.appendChild(unpinnedSubheader);
    if (unpinnedMemos.length === 0) {
      unpinnedCol.appendChild(makeEmptyMsg(t("memoTab.generalEmpty")));
    } else {
      unpinnedMemos.forEach((memo) =>
        unpinnedCol.appendChild(renderMemoItemDOM(memo)),
      );
    }

    const pinnedCol = createElement("div", {
      className: "imsmassi-memo-list-column",
    });
    const pinnedSubheader = createElement("div", {
      className: "imsmassi-memo-list-subheader",
    });
    // 기본 색상은 CSS .imsmassi-memo-list-subheader { color: var(--imsmassi-sub-text) }
    pinnedSubheader.textContent = t("memoTab.pinnedSubheader", {count: pinnedMemos.length});
    pinnedCol.appendChild(pinnedSubheader);
    if (pinnedMemos.length === 0) {
      pinnedCol.appendChild(makeEmptyMsg(t("memoTab.pinnedEmpty")));
    } else {
      pinnedMemos.forEach((memo) =>
        pinnedCol.appendChild(renderMemoItemDOM(memo)),
      );
    }

    splitDiv.append(unpinnedCol, pinnedCol);
    listArea.appendChild(splitDiv);
  }

  // ── 루트 레이아웃 조립 ──
  const root = createElement("div", {
    className: `imsmassi-memo-layout${isExpanded ? "" : " imsmassi-panel-hidden"}`,
    id: "imsmassi-memo-layout",
  });
  root.append(mainSection, sidePanel, listArea);
  return root;
}

function setMemoFilter(filter) {
  if (!["menu", "area", "all"].includes(filter)) return;
  if (state.memoFilter === filter) return;
  state.memoFilter = filter;
  // 내부 시스템 환경에서 Worker 응답 지연 시에도 즉시 UI 반영 (낙관적 업데이트)
  renderAssistantContent();
  if (workerPort) {
    // Worker 상태에도 반영 → 이후 CONTEXT_CHANGE 등 STATE_UPDATE가 와도 필터가 초기화되지 않음
    workerSend("SAVE_UI_PREFS", { memoFilter: filter });
  } else {
    // SharedWorker 미지원 폴백: 직접 DB 저장
    if (db)
      db.transaction("settings", "readwrite", (store) =>
        store.put(filter, "memoFilter"),
      ).catch(() => {});
  }
}

function toggleMemoSidePanel() {
  // 버튼 클릭 시 커스텀 너비를 초기화해 CSS 기본값(360px/640px)으로 복원
  state.panelWidthCollapsed = null;
  state.panelWidthExpanded = null;

  // 패널 인라인 너비도 즉시 제거
  const _fp = document.getElementById("imsmassi-floating-panel");
  if (_fp) _fp.style.width = "";

  state.isMemoPanelExpanded = !state.isMemoPanelExpanded;

  // 패널 너비/클래스는 탭과 무관하게 즉시 반영
  updateMemoSidePanelState();

  // 메모 탭일 때만 콘텐츠 리렌더링 (imsmassi-memo-layout 존재 시)
  if (state.activeTab === "memo") {
    renderAssistantContent();
  }

  // Worker 상태 동기화 (너비값도 함께 저장)
  workerSend("SAVE_UI_PREFS", {
    isMemoPanelExpanded: state.isMemoPanelExpanded,
    panelWidthCollapsed: state.panelWidthCollapsed ?? null,
    panelWidthExpanded: state.panelWidthExpanded ?? null,
  });
}

function updateMemoSidePanelState() {
  const layout = document.getElementById("imsmassi-memo-layout");
  const floatingPanel = document.getElementById("imsmassi-floating-panel");
  if (!floatingPanel) return; // layout은 메모 탭에만 존재하므로 null 허용
  const isHidden = !state.isMemoPanelExpanded;

  if (isHidden) {
    // ── 접기(collapsed) 상태 DOM 반영
    const pw = state.panelWidthCollapsed;
    floatingPanel.style.width = pw ? `${pw}px` : "";
  } else {
    // ── 펼친(expanded) 상태 DOM 반영
    const pw = state.panelWidthExpanded;
    floatingPanel.style.width = pw ? `${pw}px` : "";
  }

  floatingPanel.classList.toggle("imsmassi-expanded", !isHidden);
  if (layout) {
    layout.classList.toggle("imsmassi-panel-hidden", isHidden);
  }

  // memo-main max-width 동기화
  const memoMain = document.querySelector("#assistant-root .imsmassi-memo-main");
  if (memoMain) {
    const effectiveWidth = isHidden ? state.panelWidthCollapsed : state.panelWidthExpanded;
    memoMain.style.maxWidth = effectiveWidth ? `${effectiveWidth - 25}px` : "";
  }
}

// ============================================================================
// [Section 7] FEATURE: CLIPBOARD & TEMPLATES  📋 클립보드 및 템플릿
// ============================================================================
// [7-A] 클립보드 액션: addClipboardItem, copyToClipboard, deleteClipboardItem
// [7-B] 템플릿 액션: useTemplate, confirmAddTemplate, confirmEditTemplate
// [7-C] 렌더링: renderClipboardItemDOM, renderClipboardTab, renderTemplateTab
// ============================================================================
/**
 * renderClipboardItemDOM(item) - 클립보드 아이템 하나의 DOM 요소를 생성합니다.
 * textContent를 사용하여 XSS를 원천 차단합니다.
 */
function renderClipboardItemDOM(item) {
  const menuId = item.menuId || item.menu;
  const relativeTime = item.timestamp
    ? getRelativeTime(item.timestamp)
    : item.time || t("clipboardTab.justNow");

  const itemDiv = createElement("div", {
    className: "imsmassi-clipboard-item",
  });
  itemDiv.addEventListener("click", () => copyToClipboard(item.content));

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-delete-btn",
  });
  // 기본 색상은 CSS .imsmassi-memo-delete-btn { color: var(--imsmassi-sub-text) }
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteClipboardItem(item.id);
  });

  const contentDiv = createElement("div", {
    className: "imsmassi-clipboard-item-content",
  });
  // 기본 색상은 CSS .imsmassi-clipboard-item-content { color: var(--imsmassi-text) }
  contentDiv.textContent = item.content; // textContent로 XSS 방지

  const metaDiv = createElement("div", {
    className: "imsmassi-clipboard-item-meta",
  });
  // 기본 색상은 CSS .imsmassi-clipboard-item-meta { color: var(--imsmassi-sub-text) }
  const menuSpan = createElement("span");
  menuSpan.textContent = menuId || "";
  const timeSpan = createElement("span");
  timeSpan.textContent = relativeTime;
  metaDiv.append(menuSpan, timeSpan);
  itemDiv.append(deleteBtn, contentDiv, metaDiv);
  return itemDiv;
}

/**
 * renderClipboardTabDOM() - 클립보드 탭 전체 DOM을 빌드하여 반환합니다.
 */
function renderClipboardTabDOM() {
  const items = Array.isArray(state.clipboard) ? state.clipboard : [];
  const container = createElement("div");

  const header = createElement("div", {
    className: "imsmassi-clipboard-header",
  });
  // 기본 색상은 CSS .imsmassi-clipboard-header { color: var(--imsmassi-sub-text) }
  const headerSpan = createElement("span");
  headerSpan.textContent = t("clipboardTab.header");
  header.appendChild(headerSpan);
  container.appendChild(header);

  if (items.length === 0) {
    const empty = createElement("div", {
      className: "imsmassi-memo-empty-msg",
    });
    // 기본 색상은 CSS .imsmassi-memo-empty-msg { color: var(--imsmassi-sub-text) }
    empty.textContent = t("clipboardTab.listEmpty");
    container.appendChild(empty);
  } else {
    items.forEach((item) =>
      container.appendChild(renderClipboardItemDOM(item)),
    );
  }

  const hint = createElement("div", { className: "imsmassi-clipboard-hint" });
  // 기본 색상은 CSS .imsmassi-clipboard-hint { color: var(--imsmassi-sub-text) }
  hint.textContent = t("clipboardTab.usageHint");
  container.appendChild(hint);
  return container;
}

// 하위 호환용 래퍼 (기존 호출부에서 사용 시 DOM 노드 반환)
function renderClipboardTab() {
  return renderClipboardTabDOM();
}

// ========================================
// 템플릿 컴포넌트 (DOM 빌더)
// ========================================
/**
 * renderTemplateItemDOM(template) - 템플릿 아이템 하나의 DOM 요소를 생성합니다.
 * textContent를 사용하여 XSS를 원천 차단합니다.
 */
function renderTemplateItemDOM(template) {
  const itemDiv = createElement("div", {
    className: "imsmassi-template-item" + (template.pinned ? " imsmassi-template-item-pinned" : ""),
  });
  itemDiv.addEventListener("click", () => useTemplate(template.id));

  const pinBtn = createElement("button", {
    className: "imsmassi-template-pin-btn",
    title: template.pinned ? t("memoTab.unpinTitle") : t("memoTab.pinTitle"),
  });
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTemplatePin(template.id);
  });

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-delete-btn",
  });
  // 기본 색상은 CSS .imsmassi-memo-delete-btn { color: var(--imsmassi-sub-text) }
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal("templateDeleteConfirm", { templateId: template.id });
  });

  const editBtn = createElement("button", {
    className: "imsmassi-template-edit-btn",
    title: "수정",
  });
  // 기본 색상은 CSS .imsmassi-template-edit-btn { color: var(--imsmassi-sub-text) }
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditTemplateModal(template.id);
  });

  const headerDiv = createElement("div", {
    className: "imsmassi-template-item-header",
  });
  const titleSpan = createElement("span", {
    className: "imsmassi-template-item-title",
  });
  // 기본 색상은 CSS .imsmassi-template-item-title { color: var(--imsmassi-text) }
  titleSpan.textContent = template.title;
  const countSpan = createElement("span", {
    className: "imsmassi-template-item-count",
  });
  // 기본 색상은 CSS .imsmassi-template-item-count { color: var(--imsmassi-sub-text) }
  countSpan.textContent = t("templateTab.useCount", {count: template.count});
  headerDiv.append(titleSpan, countSpan);

  const contentDiv = createElement("div", {
    className: "imsmassi-template-item-content",
  });
  // 기본 색상은 CSS .imsmassi-template-item-content { color/border: var(--imsmassi-sub-text/border) }
  contentDiv.textContent = template.content; // textContent로 XSS 방지

  itemDiv.append(pinBtn, deleteBtn, editBtn, headerDiv, contentDiv);
  return itemDiv;
}

/**
 * renderTemplateTabDOM() - 템플릿 탭 전체 DOM을 빌드하여 반환합니다.
 */
function renderTemplateTabDOM() {
  const container = createElement("div");

  const listHeader = createElement("div", {
    className: "imsmassi-template-list-header",
  });
  // 기본 색상은 CSS .imsmassi-template-list-header { color: var(--imsmassi-sub-text) }
  listHeader.textContent = t("templateTab.listHeader", {count: state.templates.length});
  container.appendChild(listHeader);

  [...state.templates]
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.count || 0) - (a.count || 0);
    })
    .forEach((template) =>
      container.appendChild(renderTemplateItemDOM(template)),
    );
  return container;
}

// 하위 호환용 래퍼
function renderTemplateTab() {
  return renderTemplateTabDOM();
}

function renderTimeTab() {
  const periodMap = {
    today: t("timeInsight.periodToday"),
    week: t("timeInsight.periodWeek"),
    month: t("timeInsight.periodMonth"),
  };
  const data = getTimeStats(state.timePeriod); // 실시간 데이터 가져오기

  let chartHtml = "";
  data.items.forEach((item) => {
    chartHtml += `
      <div class="imsmassi-time-chart-item">
        <div class="imsmassi-time-chart-item-left">
          <span class="imsmassi-time-chart-accent" style="background: ${item.color};"></span>
          <span class="imsmassi-time-chart-name">${item.name}</span>
        </div>
        <div class="imsmassi-time-chart-right">
          <span class="imsmassi-time-chart-duration">${item.time}</span>
          <span class="imsmassi-time-chart-percent">${item.percent}%</span>
        </div>
      </div>
    `;
  });

  let segmentBarHtml = "";
  data.items.forEach((item) => {
    segmentBarHtml += `
      <div title="${item.name}" class="imsmassi-time-segment-item" style="flex: ${item.percent}; background: ${item.color};"></div>
    `;
  });

  let periodBtnsHtml = "";
  Object.entries(periodMap).forEach(([key, label]) => {
    const isActive = state.timePeriod === key;
    periodBtnsHtml += `
      <button class="imsmassi-time-period-btn ${isActive ? "imsmassi-active" : ""}"
              onclick="setTimePeriod('${key}')">
        ${label}
      </button>
    `;
  });

  // 기간별 설명 추가
  const periodDescMap = {
    today: t("timeInsight.periodTodayDesc"),
    week: t("timeInsight.periodWeekDesc"),
    month: t("timeInsight.periodMonthDesc"),
  };

  return `
    <div>
      <div class="imsmassi-time-summary">
        <div class="imsmassi-time-summary-label">${t("timeInsight.workTimeLabel", {period: periodMap[state.timePeriod]})}</div>
        <div class="imsmassi-time-summary-value">${data.total}</div>
        <div class="imsmassi-time-summary-period-desc">${periodDescMap[state.timePeriod]}</div>
        <div class="imsmassi-time-segment-bar">${segmentBarHtml}</div>
        <div class="imsmassi-time-period-btns">${periodBtnsHtml}</div>
        <div class="imsmassi-time-summary-label" style="margin-top: 14px;">${t("timeInsight.menuDwellLabel")}</div>
        ${chartHtml}
      </div>
    </div>
  `;
}

/**
 * 대시보드 업무 컬러 설정 섹션 HTML 반환
 * 각 businessArea 행에 메인(primary) + 서브1 + 서브2 input[type=color] 제공
 */
function renderAreaColorSection() {
  const c = getColors();
  const areas = getBusinessAreas();

  const rows = areas
    .map((area) => {
      const def = getDefaultAreaColors(area.id);
      const custom = state.areaColors?.[area.id] || {};
      const hasCustom = !!state.areaColors?.[area.id];
      const primary = custom.primary ?? def.primary;
      const sub1 = custom.sub1 ?? def.sub1;
      const sub2 = custom.sub2 ?? def.sub2;

      return `
      <div class="imsmassi-area-color-row">
        <div class="imsmassi-area-color-row-name-wrap">
          <span class="imsmassi-area-color-row-dot" style="background:${primary};"></span>
          <span class="imsmassi-area-color-row-name" title="${getAreaName(area.id, area.id)}">${getAreaName(area.id, area.id)}</span>
        </div>
        <label class="imsmassi-area-color-label-wrap">
          <span class="imsmassi-area-color-label-text">${t("dashboard.colorMain")}</span>
          <input type="color" value="${primary}" onchange="onAreaColorChange('${area.id}','primary',this.value)" class="imsmassi-area-color-input">
        </label>
        <label class="imsmassi-area-color-label-wrap">
          <span class="imsmassi-area-color-label-text">${t("dashboard.colorSub1")}</span>
          <input type="color" value="${sub1}" onchange="onAreaColorChange('${area.id}','sub1',this.value)" class="imsmassi-area-color-input">
        </label>
        <label class="imsmassi-area-color-label-wrap">
          <span class="imsmassi-area-color-label-text">${t("dashboard.colorSub2")}</span>
          <input type="color" value="${sub2}" onchange="onAreaColorChange('${area.id}','sub2',this.value)" class="imsmassi-area-color-input">
        </label>
        <div class="imsmassi-area-color-spacer"></div>
        ${hasCustom ? `<button onclick="resetAreaColors('${area.id}')" title="${t('dashboard.colorResetTitle')}" class="imsmassi-area-color-reset-btn">↩</button>` : ""}
      </div>
    `;
    })
    .join("");

  return `
    <div class="imsmassi-area-color-legend">
      ${t("dashboard.colorLegend")}
    </div>
    ${rows}
  `;
}

function renderDashboardTab() {
  // showTimeTab 설정이 false이면 시간 인사이트 섹션 렌더링 생략
  const timeHtml = state.settings?.showTimeTab !== false ? renderTimeTab() : "";

  // 백업 알림 배너 계산
  let backupBannerHtml = "";
  if (state.settings.backupReminder) {
    const lastBackup = new Date(state.settings.lastBackup);
    const today = new Date();
    const daysSinceBackup = Math.floor(
      (today - lastBackup) / (1000 * 60 * 60 * 24),
    );
    if (daysSinceBackup >= 30) {
      backupBannerHtml = `
        <div class="imsmassi-dashboard-banner imsmassi-dashboard-banner-backup">
          <span class="imsmassi-dashboard-banner-icon imsmassi-icon-save"></span>
          <div class="imsmassi-dashboard-banner-body">
            <div class="imsmassi-dashboard-banner-title imsmassi-dashboard-banner-title-backup">${t("dashboard.backupBannerTitle")}</div>
            <div class="imsmassi-dashboard-banner-desc imsmassi-dashboard-banner-desc-backup">${t("dashboard.backupBannerDesc", {lastBackup: t("timeInsight.nDaysAgo", {n: daysSinceBackup})})}</div>
          </div>
          <button class="imsmassi-dashboard-banner-btn imsmassi-dashboard-banner-btn-backup" onclick="exportAllData()">${t("ui.btnBackup")}</button>
        </div>
      `;
    }
  }

  // 용량 경고 배너
  let storageWarningHtml = "";
  const usagePercent = (state.storageUsed / state.storageLimit) * 100;
  if (usagePercent >= 80) {
    storageWarningHtml = `
      <div class="imsmassi-dashboard-banner imsmassi-dashboard-banner-storage">
        <span class="imsmassi-dashboard-banner-icon imsmassi-icon-warning"></span>
        <div class="imsmassi-dashboard-banner-body">
          <div class="imsmassi-dashboard-banner-title imsmassi-dashboard-banner-title-storage">${t("settings.storageLowTitle")}</div>
          <div class="imsmassi-dashboard-banner-desc imsmassi-dashboard-banner-desc-storage">${state.storageUsed.toFixed(1)}MB / ${state.storageLimit}MB (${usagePercent.toFixed(0)}%)</div>
        </div>
        <button class="imsmassi-dashboard-banner-btn imsmassi-dashboard-banner-btn-storage" onclick="openSettingsModal()">${t("ui.btnManage")}</button>
      </div>
    `;
  }

  // 할 일 (알림 설정된 메모에서 생성)
  const todayReminders = getTodayReminders() || [];
  const pastReminders = getPastReminders() || [];
  let todayTodosHtml = "";
  if (todayReminders && todayReminders.length > 0) {
    todayReminders.forEach((todo) => {
      if (!todo || !todo.id) return; // null 체크
      todayTodosHtml += `
        <div class="imsmassi-todo-item">
          <span class="imsmassi-todo-checkbox ${todo.done ? "imsmassi-checked imsmassi-checked-done" : ""}"
                onclick="toggleTodo('${todo.id}')">
            ${todo.done ? "✓" : ""}
          </span>
          <span class="imsmassi-todo-text ${todo.done ? "imsmassi-done imsmassi-todo-text-done" : "imsmassi-todo-text-pending"}">${todo.title ? `<strong>${todo.title}</strong>` : ""}</span>
          <span class="imsmassi-todo-area-name">${todo.menuId}</span>
          <span class="imsmassi-todo-time ${todo.done ? "imsmassi-todo-time-done" : "imsmassi-todo-time-active"}">${todo.reminder}</span>
        </div>
      `;
    });
  }

  let pastTodosHtml = "";
  if (pastReminders && pastReminders.length > 0) {
    pastReminders.forEach((todo) => {
      if (!todo || !todo.id) return; // null 체크
      pastTodosHtml += `
        <div class="imsmassi-todo-item">
          <span class="imsmassi-todo-checkbox ${todo.done ? "imsmassi-checked imsmassi-checked-done" : ""}"
                onclick="toggleTodo('${todo.id}')">
            ${todo.done ? "✓" : ""}
          </span>
          <span class="imsmassi-todo-text ${todo.done ? "imsmassi-done imsmassi-todo-text-done" : "imsmassi-todo-text-pending"}">${todo.title ? `<strong>${todo.title}</strong>` : ""}</span>
          <span class="imsmassi-todo-area-name">${todo.menuId}</span>
          <span class="imsmassi-todo-date">${todo.reminderDate}</span>
        </div>
      `;
    });
  }

  const emptyTodayHtml =
    todayReminders.length === 0
      ? `<div class="imsmassi-dashboard-empty">${t("dashboard.todayEmpty")}</div>`
      : "";
  const emptyPastHtml =
    pastReminders.length === 0
      ? `<div class="imsmassi-dashboard-empty">${t("dashboard.pastEmpty")}</div>`
      : "";

  // 최근 메모
  let recentMemosHtml = "";
  const allMemos = [];
  // state.memos는 객체 구조: {memoId: memoData}
  Object.values(state.memos || {}).forEach((memo) => {
    allMemos.push(memo);
  });

  assiConsole.log("모든 메모:", allMemos);
  allMemos
    .sort((a, b) => {
      const aCreated = Number(a.createdAt || 0);
      const bCreated = Number(b.createdAt || 0);
      if (bCreated !== aCreated) return bCreated - aCreated;
      return new Date(b.date || 0) - new Date(a.date || 0);
    })
    .slice(0, 2)
    .forEach((memo) => {
      const menuId = memo.menuId;
      const memoPreview = getMemoPlainText(memo);
      recentMemosHtml += `
      <div class="imsmassi-recent-memo-item" onclick="setSelectedArea('${memo.createdAreaId}'); goToMemoTab();">
        <div class="imsmassi-recent-memo-menu">${menuId}</div>
        <div class="imsmassi-recent-memo-text">${memoPreview}</div>
      </div>
    `;
    });

  // ${backupBannerHtml}

  // 알림 내역 — 미확인(unread) 항목만 표시, 확인 처리 시 목록에서 제거됨
  const allUnreadNotifs = (state.notifications || []).filter(n => !n.isRead);
  const unreadCount = allUnreadNotifs.length; // 전체 미확인 알림 수 (뱃지/타이틀 카운트 기준)
  const allNotifs = allUnreadNotifs
    .slice()
    .sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0))
    .slice(0, 7);
  let notifItemsHtml = '';
  allNotifs.forEach(notif => {
    const ago = formatNotifTime(notif.firedAt);
    const safeTitle = escapeHtml(notif.title || t('modal.reminderTitle') || '알림');
    const readBtn = `<button class="imsmassi-dashboard-unread-read-btn" onclick="toggleNotificationRead(${notif.id})">${t('dashboard.notifMarkRead')}</button>`;
    notifItemsHtml += `
      <div class="imsmassi-dashboard-unread-item imsmassi-notif-unread">
        <span class="imsmassi-dashboard-unread-title">${safeTitle}</span>
        <span class="imsmassi-dashboard-unread-time">${ago}</span>
        ${readBtn}
      </div>
    `;
  });
  const notifEmptyHtml = allNotifs.length === 0
    ? `<div class="imsmassi-dashboard-empty">${t('dashboard.unreadNotificationsEmpty')}</div>`
    : '';
  const notifBadge = unreadCount > 0
    ? `<span class="imsmassi-notif-count-badge">${unreadCount}</span>`
    : '';
  const unreadNotifsSection = `
    <div class="imsmassi-dashboard-section imsmassi-dashboard-section-unread">
      <div class="imsmassi-dashboard-section-header">
        <span>${t('dashboard.sectionUnreadNotifications')}${notifBadge}</span>
        ${unreadCount > 0 ? `<button class="imsmassi-notif-markall-btn" onclick="markAllNotificationsRead()">${t('dashboard.notifMarkAllRead')}</button>` : ''}
      </div>
      ${notifItemsHtml}
      ${notifEmptyHtml}
    </div>
  `;

  return `
    <div>
      ${backupBannerHtml}
      ${storageWarningHtml}
      ${unreadNotifsSection}
      <div id="imsmassi-dashboard-today" class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span>${t("dashboard.sectionToday")}</span> 
        </div>
        ${todayTodosHtml}
        ${emptyTodayHtml}
      </div>
      ${
        pastReminders && pastReminders.length > 0
          ? `
      <div class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span>${t("dashboard.sectionPast")}</span> 
        </div>
        ${pastTodosHtml}
      </div>
      `
          : ""
      }
      <div class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span>${t("dashboard.sectionRecentMemo")}</span> 
        </div>
        ${recentMemosHtml || `<div class="imsmassi-dashboard-empty">${t("dashboard.recentMemoEmpty")}</div>`}
      </div>
    </div>

    ${
      state.settings?.showAreaColorSection !== false
        ? `
    <div class="imsmassi-dashboard-section">
      <div class="imsmassi-dashboard-section-header">
        <span>${t("dashboard.sectionAreaColor")}</span>
      </div>
      ${renderAreaColorSection()}
    </div>
    `
        : ""
    }

    ${
      state.settings?.showTimeTab !== false
        ? `
    <div class="imsmassi-dashboard-section dashboard-time-section">
      <div class="imsmassi-dashboard-section-header">
        <span>${t("dashboard.sectionTimeInsight")}</span>
      </div>
      ${timeHtml}
    </div>`
        : ""
    }
  `;
}

// ========================================
// 키보드 이벤트 (Enter로 모달 확인, Escape로 모달/어시스턴트 닫기)
// ========================================
document.addEventListener("keydown", function (e) {
  // Enter: 모달 확인
  // ※ textarea에 포커스가 있을 때는 Enter = 줄바꿈 (모달 확인 트리거 제외)
  if (e.key === "Enter" && state.currentModal) {
    const focusedTag = document.activeElement?.tagName;
    const isTextarea = focusedTag === "TEXTAREA";
    if (!isTextarea) {
      e.preventDefault();
      switch (state.currentModal) {
        case "setReminder":
          confirmSetReminder();
          break;
        case "deleteConfirm":
          confirmDeleteMemo();
          break;
        case "addTemplate":
          confirmAddTemplate();
          break;
        case "editTemplate":
          confirmEditTemplate();
          break;
        case "addFavorite":
          confirmAddFavorite();
          break;
      }
    }
  }
  // Escape: 모달 닫기
  if (e.key === "Escape") {
    if (state.currentModal) {
      closeModal();
    }
  }
  // Ctrl + `: 어시스턴트 패널 토글 (열기/닫기)
  if (e.key === "`" && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (state.currentModal) return; // 모달 열려있으면 무시
    if (state.assistantOpen) {
      closeAssistant();
    } else {
      state.assistantOpen = true;
      renderAssistant();
    }
  }
});

// ========================================
// [수정] 복사 이벤트 핸들러
// ========================================
document.addEventListener("copy", async (e) => {
  if (!state.settings.enableClipboardCapture) return;
  // areaId별 클립보드에 저장

  let finalContent = "";
  const activeEl = document.activeElement;

  // 1. Input/Textarea 텍스트 추출
  if (
    activeEl &&
    (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")
  ) {
    const start = activeEl.selectionStart;
    const end = activeEl.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && start !== end) {
      finalContent = activeEl.value.substring(start, end);
    }
  }

  // 2. 일반 텍스트 추출
  if (!finalContent) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      finalContent = selection.toString();
    }
  }

  // 3. 저장 함수 호출 (여기서 중복/카운트 로직 모두 처리)
  const cleanText = finalContent ? finalContent.trim() : "";
  if (cleanText.length > 0) {
    addClipboardItem(cleanText, {
      skipTemplateSuggest: state.lastCopySource === "template",
    });
    state.lastCopySource = null;
  }
});

// ============================================================================
// [Section 8] FEATURE: REMINDERS · NOTIFICATIONS · TIME TRACKING  🔔
// ============================================================================
// [8-A] Time Tracking: getDailyBucket, recordToBucket, getTimeStats, ...
// [8-B] Clipboard Capture: captureClipboard, addClipboardItem, ingestExternalContent
// [8-C] Reminders: getTodosFromReminders, checkReminders, initReminderSystem
// [8-D] Notifications: showBalloonNotification, showToast, sendBrowserNotification
// ============================================================================

// ── [8-A] 시간 추적 (Time Tracking) ─────────────────────────────────────────
// 날짜를 YYYY-MM-DD 형식으로 변환
function getDailyBucket(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ISO 주차 계산 (YYYY-Www 형식)
function getWeeklyBucket(date = new Date()) {
  const year = date.getFullYear();
  // 1월 4일이 속한 주가 첫 주
  const jan4 = new Date(year, 0, 4);
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - jan4.getDay());
  const diff = date.getTime() - weekStart.getTime();
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// 월을 YYYY-MM 형식으로 변환
function getMonthlyBucket(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseDailyBucketKey(key) {
  if (!key) return null;
  const parsed = new Date(`${key}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseWeeklyBucketKey(key) {
  const match = /^([0-9]{4})-W([0-9]{2})$/.exec(key);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  if (!year || !week) return null;
  const jan4 = new Date(year, 0, 4);
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - jan4.getDay());
  const target = new Date(weekStart);
  target.setDate(weekStart.getDate() + (week - 1) * 7);
  return target;
}

function parseMonthlyBucketKey(key) {
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(key);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (!year || !month) return null;
  return new Date(year, month - 1, 1);
}

function pruneTimeBuckets(daysBefore = 30) {
  if (!daysBefore || daysBefore <= 0) {
    return { daily: 0, weekly: 0, monthly: 0, total: 0 };
  }

  if (!state.timeBuckets) {
    state.timeBuckets = { daily: {}, weekly: {}, monthly: {} };
  }

  const cutoffTime = Date.now() - daysBefore * 24 * 60 * 60 * 1000;
  let dailyRemoved = 0;
  let weeklyRemoved = 0;
  let monthlyRemoved = 0;

  const dailyBuckets = state.timeBuckets.daily || {};
  Object.keys(dailyBuckets).forEach((key) => {
    const date = parseDailyBucketKey(key);
    if (date && date.getTime() < cutoffTime) {
      delete dailyBuckets[key];
      dailyRemoved += 1;
    }
  });

  const weeklyBuckets = state.timeBuckets.weekly || {};
  Object.keys(weeklyBuckets).forEach((key) => {
    const date = parseWeeklyBucketKey(key);
    if (date && date.getTime() < cutoffTime) {
      delete weeklyBuckets[key];
      weeklyRemoved += 1;
    }
  });

  const monthlyBuckets = state.timeBuckets.monthly || {};
  Object.keys(monthlyBuckets).forEach((key) => {
    const date = parseMonthlyBucketKey(key);
    if (date && date.getTime() < cutoffTime) {
      delete monthlyBuckets[key];
      monthlyRemoved += 1;
    }
  });

  state.timeBuckets.daily = dailyBuckets;
  state.timeBuckets.weekly = weeklyBuckets;
  state.timeBuckets.monthly = monthlyBuckets;

  return {
    daily: dailyRemoved,
    weekly: weeklyRemoved,
    monthly: monthlyRemoved,
    total: dailyRemoved + weeklyRemoved + monthlyRemoved,
  };
}

// 기간별 버킷에 시간 기록
function recordToBucket(areaId, elapsedMs) {
  if (!areaId) return;

  // timeBuckets 존재 여부 확인 및 초기화
  if (!state.timeBuckets) {
    state.timeBuckets = { daily: {}, weekly: {}, monthly: {} };
  }

  const now = new Date();
  const dailyKey = getDailyBucket(now);
  const weeklyKey = getWeeklyBucket(now);
  const monthlyKey = getMonthlyBucket(now);

  // 일별 버킷
  if (!state.timeBuckets.daily) state.timeBuckets.daily = {};
  if (!state.timeBuckets.daily[dailyKey]) {
    state.timeBuckets.daily[dailyKey] = {};
  }
  state.timeBuckets.daily[dailyKey][areaId] =
    (state.timeBuckets.daily[dailyKey][areaId] || 0) + elapsedMs;

  // 주별 버킷
  if (!state.timeBuckets.weekly) state.timeBuckets.weekly = {};
  if (!state.timeBuckets.weekly[weeklyKey]) {
    state.timeBuckets.weekly[weeklyKey] = {};
  }
  state.timeBuckets.weekly[weeklyKey][areaId] =
    (state.timeBuckets.weekly[weeklyKey][areaId] || 0) + elapsedMs;

  // 월별 버킷
  if (!state.timeBuckets.monthly) state.timeBuckets.monthly = {};
  if (!state.timeBuckets.monthly[monthlyKey]) {
    state.timeBuckets.monthly[monthlyKey] = {};
  }
  state.timeBuckets.monthly[monthlyKey][areaId] =
    (state.timeBuckets.monthly[monthlyKey][areaId] || 0) + elapsedMs;

  assiConsole.log(
    `[recordToBucket] 일: ${dailyKey}, 주: ${weeklyKey}, 월: ${monthlyKey}`,
  );
  assiConsole.log(`[recordToBucket] 버킷 업데이트:`, state.timeBuckets);
}

// ========================================
// 시간 추적 함수들
// ========================================
// [Worker 위임] 메뉴 시간 통계 저장/로드 (STATE_UPDATE로 자동 복원됨)
// IndexedDB에 메뉴 시간 통계 저장
// [Worker 위임] saveMenuTimeStats (BEFORE_UNLOAD 메시지로 Worker가 처리)
function saveMenuTimeStats() {
  workerSend("BEFORE_UNLOAD", {});
}

// Area ID 기반 시간 기록 (Worker 경유)
function recordAreaTime(areaId) {
  if (!areaId) return;
  const now = Date.now();
  const elapsedMs = now - state.lastMenuChangeTime;
  state.lastMenuChangeTime = now;
  workerSend("RECORD_AREA_TIME", { areaId, elapsedMs });
}

function getTimeStats(period = "today") {
  // 기간별 버킷 데이터 사용 (timeBuckets에서 조회)
  const now = Date.now();
  const today = new Date();

  // 해당 period의 버킷 키 계산
  let bucketKey = "";
  let bucketData = {};

  if (period === "today") {
    bucketKey = getDailyBucket(today);
    bucketData = state.timeBuckets?.daily?.[bucketKey] || {};
  } else if (period === "week") {
    bucketKey = getWeeklyBucket(today);
    bucketData = state.timeBuckets?.weekly?.[bucketKey] || {};
  } else if (period === "month") {
    bucketKey = getMonthlyBucket(today);
    bucketData = state.timeBuckets?.monthly?.[bucketKey] || {};
  }

  assiConsole.log(
    `[getTimeStats] 기간: ${period}, 버킷: ${bucketKey}, 데이터:`,
    bucketData,
  );

  // 실제 저장된 시간 데이터로 items 생성 (area.id 기반)
  const items = getBusinessAreas().map((area) => {
    const key = area.id;
    let totalMs = bucketData[key] || 0;

    // 현재 선택된 영역은 실시간으로 경과 시간 포함
    if (state.selectedArea === key && state.lastMenuChangeTime) {
      totalMs += Math.max(0, now - state.lastMenuChangeTime);
    }

    const hours = Math.floor(totalMs / (1000 * 60 * 60));
    const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
    const timeStr = hours > 0
      ? t("timeInsight.formatHM", {h: hours, m: minutes})
      : t("timeInsight.formatM", {m: minutes});

    return {
      name: area.name,
      time: timeStr,
      ms: totalMs,
      color: area.color,
    };
  });

  // 총 시간 계산
  const totalMs = items.reduce((sum, item) => sum + item.ms, 0);
  const totalHours = Math.floor(totalMs / (1000 * 60 * 60));
  const totalMinutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
  const totalStr = totalHours > 0
    ? t("timeInsight.totalFormatHM", {h: totalHours, m: totalMinutes})
    : t("timeInsight.totalFormatM", {m: totalMinutes});

  // 퍼센트 계산
  const itemsWithPercent = items
    .map((item) => ({
      ...item,
      percent: totalMs > 0 ? Math.round((item.ms / totalMs) * 100) : 0,
    }))
    .sort((a, b) => b.ms - a.ms);

  return {
    total: totalStr,
    items: itemsWithPercent,
  };
}

// ========================================
// 클립보드 캡처 함수
// ========================================
function getRelativeTime(ms) {
  const now = Date.now();
  const diff = now - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return t("timeInsight.nDaysAgo", {n: days});
  if (hours > 0) return t("timeInsight.nHoursAgo", {hours, minutes: minutes % 60});
  if (minutes > 0) return t("timeInsight.nMinutesAgo", {n: minutes});
  return t("timeInsight.justNow");
}

async function captureClipboard() {
  if (!state.settings.enableClipboardCapture) return;

  try {
    // navigator.clipboard.readText()는 보안상 사용자 명시적 액션 필요
    // 여기서는 수동 입력 또는 드래그 드롭으로 처리하도록 함
    // Ctrl+C 감지는 아래에서 처리
  } catch (error) {
    console.error("클립보드 읽기 실패:", error);
  }
}

// ── [Section 7 / 8-B] 클립보드 캡처 & 아이템 관리 ──────────────────────────
function refreshClipboardStateFromDB() {
  workerSend("REFRESH_CLIPBOARD", {});
}

function addClipboardItem(content, options = {}) {
  if (!content || typeof content !== "string") return;
  const trimmed = content.trim();
  if (!trimmed.length) return;
  workerSend("ADD_CLIPBOARD", { content: trimmed, options });
}

// ========================================
// 부모창/iframe 브리지 입력 처리
// ========================================
function normalizeExternalPayload(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload.trim();

  if (Array.isArray(payload)) {
    return payload
      .map((row) =>
        Array.isArray(row)
          ? row.map((cell) => `${cell ?? ""}`).join("\t")
          : `${row ?? ""}`,
      )
      .join("\n");
  }

  if (typeof payload === "object") {
    if (payload.tsv) return String(payload.tsv).trim();
    if (payload.text) return String(payload.text).trim();
    if (payload.rows && Array.isArray(payload.rows)) {
      return payload.rows
        .map((row) =>
          Array.isArray(row)
            ? row.map((cell) => `${cell ?? ""}`).join("\t")
            : `${row ?? ""}`,
        )
        .join("\n");
    }
  }
  return null;
}

async function ingestExternalContent(payload) {
  const normalized = normalizeExternalPayload(payload);
  if (!normalized) return false;

  await addClipboardItem(normalized);
  if (!state.assistantOpen) state.assistantOpen = true;
  renderAssistant();
  showToast(t("system.externalDataReceived"));
  return true;
}

// window.assistantBridge 및 postMessage 브리지는 [Section 1]에서 등록됩니다.
// → 파일 최상단(L~18)을 참조하세요.

// ── [8-C] 리마인더 (Reminders) ──────────────────────────────────────────────
function getTodosFromReminders() {
  const todos = [];

  const today = toLocalDateStr(); // YYYY-MM-DD

  // 모든 메모 탐색 (state.memos는 객체 구조: {memoId: memoData})
  Object.values(state.memos).forEach((memo) => {
    if (memo.reminder) {
      // reminder는 "YYYY-MM-DD HH:MM" 형식이므로 날짜 부분 추출
      const reminderDate = memo.reminder.split(" ")[0]; // YYYY-MM-DD
      todos.push({
        id: memo.id,
        text: getMemoPlainText(memo),
        title: memo.title || "", // 메모 제목
        reminder: memo.reminder,
        reminderDate: reminderDate,
        //reminderTime: memo.reminder.split(' ')[1] || '00:00', // HH:MM
        done: memo.done || false,
        areaId: memo.createdAreaId,
        menuId: memo.menuId || memo.labels?.[0] || memo.createdAreaId || '',
        isToday: reminderDate === today,
        isPast: reminderDate < today,
      });
    }
  });

  // 시간순으로 정렬
  todos.sort((a, b) => {
    // 지난 일 vs 오늘 vs 미래 정렬
    if (a.isPast !== b.isPast) return a.isPast ? 1 : -1;
    if (a.isToday !== b.isToday) return b.isToday ? 1 : -1;
    // 같은 날짜면 시간순 정렬
    const timeA = a.reminder.split(":").map(Number);
    const timeB = b.reminder.split(":").map(Number);
    return timeA[0] * 60 + timeA[1] - (timeB[0] * 60 + timeB[1]);
  });

  return todos;
}

//당일 리마인더 (Issue 1 fix: done 항목도 리스트에 유지 — 체크 후 사라지지 않고 취소선으로 표시)
function getTodayReminders() {
  const filtered = getTodosFromReminders().filter(
    (todo) => todo.isToday === true,
  );
  return filtered;
}
//지난 리마인더
function getPastReminders() {
  const filtered = getTodosFromReminders().filter((todo) => todo.isPast);
  return filtered;
}

// ========================================
// 할 일 관리
// ========================================
function toggleTodo(memoId) {
  workerSend("TOGGLE_TODO", { memoId });
}

// ── [8-D] 알림 시스템 (Notifications) ───────────────────────────────────────
// 마지막으로 알림을 확인한 분 (중복 방지)
let lastCheckedMinute = null;

// 알림 권한 요청 (browserNotificationEnabled 설정과 무관하게 항상 요청)
function requestNotificationPermission() {
  if (!("Notification" in window)) {
    assiConsole.log("⚠️ 이 브라우저는 Web Notification을 지원하지 않습니다.");
    return;
  }

  if (Notification.permission === "granted") {
    assiConsole.log("✓ 알림 권한이 이미 승인되었습니다.");
    return;
  }

  if (Notification.permission === "denied") {
    assiConsole.log(
      "⚠️ 사용자가 알림을 거부했습니다. 브라우저 설정에서 권한을 변경하세요.",
    );
    return;
  }

  // 'default' 상태일 때만 요청
  assiConsole.log("🔔 알림 권한을 요청 중입니다...");
  Notification.requestPermission()
    .then((permission) => {
      if (permission === "granted") {
        assiConsole.log("✓ 알림 권한이 승인되었습니다.");
      } else if (permission === "denied") {
        assiConsole.log("⚠️ 사용자가 알림을 거부했습니다.");
      }
    })
    .catch((error) => {
      console.error("알림 권한 요청 실패:", error);
    });
}

// 브라우저 알림 표시
function sendBrowserNotification(title, options = {}) {
  // browserNotificationEnabled 설정은 권한 요청에만 사용.
  // 이미 권한이 granted 된 경우 설정값과 무관하게 항상 발송 (창이 닫혀도 알림 수신).
  if (!("Notification" in window)) {
    assiConsole.warn("이 브라우저는 Web Notification을 지원하지 않습니다.");
    return;
  }

  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔔</text></svg>',
        badge:
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%23FF6B6B"/></svg>',
        tag: "reminder-notification",
        requireInteraction: false,
        ...options,
      });
      assiConsole.log(`✓ 브라우저 알림 발송: ${title}`);
    } catch (error) {
      console.error("브라우저 알림 전송 실패:", error);
    }
  } else if (Notification.permission !== "denied" && state.settings.browserNotificationEnabled) {
    // 권한 미설정 + 설정 활성화 시에만 권한 요청 후 발송
    Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        sendBrowserNotification(title, options);
      }
    }).catch(() => {});
  }
}

// UI 알림 표시 (어시스턴트 상태에 따라 다르게 표시)
function showNotificationToast(title, content, areaId = "", duration = 6000) {
  if (state.assistantOpen) {
    // 어시스턴트 열려있으면
    if (state.autoNavigateToDashboard) {
      // 대시보드 탭으로 이동 (설정 활성화 시)
      setActiveTab("dashboard");
    }
    // 우측 상단 토스트로 표시
    showRightTopToast(title, content, areaId, duration);
  } else {
    // 어시스턴트 닫혀있으면: 말풍선 스타일로 플로팅 버튼 위에 표시
    showBalloonNotification(title, content, duration);
  }
}

// 우측 상단 토스트 (어시스턴트 열려있을 때)
function showRightTopToast(title, content, areaId = "", duration = 6000) {
  const styleRoot = getAssistantStyleRoot();
  const floatingPanel = document.getElementById("imsmassi-floating-panel");
  // 패널이 열려있으면 패널 내부에 마운트(중앙 정렬), 닫혀있으면 기존 우측 상단
  const isInPanel = !!(floatingPanel && state.assistantOpen);
  const mountTarget = isInPanel ? floatingPanel : styleRoot;

  let container = mountTarget.querySelector("#notification-toast-container");
  if (!container) {
    const existing = document.getElementById("notification-toast-container");
    if (existing) existing.remove();
    const newContainer = document.createElement("div");
    newContainer.id = "notification-toast-container";
    mountTarget.appendChild(newContainer);
    container = newContainer;
  }
  // 마운트 위치가 달라진 경우 이동
  if (container.parentElement !== mountTarget) {
    mountTarget.appendChild(container);
  }

  const toastEl = document.createElement("div");
  toastEl.className = `imsmassi-notification-toast imsmassi-reminder${isInPanel ? " imsmassi-in-panel" : ""}`;

  const areaName = getAreaName(areaId, "");

  toastEl.innerHTML = `
    <div class="imsmassi-notification-toast-title">${title}</div>
    ${content ? `<div class="imsmassi-notification-toast-content">${content}</div>` : ""}
    ${areaName ? `<div class="imsmassi-notification-toast-area">${areaName}</div>` : ""}
  `;

  container.appendChild(toastEl);

  // 애니메이션 트리거
  setTimeout(() => toastEl.classList.add("imsmassi-show"), 10);

  // 자동 제거 (뱃지/타이틀은 RECORD_NOTIFICATION→Worker→syncNotifTabTitle 경로로만 처리)
  setTimeout(() => {
    toastEl.classList.remove("imsmassi-show");
    setTimeout(() => toastEl.remove(), 300);
  }, duration);
}

// 말풍선 알림 (어시스턴트 닫혀있을 때)
function showBalloonNotification(title, content = "", duration = 6000) {
  const styleRoot = getAssistantStyleRoot();
  let balloonContainer = styleRoot.querySelector(
    "#balloon-notification-container",
  );

  if (!balloonContainer) {
    const existing = document.getElementById("balloon-notification-container");
    if (existing) existing.remove();
    balloonContainer = document.createElement("div");
    balloonContainer.id = "balloon-notification-container";
    // Task 4: position/z-index/pointer-events는 CSS #balloon-notification-container에서 지정
    styleRoot.appendChild(balloonContainer);
  }

  const balloonEl = document.createElement("div");
  balloonEl.className = "imsmassi-notification-balloon";
  balloonEl.innerHTML = `<div>🔔</div><div class="imsmassi-notification-balloon-body">${title}</div>`;

  balloonContainer.appendChild(balloonEl);

  // 애니메이션 트리거
  setTimeout(() => balloonEl.classList.add("imsmassi-show"), 10);

  // 자동 제거 (뱃지/타이틀은 RECORD_NOTIFICATION→Worker→syncNotifTabTitle 경로로만 처리)
  setTimeout(() => {
    balloonEl.classList.remove("imsmassi-show");
    setTimeout(() => balloonEl.remove(), 400);
  }, duration);
}

// 탭 타이틀 미확인 리마인더 카운터
let _unreadReminderCount = 0;
const _originalDocTitle = document.title;

function incrementTabTitleCount() {
  _unreadReminderCount++;
  const base = _originalDocTitle.replace(/^\(\d+\)\s*/, "");
  document.title = `(${_unreadReminderCount}) ${base}`;
}

function clearTabTitleCount() {
  _unreadReminderCount = 0;
  document.title = _originalDocTitle.replace(/^\(\d+\)\s*/, "");
}

/**
 * syncNotifTabTitle()
 * state.notifications 기준 미확인 수를 탭 타이틀 카운터와 동기화합니다.
 * toggleNotificationRead / markAllNotificationsRead / STATE_UPDATE 이후 호출됩니다.
 */
function syncNotifTabTitle() {
  const unread = (state.notifications || []).filter(n => !n.isRead).length;
  _unreadReminderCount = unread;
  const base = _originalDocTitle.replace(/^\(\d+\)\s*/, "");
  if (unread > 0) {
    document.title = `(${unread}) ${base}`;
  } else {
    document.title = base;
  }
  // 플로팅 버튼 뱃지 숫자 + 노출 동기화
  const floatingBtn = document.getElementById("imsmassi-floating-btn");
  if (floatingBtn) {
    const badge = floatingBtn.querySelector(".imsmassi-assistant-badge");
    if (badge) badge.textContent = unread > 0 ? String(unread) : "";
    floatingBtn.classList.toggle("imsmassi-show-badge", unread > 0);
  }
  state.hasUnreadReminder = unread > 0;
}

function setUnreadReminder(isUnread) {
  state.hasUnreadReminder = isUnread;
  const floatingBtn = document.getElementById("imsmassi-floating-btn");
  if (floatingBtn) {
    const badge = floatingBtn.querySelector(".imsmassi-assistant-badge");
    if (badge) {
      if (isUnread) {
        // 정확한 숫자가 있으면 사용, 없으면 ! 표시
        const unread = (state.notifications || []).filter(n => !n.isRead).length;
        badge.textContent = unread > 0 ? String(unread) : "!";
      } else {
        badge.textContent = "";
      }
    }
    floatingBtn.classList.toggle("imsmassi-show-badge", !!isUnread);
  }
  if (!isUnread) {
    clearTabTitleCount();
  }
}

// 리마인더 확인 및 알림 발송
async function checkReminders() {
  if (!state.memos) return;

  const now = new Date();
  // 로컬 날짜 사용 (toISOString()은 UTC라 한국 시간대에서 날짜가 밀림)
  const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`; // HH:MM

  // 같은 분에 여러 번 알림이 울리지 않도록 처리
  if (lastCheckedMinute === currentTime) {
    return;
  }

  let hasNewReminder = false;

  // 모든 메모 탐색 (객체 형식: {memoId: memoData, ...})
  for (const [memoId, memo] of Object.entries(state.memos)) {
    if (memo.reminder && !memo.done) {
      const [reminderDate, reminderTime] = memo.reminder.split(" ");

      // 알림 시간이 도래했는지 확인 (분 단위로 비교)
      if (reminderDate === currentDate && reminderTime === currentTime) {
        hasNewReminder = true;

        const title = memo.title || "알림";
        const plainText = getMemoPlainText(memo).substring(0, 50);
        const areaId = memo.createdAreaId || "underwriting";

        // UI 알림 표시
        if (state.settings.reminderNotificationEnabled !== false) {
          showNotificationToast(
            title,
            plainText || "메모 알림이 도래했습니다",
            areaId,
            6000,
          );
          // incrementTabTitleCount()는 showBalloonNotification 내부에서
          // 말풍선이 사라질 때 1회만 호출되므로 여기서는 중복 호출하지 않습니다.

          // 브라우저 알림 발송
          sendBrowserNotification(title, {
            body: plainText || "메모 알림이 도래했습니다",
            tag: `reminder-${memoId}`,
            requireInteraction: false,
          });
        }

        // 알림 이력 기록 (대시보드 미확인 알림 목록용)
        workerSend('RECORD_NOTIFICATION', { memoId, title, firedAt: Date.now() });

        // 반복 알림이면 다음날로 이동
        if (memo.reminderRepeat) {
          const nextDate = new Date(now);
          nextDate.setDate(nextDate.getDate() + 1);
          // 로컬 날짜 사용
          const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`;
          const nextReminderStr = `${nextDateStr} ${reminderTime}`;
          // Worker에 SET_REMINDER 전송 (DB 업데이트 + 브로드캐스트)
          workerSend("SET_REMINDER", {
            memoId,
            reminderStr: nextReminderStr,
            title: memo.title,
            reminderRepeat: true,
          });
          if (state.activeTab === "dashboard") renderAssistantContent();
        }

        assiConsole.log(`알림 발송: ${title}`);
      }
    }
  }

  // 알림을 확인한 분 기록
  if (hasNewReminder) {
    lastCheckedMinute = currentTime;
  }

  return hasNewReminder;
}

// 주기적으로 리마인더 확인 (5초마다 실시간 확인)
function initReminderSystem() {
  // 초기 요청 권한
  requestNotificationPermission();

  // 첫 체크는 즉시
  checkReminders();

  // AssistantConfig.advanced.reminderCheckInterval ms마다 확인 (기본 5000ms)
  window.reminderCheckInterval = setInterval(() => {
    checkReminders();
  }, AssistantConfig.advanced.reminderCheckInterval);

  assiConsole.log("알림 시스템이 초기화되었습니다.");
}

// 알림 시스템 중지
function stopReminderSystem() {
  if (window.reminderCheckInterval) {
    clearInterval(window.reminderCheckInterval);
    window.reminderCheckInterval = null;
  }
}

function testReminderNotification() {
  const title = "리마인더 테스트";
  const content = "리마인더 알림 테스트 메시지입니다.";
  const areaId = state.selectedArea || "underwriting";
  const now = Date.now();
  showNotificationToast(title, content, areaId, 6000);
  sendBrowserNotification(title, {
    body: content,
    tag: `reminder-test-${now}`,
    requireInteraction: false,
  });
  // 알림 이력 저장 (RECORD_NOTIFICATION) — 뱃지/타이틀은 Worker broadcastState→syncNotifTabTitle 경로로 반영
  workerSend('RECORD_NOTIFICATION', { memoId: null, title, firedAt: now });
}

// ========================================
// 알림 시스템 테스트 함수
// ========================================
function openAssistant() {
  state.assistantOpen = true;
  renderAssistant();
  _runHook('onPanelOpen');
}

function closeAssistant() {
  saveAllDirtyNotes(); // 포스트잇 미저장 내용 강제 플러시
  state.assistantOpen = false;
  renderAssistant();
  _runHook('onPanelClose');
}

function setActiveTab(tabId) {
  let nextTab = tabId;
  if (tabId === "clipboard" || tabId === "template") {
    nextTab = tabId;
  } else if (tabId === "time") {
    nextTab = "dashboard";
  }
  const previousTab = state.activeTab;
  state.activeTab = nextTab;
  renderAssistantTabs();
  if (nextTab === "clipboard") {
    refreshClipboardStateFromDB().then(() => {
      renderAssistantContent(previousTab);
      updateDashboardButton();
    });
  } else {
    renderAssistantContent(previousTab);
    updateDashboardButton();
  }
}

// ============================================================================
// [Section 9] UI COMPONENTS: MODALS & SETTINGS  🪟 모달 빌더 및 설정
// ============================================================================
// buildReminderModal, buildTemplateSuggestModal, buildAddTemplateModal
// buildSettingsModal, buildClearAllDataConfirmModal, buildShortcutManualModal
// openModal, closeModal, getSettingsHtml, renderSettingsTab, saveSettings
// exportAllData, importData, clearOldData, runAutoCleanup
// ============================================================================
// 각 모달 타입에 대한 전용 빌더 함수입니다.
// 빌더 함수는 createElement를 사용하여 DOM 요소를 프로그래밍 방식으로 생성하고,
// { content: DOMNode, firstFocus: Element|null } 객체를 반환합니다.
// openModal()은 반환된 content를 appendChild로 삽입하고 firstFocus에 focus()를 호출합니다.

// ── 빌더: 리마인더 설정 모달 ─────────────────────────────
function buildReminderModal(data) {
  const c = getColors();
  const memoId = data ? data.memoId : null;
  const memoForReminder = state.memos[memoId];

  const todayDate = toLocalDateStr();
  let reminderDate = todayDate,
    reminderTime = "14:00",
    reminderTitle = "",
    reminderRepeat = false;

  if (memoForReminder && memoForReminder.reminder) {
    const parts = memoForReminder.reminder.trim().split(" ");
    if (parts[0] && parts[0].match(/^\d{4}-\d{2}-\d{2}$/))
      reminderDate = parts[0];
    if (parts[1] && parts[1].match(/^\d{2}:\d{2}$/)) reminderTime = parts[1];
  }
  if (memoForReminder) {
    reminderTitle =
      memoForReminder.title ||
      getMemoPlainText(memoForReminder).substring(0, 20).trim();
  }
  if (memoForReminder && memoForReminder.reminderRepeat) reminderRepeat = true;

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-bell"></span>${t("modal.reminderTitle")}`;

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = t("modal.reminderMemoTitleLabel");
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-title-input",
    placeholder: t("modal.reminderMemoTitlePlaceholder"),
  });
  titleInput.value = reminderTitle;
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const dateLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  dateLabel.textContent = t("modal.reminderDateLabel");
  const dateInput = createElement("input", {
    type: "date",
    className: "imsmassi-modal-input",
    id: "modal-date-input",
  });
  dateInput.value = reminderDate;
  const dateGroup = createElement("div");
  dateGroup.append(dateLabel, dateInput);

  const timeLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  timeLabel.textContent = t("modal.reminderTimeLabel");
  const timeInput = createElement("input", {
    type: "time",
    className: "imsmassi-modal-input",
    id: "modal-time-input",
  });
  timeInput.value = reminderTime;
  const timeGroup = createElement("div");
  timeGroup.append(timeLabel, timeInput);

  const repeatInput = createElement("input", {
    type: "checkbox",
    id: "modal-repeat-input",
  });
  repeatInput.checked = reminderRepeat;
  const repeatLabel = createElement("label", {
    className: "imsmassi-modal-label imsmassi-modal-label-inline",
  });
  repeatLabel.setAttribute("for", "modal-repeat-input");
  repeatLabel.textContent = t("modal.reminderRepeatLabel");
  const repeatGroup = createElement("div", {
    className: "imsmassi-modal-repeat-group",
  });
  repeatGroup.append(repeatInput, repeatLabel);

  const quickLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  quickLabel.textContent = t("modal.reminderQuickLabel");
  const quickBtnsWrap = createElement("div", {
    className: "imsmassi-flex imsmassi-gap-8 imsmassi-flex-wrap",
  });
  ["09:00", "12:00", "14:00", "17:00"].forEach((t) => {
    const btn = createElement("button", {
      className: "imsmassi-memo-action-btn imsmassi-quick-time-btn",
    });
    btn.textContent = t;
    btn.addEventListener("click", () => setQuickTime(t));
    quickBtnsWrap.appendChild(btn);
  });
  const quickGroup = createElement("div", {
    className: "imsmassi-modal-quick-group",
  });
  quickGroup.append(quickLabel, quickBtnsWrap);

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);
  const clearBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  clearBtn.textContent = t("ui.btnClearReminder");
  clearBtn.addEventListener("click", confirmClearReminder);
  const confirmBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  confirmBtn.textContent = t("ui.btnSet");
  confirmBtn.addEventListener("click", confirmSetReminder);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, clearBtn, confirmBtn);

  const content = createElement("div");
  content.append(
    title,
    titleGroup,
    dateGroup,
    timeGroup,
    repeatGroup,
    quickGroup,
    btnsGroup,
  );
  return { content, firstFocus: titleInput };
}

// ── 빌더: 템플릿 제안 모달 ─────────────────────────────
function buildTemplateSuggestModal(data) {
  const c = getColors();
  const suggestedText = data?.suggestedText || "";
  const encodedText = encodeURIComponent(suggestedText);

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-star"></span>${t("modal.templateSuggestTitle")}`;

  const previewBox = createElement("div", {
    className: "imsmassi-template-suggest-preview",
  });
  const previewLbl = createElement("div", {
    className: "imsmassi-template-suggest-preview-lbl",
  });
  previewLbl.textContent = t("modal.templateSuggestPreviewLabel");
  const codeEl = createElement("code", {
    className: "imsmassi-template-suggest-code",
  });
  codeEl.textContent = suggestedText;
  previewBox.append(previewLbl, codeEl);

  const tmplLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  tmplLabel.textContent = t("modal.templateSuggestNameLabel");
  const tmplInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-suggested-template-title",
    placeholder: t("modal.templateSuggestNamePlaceholder"),
  });
  const tmplGroup = createElement("div");
  tmplGroup.append(tmplLabel, tmplInput);

  const catPinnedLabel = createElement("label", { className: "imsmassi-modal-label" });
  catPinnedLabel.textContent = t("modal.templatePinnedLabel");
  const catPinnedToggle = createElement("label", { className: "imsmassi-toggle-switch" });
  const catPinnedCheckbox = createElement("input", { type: "checkbox", id: "modal-suggested-template-pinned" });
  const catPinnedSlider = createElement("span", { className: "imsmassi-toggle-slider" });
  catPinnedToggle.append(catPinnedCheckbox, catPinnedSlider);
  const catGroup = createElement("div", { className: "imsmassi-modal-pinned-row" });
  catGroup.append(catPinnedLabel, catPinnedToggle);

  const laterBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  laterBtn.textContent = t("ui.btnLater");
  laterBtn.addEventListener("click", closeModal);
  const addBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  addBtn.textContent = t("ui.btnAddAsTemplate");
  addBtn.addEventListener("click", () =>
    confirmAddSuggestedTemplate(encodedText),
  );
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(laterBtn, addBtn);

  const content = createElement("div");
  content.append(title, previewBox, tmplGroup, catGroup, btnsGroup);
  return { content, firstFocus: tmplInput };
}

// ── 빌더: 템플릿 추가 모달 ─────────────────────────────
function buildAddTemplateModal(data) {
  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-template"></span>${t("modal.templateAddTitle")}`;

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = t("modal.templateTitleLabel");
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-template-title",
    placeholder: t("modal.templateTitlePlaceholder"),
  });
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const contentLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  contentLabel.textContent = t("modal.templateContentLabel");
  const contentTextarea = createElement("textarea", {
    className: "imsmassi-modal-textarea",
    id: "modal-template-content",
    placeholder: t("modal.templateContentPlaceholder"),
  });
  // data.content가 전달되면 즉시 값을 주입합니다 (기존 setTimeout 해킹 제거).
  if (data && data.content) contentTextarea.value = data.content;
  const contentGroup = createElement("div");
  contentGroup.append(contentLabel, contentTextarea);

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);
  const addBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  addBtn.textContent = t("ui.btnAdd");
  addBtn.addEventListener("click", confirmAddTemplate);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, addBtn);

  const addPinnedLabel = createElement("label", { className: "imsmassi-modal-label" });
  addPinnedLabel.textContent = t("modal.templatePinnedLabel");
  const addPinnedToggle = createElement("label", { className: "imsmassi-toggle-switch" });
  const addPinnedCheckbox = createElement("input", { type: "checkbox", id: "modal-template-pinned" });
  const addPinnedSlider = createElement("span", { className: "imsmassi-toggle-slider" });
  addPinnedToggle.append(addPinnedCheckbox, addPinnedSlider);
  const addPinnedGroup = createElement("div", { className: "imsmassi-modal-pinned-row" });
  addPinnedGroup.append(addPinnedLabel, addPinnedToggle);

  const content = createElement("div");
  content.append(title, titleGroup, contentGroup, addPinnedGroup, btnsGroup);
  return { content, firstFocus: titleInput };
}

// ── 빌더: 템플릿 수정 모달 ─────────────────────────────
function buildEditTemplateModal(data) {
  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-edit"></span>${t("modal.templateEditTitle")}`;

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = t("modal.templateTitleLabel");
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-edit-template-title",
    placeholder: t("modal.templateTitlePlaceholder"),
  });
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const contentLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  contentLabel.textContent = t("modal.templateContentLabel");
  const contentTextarea = createElement("textarea", {
    className: "imsmassi-modal-textarea",
    id: "modal-edit-template-content",
    placeholder: t("modal.templateContentPlaceholder"),
  });
  // state.editingTemplateId를 통해 기존 값을 즉시 채웁니다 (setTimeout 해킹 제거).
  const existingTemplate = state.templates.find(
    (t) => t.id === state.editingTemplateId,
  );
  if (existingTemplate) {
    titleInput.value = existingTemplate.title || "";
    contentTextarea.value = existingTemplate.content || "";
  }
  const contentGroup = createElement("div");
  contentGroup.append(contentLabel, contentTextarea);

  const editPinnedLabel = createElement("label", { className: "imsmassi-modal-label" });
  editPinnedLabel.textContent = t("modal.templatePinnedLabel");
  const editPinnedToggle = createElement("label", { className: "imsmassi-toggle-switch" });
  const editPinnedCheckbox = createElement("input", { type: "checkbox", id: "modal-edit-template-pinned" });
  if (existingTemplate?.pinned) editPinnedCheckbox.checked = true;
  const editPinnedSlider = createElement("span", { className: "imsmassi-toggle-slider" });
  editPinnedToggle.append(editPinnedCheckbox, editPinnedSlider);
  const editPinnedGroup = createElement("div", { className: "imsmassi-modal-pinned-row" });
  editPinnedGroup.append(editPinnedLabel, editPinnedToggle);

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  saveBtn.textContent = t("ui.btnSave");
  saveBtn.addEventListener("click", confirmEditTemplate);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, saveBtn);

  const content = createElement("div");
  content.append(title, titleGroup, contentGroup, editPinnedGroup, btnsGroup);
  return { content, firstFocus: titleInput };
}

// ── 빌더: 메모 복사/공유 선택 모달 ──────────────────────────
function buildMemoContextActionModal(data) {
  const { memoId, placement } = data || {};
  const currentMenu = state.selectedMenu;

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-memo"></span>${t("modal.memoContextActionTitle")}`;

  const bodyText = createElement("p", { className: "imsmassi-modal-body-text" });
  bodyText.textContent = t("modal.memoContextActionBody", { menu: currentMenu });

  const bodyDiv = createElement("div", { className: "imsmassi-modal-body" });
  bodyDiv.appendChild(bodyText);

  const optionsDiv = createElement("div", { className: "imsmassi-modal-options" });

  const copyOption = createElement("button", { className: "imsmassi-modal-option-btn" });
  copyOption.innerHTML = `<strong>${t("modal.memoContextActionCopyTitle")}</strong><span>${t("modal.memoContextActionCopyDesc")}</span>`;
  copyOption.addEventListener("click", () => {
    const hasDropPosition =
      placement &&
      Number.isFinite(Number(placement.x)) &&
      Number.isFinite(Number(placement.y));
    const resolvedPlacement = hasDropPosition
      ? { x: placement.x, y: placement.y, width: AssistantConfig.ui.stickyNoteDefaultWidth, height: AssistantConfig.ui.stickyNoteDefaultHeight }
      : getDefaultStickyPlacement(memoId);
    workerSend("COPY_MEMO_AND_STICKY", {
      memoId,
      targetMenuId: currentMenu,
      targetAreaId: state.selectedArea,
      placement: resolvedPlacement,
    });
    closeModal();
  });

  const shareOption = createElement("button", { className: "imsmassi-modal-option-btn" });
  shareOption.innerHTML = `<strong>${t("modal.memoContextActionShareTitle")}</strong><span>${t("modal.memoContextActionShareDesc")}</span>`;
  shareOption.addEventListener("click", () => {
    addCurrentAreaLabel(memoId);
    addStickyNote(memoId, placement?.x, placement?.y);
    closeModal();
  });

  optionsDiv.append(copyOption, shareOption);

  const cancelBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-secondary" });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);

  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.appendChild(cancelBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, optionsDiv, btnsGroup);
  return { content, firstFocus: copyOption };
}

// ── 빌더: 메모 삭제 확인 모달 ─────────────────────────
function buildDeleteConfirmModal(data) {
  const c = getColors();

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-warning"></span>${t("modal.memoDeleteTitle")}`;

  const bodyText = createElement("p", {
    className: "imsmassi-modal-body-text",
  });
  bodyText.textContent =
    "이 메모를 삭제하시겠습니까? (포스트잇도 함께 삭제됩니다.)";
  const reminderDisplay = createElement("div", {
    id: "modal-delete-reminder-display",
  });
  const bodyDiv = createElement("div", { className: "imsmassi-modal-body" });
  bodyDiv.append(bodyText, reminderDisplay);

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", cancelDeleteMemo);
  const deleteBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-danger",
  });
  deleteBtn.textContent = t("ui.btnDelete");
  deleteBtn.addEventListener("click", confirmDeleteMemo);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, deleteBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, btnsGroup);
  return { content, firstFocus: null };
}

// ── 빌더: 템플릿 삭제 확인 모달 ─────────────────────────
function buildTemplateDeleteConfirmModal(data) {
  const { templateId } = data || {};

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-warning"></span>${t("modal.templateDeleteTitle")}`;

  const bodyText = createElement("p", { className: "imsmassi-modal-body-text" });
  bodyText.textContent = t("modal.templateDeleteBody");

  const bodyDiv = createElement("div", { className: "imsmassi-modal-body" });
  bodyDiv.appendChild(bodyText);

  const cancelBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-secondary" });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);

  const deleteBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-danger" });
  deleteBtn.textContent = t("ui.btnDelete");
  deleteBtn.addEventListener("click", () => {
    workerSend("DELETE_TEMPLATE", { templateId });
    closeModal();
  });

  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, deleteBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, btnsGroup);
  return { content, firstFocus: cancelBtn };
}

// ── 빌더: 설정 모달 ───────────────────────────────────
function buildSettingsModal(data) {
  const container = createElement("div");
  container.innerHTML = getSettingsHtml("closeModal");
  return { content: container, firstFocus: null };
}

// ── 모달 빌더 라우팅 맵 ───────────────────────────────
const MODAL_BUILDERS = {
  memoContextAction: buildMemoContextActionModal,
  setReminder: buildReminderModal,
  templateSuggest: buildTemplateSuggestModal,
  addTemplate: buildAddTemplateModal,
  editTemplate: buildEditTemplateModal,
  deleteConfirm: buildDeleteConfirmModal,
  templateDeleteConfirm: buildTemplateDeleteConfirmModal,
  settings: buildSettingsModal,
  clearAllDataConfirm: buildClearAllDataConfirmModal,
  importConfirm: buildImportConfirmModal,
  shortcutManual: buildShortcutManualModal,
};

// ── 빌더: 전체 데이터 삭제 확인 모달 ─────────────────────────
function buildClearAllDataConfirmModal() {
  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-warning"></span>${t("modal.clearAllTitle")}`;

  const bodyText = createElement("p", { className: "imsmassi-modal-body-text" });
  bodyText.innerHTML = `${t("modal.clearAllBody")}<br><span style='color:#E74C3C; font-size:12px;'>${t("modal.clearAllBodySub")}</span>`;

  const bodyDiv = createElement("div", { className: "imsmassi-modal-body" });
  bodyDiv.append(bodyText);

  const cancelBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-secondary" });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);

  const deleteBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-danger" });
  deleteBtn.textContent = t("ui.btnDeleteAll");
  deleteBtn.addEventListener("click", executeClearAllData);

  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, deleteBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, btnsGroup);
  return { content, firstFocus: cancelBtn };
}

// ── 전체 데이터 삭제 실행 ──
function executeClearAllData() {
  workerSend("CLEAR_MEMO_AND_CLIPBOARD", {});
  closeModal();
}

// ── 빌더: 데이터 가져오기 확인 모달 ─────────────────────────
function buildImportConfirmModal() {
  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span class="imsmassi-modal-icon imsmassi-icon-warning"></span>${t("system.importConfirmTitle") || t("ui.btnImport")}`;

  const bodyText = createElement("p", { className: "imsmassi-modal-body-text" });
  bodyText.innerHTML = `${t("system.importConfirm")}<br><span style='color:#E74C3C; font-size:12px;'>${t("system.importConfirmSub") || ""}</span>`;

  const bodyDiv = createElement("div", { className: "imsmassi-modal-body" });
  bodyDiv.append(bodyText);

  const cancelBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-secondary" });
  cancelBtn.textContent = t("ui.btnCancel");
  cancelBtn.addEventListener("click", closeModal);

  const confirmBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-primary" });
  confirmBtn.textContent = t("ui.btnImport");
  confirmBtn.addEventListener("click", () => {
    closeModal();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const importedData = JSON.parse(text);
        workerSend("IMPORT_DATA", { importedData });
      } catch (error) {
        console.error("데이터 가져오기 실패:", error);
        showToast(t("system.importFail"));
      }
    };
    input.click();
  });

  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, confirmBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, btnsGroup);
  return { content, firstFocus: cancelBtn };
}

// ── 빌더: 단축키 메뉴얼 모달 ─────────────────────────────────
function buildShortcutManualModal() {
  const SHORTCUTS = [
    {
      group: t("modal.shortcutGroupNav"),
      items: [
        { keys: ["Alt", "1"], desc: t("shortcut.tab1") },
        { keys: ["Alt", "2"], desc: t("shortcut.tab2") },
      ],
    },
    {
      group: t("modal.shortcutGroupAssistant") || "어시스턴트",
      items: [
        { keys: ["Ctrl", "`"], desc: t("shortcut.toggleAssistant") || "패널 열기/닫기" },
        { keys: ["Escape"], desc: t("shortcut.closeModal") },
      ],
    },
    {
      group: t("modal.shortcutGroupScreen"),
      items: [
        { keys: ["Ctrl", "/"], desc: t("shortcut.screenHelp") },
        { keys: ["Ctrl", "Shift", "X"], desc: t("shortcut.gridZoom") },
      ],
    },
    {
      group: t("modal.shortcutGroupGrid"),
      items: [
        { keys: ["Delete"], desc: t("shortcut.cellDelete") },
        { keys: ["Alt", "Insert"], desc: t("shortcut.rowAdd") },
        { keys: ["Alt", "Delete"], desc: t("shortcut.rowDelete") },
        { keys: ["Ctrl", "A"], desc: t("shortcut.gridCopyAll") },
        { keys: ["Ctrl", "Shift", "F"], desc: t("shortcut.gridSearch") },
      ],
    },
    {
      group: t("modal.shortcutGroupEtc"),
      items: [
        { keys: ["F2"], desc: t("shortcut.cellDoubleClick") },
      ],
    },
  ];

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.innerHTML = `<span style="font-size:16px;">⌨</span> ${t("modal.shortcutHelpTitle")}`;

  const body = createElement("div", { className: "imsmassi-shortcut-manual-body" });

  SHORTCUTS.forEach(({ group, items }) => {
    const groupEl = createElement("div", { className: "imsmassi-shortcut-group" });

    const groupTitle = createElement("div", { className: "imsmassi-shortcut-group-title" });
    groupTitle.textContent = group;
    groupEl.appendChild(groupTitle);

    items.forEach(({ keys, desc }) => {
      const row = createElement("div", { className: "imsmassi-shortcut-row" });

      const keysEl = createElement("div", { className: "imsmassi-shortcut-keys" });
      keys.forEach((k, i) => {
        const kbd = createElement("kbd", { className: "imsmassi-shortcut-kbd" });
        kbd.textContent = k;
        keysEl.appendChild(kbd);
        if (i < keys.length - 1) {
          const plus = createElement("span", { className: "imsmassi-shortcut-plus" });
          plus.textContent = "+";
          keysEl.appendChild(plus);
        }
      });

      const descEl = createElement("div", { className: "imsmassi-shortcut-desc" });
      descEl.textContent = desc;

      row.append(keysEl, descEl);
      groupEl.appendChild(row);
    });

    body.appendChild(groupEl);
  });

  const footer = createElement("div", { className: "imsmassi-shortcut-manual-footer" });
  footer.textContent = t("modal.shortcutFooter");

  const closeBtn = createElement("button", { className: "imsmassi-modal-btn imsmassi-modal-btn-secondary" });
  closeBtn.textContent = t("ui.btnClose");
  closeBtn.addEventListener("click", closeModal);

  const btns = createElement("div", { className: "imsmassi-modal-btns" });
  btns.appendChild(closeBtn);

  const content = createElement("div");
  content.append(title, body, footer, btns);
  return { content, firstFocus: closeBtn };
}

// ========================================
// 모달 시스템
// ========================================
function openModal(type, data) {
  assiConsole.log("[openModal] 모달 타입:", type, "데이터:", data);
  state.currentModal = type;
  state.currentMemoId = data ? data.memoId : null;
  assiConsole.log("[openModal] state.currentMemoId 설정:", state.currentMemoId);

  const modal = document.getElementById("modal-content");

  // ── 빌더 함수 호출 ────────────────────────────────────
  // MODAL_BUILDERS 맵에서 타입에 맞는 빌더를 찾아 호출합니다.
  // 빌더가 없는 타입은 무시됩니다.
  const builder = MODAL_BUILDERS[type];
  if (!builder) {
    assiConsole.warn("[openModal] 알 수 없는 모달 타입:", type);
    return;
  }

  const { content: builtContent, firstFocus } = builder(data);

  // ── DOM 삽입 (innerHTML 대신 appendChild) ─────────────
  modal.innerHTML = "";
  modal.appendChild(builtContent);

  // ── 설정 모달 너비 조정 ───────────────────────────────
  if (type === "settings") {
    modal.classList.add("imsmassi-modal-wide");
    modal.classList.remove("imsmassi-modal-xl");
  } else if (type === "shortcutManual") {
    modal.classList.remove("imsmassi-modal-wide");
    modal.classList.add("imsmassi-modal-xl");
  } else {
    modal.classList.remove("imsmassi-modal-wide", "imsmassi-modal-xl");
  }

  // ── 오버레이 표시 ─────────────────────────────────────
  document
    .getElementById("imsmassi-modal-overlay")
    .classList.remove("imsmassi-hidden");

  // ── 설정 탭 초기화 (토글/셀렉트 이벤트 바인딩) ────────
  if (type === "settings") {
    initSettingsTab();
  }

  // ── 포커스 설정 (빌더가 반환한 firstFocus 요소) ────────
  // 기존 setTimeout 해킹 없이 빌더가 지정한 요소에 즉시 포커스합니다.
  if (firstFocus) {
    requestAnimationFrame(() => firstFocus.focus());
  }
}

function getSettingsHtml(closeHandler) {
  const usagePercentRaw =
    state.storageLimit > 0 ? (state.storageUsed / state.storageLimit) * 100 : 0;
  const usagePercent = usagePercentRaw.toFixed(1);
  const usageColor =
    usagePercent >= 80 ? "#E74C3C" : usagePercent >= 60 ? "#E67E22" : "#5BA55B";
  const displayUsed = state.storageUsed.toFixed(1);
  return `
        <!-- 알림 설정 -->
        <div class="imsmassi-settings-section">
          <div class="imsmassi-settings-section-title"><span class="imsmassi-modal-icon imsmassi-icon-bell"></span>${t("settings.sectionNotification")}</div>

          <div class="imsmassi-settings-row">
            <div>
              <span class="imsmassi-settings-label">${t("settings.reminderNotifLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.reminderNotifDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-reminder-notification" ${state.settings.reminderNotificationEnabled !== false ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row imsmassi-settings-row-mt">
            <div>
              <span class="imsmassi-settings-label">${t("settings.toastNotifLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.toastNotifDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-toast" ${state.settings.toastEnabled ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row imsmassi-settings-row-mt">
            <div>
              <span class="imsmassi-settings-label">${t("settings.backupNotifLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.backupNotifDesc", {lastBackup: state.settings.lastBackup})}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-backup" ${state.settings.backupReminder ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- 기능 설정 -->
        <div class="imsmassi-settings-section">
          <div class="imsmassi-settings-section-title" style="display: ${state.hiddenUI.featureSectionTitle !== false ? 'block' : 'none'};"><span class="imsmassi-modal-icon imsmassi-icon-settings"></span>${t("settings.sectionFeature")}</div>
          <div class="imsmassi-settings-row imsmassi-settings-row-mb" style="display: ${state.hiddenUI.areaColor ? "flex" : "none"};">
            <div>
              <span class="imsmassi-settings-label">${t("settings.areaColorLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.areaColorDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-show-area-color" ${state.settings.showAreaColorSection !== false ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row imsmassi-settings-row-mb" style="display: ${state.hiddenUI.timeInsight ? "flex" : "none"};">
            <div>
              <span class="imsmassi-settings-label">${t("settings.timeInsightLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.timeInsightDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-show-time-tab" ${state.settings.showTimeTab !== false ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row imsmassi-settings-row-mb" style="display: ${state.hiddenUI.markdown ? "flex" : "none"};">
            <div>
              <span class="imsmassi-settings-label">${t("settings.markdownLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.markdownDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-markdown" ${state.settings.markdownEnabled ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row imsmassi-settings-row-mb" style="display: ${state.hiddenUI.debugLog ? "flex" : "none"};">
            <div>
              <span class="imsmassi-settings-label">${t("settings.debugLogLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.debugLogDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-debug-logs" ${state.settings.debugLogs ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div class="imsmassi-settings-row" style="display: ${state.hiddenUI.autoNav ? "flex" : "none"};">
            <div>
              <span class="imsmassi-settings-label">${t("settings.autoDashboardLabel")}</span>
              <div class="imsmassi-settings-desc">${t("settings.autoDashboardDesc")}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-auto-dashboard" ${state.settings.autoNavigateToDashboard ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- 자동정리 설정 -->
        <div class="imsmassi-cleanup-section">
          <div class="imsmassi-settings-section-title"><span class="imsmassi-modal-icon imsmassi-icon-cleanup"></span>${t("settings.sectionAutoCleanup")}</div>
          <div class="imsmassi-cleanup-grid">
            <div class="imsmassi-cleanup-row">
              <span class="imsmassi-cleanup-label">${t("settings.clipboardCleanupLabel")}</span>
              <select class="imsmassi-modal-input imsmassi-select-sm" id="setting-clipboard">
                <option value="3" ${state.settings.autoCleanup.clipboard === 3 ? "selected" : ""}>${t("settings.cleanup3days")}</option>
                <option value="7" ${state.settings.autoCleanup.clipboard === 7 ? "selected" : ""}>${t("settings.cleanup7days")}</option>
                <option value="14" ${state.settings.autoCleanup.clipboard === 14 ? "selected" : ""}>${t("settings.cleanup14days")}</option>
                <option value="30" ${state.settings.autoCleanup.clipboard === 30 ? "selected" : ""}>${t("settings.cleanup30days")}</option>
              </select>
            </div>
            <div class="imsmassi-cleanup-row">
              <span class="imsmassi-cleanup-label">${t("settings.oldMemoLabel")}</span>
              <select class="imsmassi-modal-input imsmassi-select-sm" id="setting-oldmemos">
                <option value="0" ${(state.settings.autoCleanup.oldMemos === 0 || state.settings.autoCleanup.oldMemos == null) ? "selected" : ""}>${t("settings.cleanupNever")}</option>
                <option value="90" ${state.settings.autoCleanup.oldMemos === 90 ? "selected" : ""}>${t("settings.cleanup90days")}</option>
                <option value="180" ${state.settings.autoCleanup.oldMemos === 180 ? "selected" : ""}>${t("settings.cleanup180days")}</option>
                <option value="365" ${state.settings.autoCleanup.oldMemos === 365 ? "selected" : ""}>${t("settings.cleanup1year")}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 저장 용량 -->
        <div class="imsmassi-storage-box">
          <div class="imsmassi-storage-header">
            <span class="imsmassi-storage-title">${t("settings.sectionStorage")}</span>
            <span style="font-size: 12px; color: ${usageColor}; font-weight: 600;">${displayUsed}MB / ${state.storageLimit}MB</span>
          </div>
          <div class="imsmassi-progress-bar">
            <div class="imsmassi-progress-fill" style="width: ${usagePercent}%; background: ${usageColor};"></div>
          </div>
          <div class="imsmassi-storage-hint">${usagePercent >= 80 ? t("settings.storageLowGuide") : t("settings.storageNormalGuide")}</div>
          <div class="imsmassi-storage-actions">
            <button class="imsmassi-modal-btn imsmassi-btn-primary" onclick="exportAllData()">${t("ui.btnExport")}</button>
            <button class="imsmassi-modal-btn imsmassi-btn-secondary" onclick="importData()">${t("ui.btnImport")}</button>
            <button class="imsmassi-modal-btn imsmassi-btn-danger" onclick="openModal('clearAllDataConfirm')">${t("ui.btnClear")}</button>
          </div>
        </div>

        <!-- 온보딩 가이드 다시보기 -->
        <div class="imsmassi-guide-section-row">
          <div>
            <div class="imsmassi-settings-label" style="font-weight: 600;">${t("settings.sectionGuide")}</div>
            <div class="imsmassi-settings-desc" style="margin-top: 2px;">${t("settings.guideDesc")}</div>
          </div>
          <button class="imsmassi-modal-btn imsmassi-btn-guide" onclick="AssistantGuide.replay()">${t("ui.btnGuideReview")}</button>
        </div>

      `;
}

function renderSettingsTab() {
  return getSettingsHtml("closeSettingsTab");
}

function initSettingsTab() {
  const toggleMap = [
    { id: "setting-markdown", label: "마크다운 단축키" },
    { id: "setting-debug-logs", label: "디버그 로그" },
    { id: "setting-auto-dashboard", label: "대시보드 자동 이동" },
    { id: "setting-backup", label: "백업 알림" },
    { id: "setting-reminder-notification", label: "리마인더 알림" },
    { id: "setting-browser-notification", label: "브라우저 알림" },
    { id: "setting-toast", label: "토스트 알림" },
    { id: "setting-show-time-tab", label: "시간 탭 표시" },
    { id: "setting-show-area-color", label: "업무 컬러 설정 표시" },
  ];

  toggleMap.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = () => {
        assiConsole.log(`설정 변경 - ${label}: ${el.checked ? "ON" : "OFF"}`);
        saveSettings({ silent: true });
      };
    }
  });

  const selectMap = ["setting-clipboard", "setting-oldmemos"];
  selectMap.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = () => saveSettings({ silent: true });
    }
  });
}

function closeModal() {
  assiConsole.log("[closeModal] 모달 닫기 시작");
  const modalOverlay = document.getElementById("imsmassi-modal-overlay");
  if (modalOverlay) modalOverlay.classList.add("imsmassi-hidden");
  state.currentModal = null;
  state.currentMemoId = null;
  state.editingTemplateId = null;
  assiConsole.log("[closeModal] 모달 닫기 완료");
}

// 모달 외부 클릭 시 닫기
const modalOverlay = document.getElementById("imsmassi-modal-overlay");
if (modalOverlay) {
  modalOverlay.addEventListener("click", function (e) {
    if (e.target === this) {
      closeModal();
    }
  });
}

// ========================================
// 리마인더 기능
// ========================================
function openReminderModal(memoId) {
  openModal("setReminder", { memoId: memoId });
  // 모달 생성 시점에 이미 기존 리마인더 값이 초기화됨
}

function setQuickTime(time) {
  const input = document.getElementById("modal-time-input");
  if (input) input.value = time;
}

async function confirmSetReminder() {
  const titleInput = document.getElementById("modal-title-input");
  const dateInput = document.getElementById("modal-date-input");
  const timeInput = document.getElementById("modal-time-input");
  const repeatInput = document.getElementById("modal-repeat-input");
  const title = titleInput.value.trim();
  const date = dateInput.value;
  const time = timeInput.value;
  const isRepeat = !!repeatInput?.checked;

  if (!date || !time) {
    showToast(t("modal.reminderDatetimeRequired"));
    return;
  }

  const memoId = state.currentMemoId;
  const memo = state.memos[memoId];

  if (!memo) {
    showToast(t("system.memoFindFail"));
    return;
  }

  if (!memoId) {
    showToast(t("system.memoIdFindFail"));
    return;
  }

  workerSend("SET_REMINDER", {
    memoId,
    reminderStr: `${date} ${time}`,
    title,
    reminderRepeat: isRepeat,
  });
  closeModal();
  if (state.autoNavigateToDashboard) setActiveTab("dashboard");
}

function confirmClearReminder() {
  const memoId = state.currentMemoId;
  if (!memoId || !state.memos[memoId]) {
    showToast(t("system.memoFindFail"));
    return;
  }
  workerSend("SET_REMINDER", {
    memoId,
    reminderStr: null,
    reminderRepeat: false,
  });
  closeModal();
  if (state.autoNavigateToDashboard) setActiveTab("dashboard");
}

ㅠ