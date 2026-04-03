/**
 * assistant-worker.js
 * 어시스턴트 Shared Worker - 중계 서버 (Broker) 역할
 *
 * 3-Tier 아키텍처:
 *   Tier 1: 클라이언트 (MDI 탭, 어시스턴트 UI) → 메시지 송신
 *   Tier 2: 중계 서버 (이 파일) → 상태/DB 중앙 관리, 브로드캐스트
 *   Tier 3: IndexedDB → 오직 이 Worker에서만 접근
 *
 * 클라이언트 → Worker: { type: 'ACTION_TYPE', payload: {...} }
 * Worker → 클라이언트: { type: 'STATE_UPDATE', payload: state }
 *                      { type: 'TOAST', payload: { message } }
 *                      { type: 'EXPORT_DATA_RESULT', payload: { data } }
 */
'use strict';

// ========================================
// Tier 3: IndexedDB 관리 모듈
// ========================================
class AssistantDB {
  constructor(dbName = 'AssistantDB', dbVersion = 6) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.db = null;
    this.stores = ['memos', 'clipboard', 'templates', 'settings', 'metadata', 'userinfo', 'notifications'];
  }

  async init() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (e) { void e; }
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(this.db); };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('memos')) {
          const s = db.createObjectStore('memos', { keyPath: 'id' });
          s.createIndex('areaId', 'areaId', { unique: false });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('pinned', 'pinned', { unique: false });
        }
        if (!db.objectStoreNames.contains('clipboard')) {
          const s = db.createObjectStore('clipboard', { keyPath: 'id', autoIncrement: true });
          s.createIndex('menu', 'menu', { unique: false });
          s.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains('templates')) {
          db.createObjectStore('templates', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata');
        }
        // userinfo 스토어: 암호화된 사용자 정보 (key-value, key='current')
        if (!db.objectStoreNames.contains('userinfo')) {
          db.createObjectStore('userinfo');
        }
        // notifications 스토어: 알림 발송 이력 { id(자동증가), memoId, title, firedAt, isRead }
        if (!db.objectStoreNames.contains('notifications')) {
          const ns = db.createObjectStore('notifications', { keyPath: 'id', autoIncrement: true });
          ns.createIndex('memoId', 'memoId', { unique: false });
          ns.createIndex('isRead', 'isRead', { unique: false });
        }
      };
    });
  }

  async transaction(storeName, mode, callback) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let callbackResult = null;
      let hasError = false;
      try {
        callbackResult = callback(store);
        if (callbackResult && typeof callbackResult.onsuccess === 'function') {
          callbackResult.onsuccess = () => {};
          callbackResult.onerror = () => { hasError = true; };
        }
        tx.oncomplete = () => { hasError ? reject(new Error('Request failed')) : resolve(callbackResult); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(new Error('Transaction aborted'));
      } catch (error) { reject(error); }
    });
  }

  async addMemo(memoId, memo) {
    if (!memoId) throw new Error('memoId가 없습니다');
    memo.id = memoId;
    memo.timestamp = Date.now();
    return this.transaction('memos', 'readwrite', (store) => store.put(memo));
  }

  async getMemosByArea(areaId) {
    return this.transaction('memos', 'readonly', (store) => {
      const index = store.index('areaId');
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

  async updateMemo(memo, memoId) {
    if (memoId && !memo.id) memo.id = memoId;
    memo.updatedAt = memo.updatedAt || Date.now();
    return this.transaction('memos', 'readwrite', (store) => store.put(memo));
  }

  async deleteMemo(memoId) {
    if (!memoId) throw new Error('memoId가 없습니다');
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('memos', 'readwrite');
      const store = tx.objectStore('memos');
      const request = store.delete(memoId);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('Transaction aborted'));
    });
  }

  async getAllMemos() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('memos', 'readonly');
      const store = tx.objectStore('memos');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async addClipboardItem(item) {
    item.timestamp = Date.now();
    return this.transaction('clipboard', 'readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const request = store.add(item);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async updateClipboardItem(item) {
    return this.transaction('clipboard', 'readwrite', (store) => store.put(item));
  }

  async getClipboardItems(limit = 50) {
    return this.transaction('clipboard', 'readonly', (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const items = request.result.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
          resolve(items);
        };
      });
    });
  }

  async deleteClipboardItem(itemId) {
    return this.transaction('clipboard', 'readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const request = store.delete(itemId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
  }

  async deleteOldClipboardItems(daysBefore = 7) {
    const cutoffTime = Date.now() - (daysBefore * 24 * 60 * 60 * 1000);
    return this.transaction('clipboard', 'readwrite', (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const oldItems = request.result.filter(item => item.timestamp < cutoffTime);
          oldItems.forEach(item => store.delete(item.id));
          resolve(oldItems.length);
        };
      });
    });
  }

  async deleteOldMemos(daysBefore = 90) {
    if (!daysBefore || daysBefore <= 0) return [];
    const cutoffTime = Date.now() - (daysBefore * 24 * 60 * 60 * 1000);
    return this.transaction('memos', 'readwrite', (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const deletedIds = [];
          request.result.forEach(memo => {
            const createdAt = memo?.createdAt || memo?.timestamp
              || (memo?.date ? new Date(memo.date).getTime() : null);
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

  async addTemplate(template) {
    template.createdAt = Date.now();
    return this.transaction('templates', 'readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const request = store.add(template);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async getAllTemplates() {
    return this.transaction('templates', 'readonly', (store) => {
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result.sort((a, b) => b.count - a.count));
      });
    });
  }

  async updateTemplate(template) {
    return this.transaction('templates', 'readwrite', (store) => store.put(template));
  }

  async deleteTemplate(templateId) {
    return this.transaction('templates', 'readwrite', (store) => store.delete(templateId));
  }

  async saveSetting(key, value) {
    return this.transaction('settings', 'readwrite', (store) => store.put(value, key));
  }

  async getSetting(key) {
    return this.transaction('settings', 'readonly', (store) => {
      return new Promise((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
      });
    });
  }

  async getAllSettings() {
    return this.transaction('settings', 'readonly', (store) => {
      return new Promise((resolve) => {
        const valuesRequest = store.getAll();
        const keysRequest = store.getAllKeys();
        let values = null;
        let keys = null;
        const tryResolve = () => {
          if (!values || !keys) return;
          resolve(keys.map((key, i) => ({ key, value: values[i] })));
        };
        valuesRequest.onsuccess = () => { values = valuesRequest.result || []; tryResolve(); };
        keysRequest.onsuccess = () => { keys = keysRequest.result || []; tryResolve(); };
      });
    });
  }

  async saveMetadata(key, value) {
    return this.transaction('metadata', 'readwrite', (store) =>
      store.put({ ...value, timestamp: Date.now() }, key)
    );
  }

  async exportAllData() {
    const memos = await this.getAllMemos();
    const templates = await this.getAllTemplates();
    const settings = await this.getAllSettings();
    const clipboard = await this.getClipboardItems(500);
    const stickyNotes = (await this.getSetting('sticky_notes')) || [];
    const filteredSettings = settings.filter(s => !['menu_time_stats', 'time_buckets', 'sticky_notes'].includes(s.key));
    return { version: '1.0', exportDate: new Date().toISOString(), data: { memos, templates, settings: filteredSettings, clipboard, stickyNotes } };
  }

  async importData(importedData) {
    if (!importedData.data) throw new Error('잘못된 데이터 형식');
    const { memos = [], templates = [], settings = [], clipboard = [], stickyNotes } = importedData.data;
    const normalizedMemos = Array.isArray(memos) ? memos : Object.values(memos || {});
    const normalizedTemplates = Array.isArray(templates) ? templates : Object.values(templates || {});
    const normalizedClipboard = Array.isArray(clipboard) ? clipboard : Object.values(clipboard || {});
    const normalizedSettings = (() => {
      if (!settings) return [];
      if (Array.isArray(settings)) {
        return settings.map(item => {
          if (!item || typeof item !== 'object') return null;
          if ('key' in item) return { key: item.key, value: item.value };
          const keys = Object.keys(item);
          if (keys.length === 1) return { key: keys[0], value: item[keys[0]] };
          return null;
        }).filter(Boolean);
      }
      if (typeof settings === 'object') return Object.keys(settings).map(key => ({ key, value: settings[key] }));
      return [];
    })();
    for (const memo of normalizedMemos) {
      if (!memo || typeof memo !== 'object') continue;
      const memoId = memo.id || memo.memoId || memo.areaId;
      await this.addMemo(memoId, memo);
    }
    for (const template of normalizedTemplates) {
      if (!template || typeof template !== 'object') continue;
      await this.addTemplate(template);
    }
    // 클립보드 가져오기: store.put으로 원본 id·timestamp 유지
    for (const item of normalizedClipboard) {
      if (!item || typeof item !== 'object') continue;
      if (!item.content) continue;
      // id가 있으면 put(기존 레코드 덮어쓰기), 없으면 id 제거 후 add(자동증가)
      const itemToSave = { ...item };
      if (!itemToSave.timestamp) itemToSave.timestamp = Date.now();
      await this.updateClipboardItem(itemToSave);
    }
    for (const setting of normalizedSettings) {
      if (!setting || !setting.key) continue;
      if (['menu_time_stats', 'time_buckets', 'sticky_notes'].includes(setting.key)) continue;
      await this.saveSetting(setting.key, setting.value);
    }
    // 포스트잇 복원: 최상위 stickyNotes 필드 우선, 없으면 settings 내 sticky_notes 폴백
    const stickyToRestore = Array.isArray(stickyNotes)
      ? stickyNotes
      : (normalizedSettings.find(s => s.key === 'sticky_notes')?.value || []);
    if (Array.isArray(stickyToRestore)) {
      await this.saveSetting('sticky_notes', stickyToRestore);
    }
    return { success: true, imported: normalizedMemos.length + normalizedTemplates.length + normalizedClipboard.length };
  }

  async clearAll() {
    for (const storeName of ['memos', 'clipboard', 'templates', 'settings', 'metadata']) {
      await this.transaction(storeName, 'readwrite', (store) => store.clear());
    }
  }

  /** 암호화된 userInfo 저장 */
  async saveUserInfo(encryptedUserInfo) {
    return this.transaction('userinfo', 'readwrite', (store) => {
      return store.put(encryptedUserInfo, 'current');
    });
  }

  /** 암호화된 userInfo 조회 */
  async getUserInfo() {
    return this.transaction('userinfo', 'readonly', (store) => {
      return new Promise((resolve) => {
        const req = store.get('current');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      });
    });
  }

  // ── 알림 이력 메서드 ──
  async addNotification(notification) {
    return this.transaction('notifications', 'readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.add(notification);
        req.onsuccess = () => resolve(req.result); // 새로 생성된 id 반환
        req.onerror   = () => reject(req.error);
      });
    });
  }

  async getAllNotifications() {
    return this.transaction('notifications', 'readonly', (store) => {
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.firedAt - a.firedAt));
      });
    });
  }

  async markNotificationRead(notifId) {
    return this.transaction('notifications', 'readwrite', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(notifId);
        req.onsuccess = () => {
          const notif = req.result;
          if (notif) { notif.isRead = true; store.put(notif); }
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  async markAllNotificationsRead() {
    return this.transaction('notifications', 'readwrite', (store) => {
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => {
          req.result.forEach(n => { n.isRead = true; store.put(n); });
          resolve(req.result.length);
        };
      });
    });
  }

  async clearOldNotifications(daysToKeep = 30) {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    return this.transaction('notifications', 'readwrite', (store) => {
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const old = req.result.filter(n => n.firedAt < cutoff);
          old.forEach(n => store.delete(n.id));
          resolve(old.length);
        };
      });
    });
  }
}

// ========================================
// Tier 2: 중앙 상태 (Central State)
// ========================================
let db = null;
let _initialized = false;
let memoIdSequence = 0;

/**
 * 슬라이딩 윈도우 복사 추적 Map
 * key: content 문자열, value: 복사 발생 타임스탬프 배열
 * COPY_WINDOW_MS 이내에 COPY_THRESHOLD 회 복사 시 템플릿 제안 발동
 */
const _copyWindowMap = new Map();
const COPY_WINDOW_MS   = 10 * 60 * 1000; // 10분
const COPY_THRESHOLD   = 5;              // 5회

/** 이미 템플릿 제안을 실행한 컨텐츠 목록 (최초 1회만 발동) 
 *  단 워커 재시작 시 초기화되어 다시 제안 가능
*/
const _suggestedContents = new Set();

const state = {
  currentTheme: 'classic', // 
  isDarkMode: false,
  selectedArea: 'UW',
  selectedMenu: '',  // 클라이언트 CONTEXT_CHANGE 수신 전까지 빈 값 유지
  memoFilter: 'all', // 'menu', 'area', 'all'
  isMemoPanelExpanded: false,
  lastMenuChangeTime: Date.now(),
  menuTimeStats: {},
  timeBuckets: { daily: {}, weekly: {}, monthly: {} },
  memos: {},
  memosByArea: {},
  clipboard: [],
  templates: [],
  stickyNotes: [],
  areaColors: {},   // 업무영역별 커스텀 컬러 { UW: { primary, sub1, sub2 }, ... }
  userInfo: null,   // 암호화된 사용자 정보 (복호화는 클라이언트에서 처리)
  settings: {
    autoCleanup: { clipboard: 7, oldMemos: 0 },
    lowSpecMode: false,
    debugLogs: true,
    backupReminder: true,
    lastBackup: new Date().toISOString().split('T')[0],
    enableClipboardCapture: true,
    markdownEnabled: true,
    autoNavigateToDashboard: true,
    browserNotificationEnabled: true,
    toastEnabled: true,
    showTimeTab: false,
    showAreaColorSection: false,
  },
  nextMemoId: 10,
  nextTemplateId: 10,
  nextClipboardId: 10,
  hasSeenGuide: null,
  hasUnreadReminder: false, // 미확인 리마인더 알림 전역 상태
  notifications: [],        // 알림 발송 이력 { id, memoId, title, firedAt, isRead }
  panelHeight: null,          // px, null = CSS 기본값
  panelWidth: null,           // px, null = CSS 기본값
  panelWidthCollapsed: null,  // 접힌 상태 저장 너비
  panelWidthExpanded: null,   // 펼친 상태 저장 너비
  // 용량 추적 — Worker가 권위적 소스 (모든 탭이 공유)
  storageUsed: 0,   // MB
  storageLimit: 50, // MB
};

// ========================================
// Tier 1: 클라이언트 포트 관리
// ========================================
const ports = new Set();

/**
 * 탭(포트)별 독립 컨텍스트 Map
 * 여러 탭이 열려 있을 때 selectedArea/selectedMenu/시간 통계가 서로 충돌하지 않도록
 * 각 포트마다 독립적인 컨텍스트를 유지합니다.
 */
const clientContextMap = new Map();

/** 새 포트에 대한 초기 클라이언트 컨텍스트 생성 */
function initClientContext(port) {
  clientContextMap.set(port, {
    selectedArea:       state.selectedArea,
    selectedMenu:       state.selectedMenu,
    lastMenuChangeTime: Date.now(),
    menuTimeStats:      {},   // 현재 세션 누적 (DB 기준값은 state.menuTimeStats)
    timeBuckets:        { daily: {}, weekly: {}, monthly: {} },
    isActive:           true,  // 탭 포커스 여부 — false인 탭은 시간 누적 안 함
  });
}

/** 포트의 클라이언트 컨텍스트 반환 (없으면 초기화) */
function getClientContext(port) {
  if (!clientContextMap.has(port)) initClientContext(port);
  return clientContextMap.get(port);
}

/** stats 객체 두 개를 덧셈 병합 */
function mergeStats(base, delta) {
  if (!delta) return base || {};
  const merged = { ...(base || {}) };
  Object.entries(delta).forEach(([areaId, ms]) => {
    merged[areaId] = (merged[areaId] || 0) + ms;
  });
  return merged;
}

/** timeBuckets 객체 두 개를 덧셈 병합 */
function mergeTimeBuckets(base, delta) {
  if (!delta) return base || { daily: {}, weekly: {}, monthly: {} };
  const merged = {
    daily:   { ...(base?.daily   || {}) },
    weekly:  { ...(base?.weekly  || {}) },
    monthly: { ...(base?.monthly || {}) },
  };
  ['daily', 'weekly', 'monthly'].forEach(period => {
    const src = delta[period] || {};
    Object.entries(src).forEach(([key, areaData]) => {
      if (!merged[period][key]) merged[period][key] = {};
      Object.entries(areaData).forEach(([areaId, ms]) => {
        merged[period][key][areaId] = (merged[period][key][areaId] || 0) + ms;
      });
    });
  });
  return merged;
}

/** 모든 연결된 클라이언트에게 메시지 브로드캐스트 (타입/페이로드 직접 지정) */
function broadcast(type, payload) {
  ports.forEach(port => {
    try { port.postMessage({ type, payload }); }
    catch (e) { ports.delete(port); clientContextMap.delete(port); }
  });
}

// ========================================
// Worker 디버그 포워더
// Worker 내부 로그를 클라이언트 F12 콘솔로 전달 (chrome://inspect 없이 디버깅 가능)
// ========================================
/**
 * workerConsole.log  - debugLogs 설정이 켜진 경우에만 전달 (노이즈 억제)
 * workerConsole.warn  - 항상 전달 (알 수 없는 메시지 타입 등)
 * workerConsole.error - 항상 전달 (핸들러 오류 등 크리티컬)
 */
const workerConsole = {
  log:   (...args) => { if (state?.settings?.debugLogs) broadcast('WORKER_DEBUG_LOG', { level: 'log',   args }); },
  warn:  (...args) => broadcast('WORKER_DEBUG_LOG', { level: 'warn',  args }),
  error: (...args) => broadcast('WORKER_DEBUG_LOG', { level: 'error', args }),
};

/** 특정 포트에만 메시지 전송 */
function sendTo(port, type, payload) {
  try { port.postMessage({ type, payload }); }
  catch (e) { ports.delete(port); clientContextMap.delete(port); }
}

/**
 * 전송 가능한 상태 스냅샷 반환 (postMessage에 필요한 직렬화 가능 객체)
 * port를 전달하면 해당 탭의 독립 컨텍스트(selectedArea 등)가 적용됩니다.
 * UI-only 상태 (activeTab, currentModal 등)는 클라이언트가 로컬로 관리합니다.
 */
function getSnapshot(port) {
  const ctx = port ? clientContextMap.get(port) : null;
  return {
    currentTheme:        state.currentTheme,
    isDarkMode:          state.isDarkMode,
    // 탭별 독립 컨텍스트 — 다른 탭의 화면 전환이 이 탭에 영향을 주지 않음
    selectedArea:        ctx ? ctx.selectedArea        : state.selectedArea,
    selectedMenu:        ctx ? ctx.selectedMenu        : state.selectedMenu,
    memoFilter:          state.memoFilter,
    isMemoPanelExpanded: state.isMemoPanelExpanded,
    lastMenuChangeTime:  ctx ? ctx.lastMenuChangeTime  : state.lastMenuChangeTime,
    // 시간 통계: DB에 저장된 값만 반환 (탭 간 중복 누적 방지)
    // 현재 세션 누적분은 BEFORE_UNLOAD 시점에만 DB에 병합 저장됨
    menuTimeStats:       state.menuTimeStats,
    timeBuckets:         state.timeBuckets,
    memos:               state.memos,
    memosByArea:         state.memosByArea,
    clipboard:           state.clipboard,
    templates:           state.templates,
    stickyNotes:         state.stickyNotes,
    areaColors:          state.areaColors,
    settings:            state.settings,
    nextTemplateId:      state.nextTemplateId,
    userInfo:            state.userInfo,
    hasSeenGuide:        state.hasSeenGuide,
    hasUnreadReminder:   state.hasUnreadReminder,
    notifications:       state.notifications,
    panelHeight:            state.panelHeight,
    panelWidth:             state.panelWidth,
    panelWidthCollapsed:    state.panelWidthCollapsed,
    panelWidthExpanded:     state.panelWidthExpanded,
    // 용량 정보 — Worker가 계산해 클라이언트로 전달
    storageUsed:            state.storageUsed,
    storageLimit:           state.storageLimit,
  };
}

/** 상태 변경 후 모든 클라이언트에게 브로드캐스트 (각 탭은 자신의 컨텍스트로 수신) */
function broadcastState() {
  ports.forEach(port => {
    try { port.postMessage({ type: 'STATE_UPDATE', payload: getSnapshot(port) }); }
    catch (e) { ports.delete(port); clientContextMap.delete(port); }
  });
}

// ========================================
// 유틸리티 함수 (Worker 스코프)
// ========================================
function ensureMenuIndex(menuId) {
  if (!menuId) return;
  if (!state.memosByArea[menuId]) state.memosByArea[menuId] = [];
}

// ── 날짜 버킷 키 함수 ──
function getDailyBucket(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeeklyBucket(date = new Date()) {
  const year = date.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - jan4.getDay());
  const diff = date.getTime() - weekStart.getTime();
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getMonthlyBucket(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ── 시간 추적 ──
function recordToBucket(areaId, elapsedMs) {
  if (!areaId) return;
  if (!state.timeBuckets) state.timeBuckets = { daily: {}, weekly: {}, monthly: {} };
  const now = new Date();
  const dk = getDailyBucket(now);
  const wk = getWeeklyBucket(now);
  const mk = getMonthlyBucket(now);
  const add = (bucket, key) => {
    if (!state.timeBuckets[bucket]) state.timeBuckets[bucket] = {};
    if (!state.timeBuckets[bucket][key]) state.timeBuckets[bucket][key] = {};
    state.timeBuckets[bucket][key][areaId] = (state.timeBuckets[bucket][key][areaId] || 0) + elapsedMs;
  };
  add('daily', dk);
  add('weekly', wk);
  add('monthly', mk);
}

function recordAreaTime(areaId) {
  if (!areaId) return;
  const now = Date.now();
  const elapsedMs = now - state.lastMenuChangeTime;
  if (!state.menuTimeStats[areaId]) state.menuTimeStats[areaId] = 0;
  state.menuTimeStats[areaId] += elapsedMs;
  recordToBucket(areaId, elapsedMs);
  state.lastMenuChangeTime = now;
}

/**
 * 탭(포트)별 독립 시간 기록
 * 특정 탭의 areaId 체류 시간을 해당 탭의 클라이언트 컨텍스트에만 누적합니다.
 */
function recordClientAreaTime(port, areaId) {
  if (!areaId) return;
  const ctx = getClientContext(port);
  // 비활성 탭(백그라운드/포커스 없음)은 시간 누적 안 함 → 탭 수 증가 시 중복 집계 방지
  if (!ctx.isActive) return;
  const now = Date.now();
  const elapsedMs = now - ctx.lastMenuChangeTime;
  if (elapsedMs <= 0) return;
  if (!ctx.menuTimeStats[areaId]) ctx.menuTimeStats[areaId] = 0;
  ctx.menuTimeStats[areaId] += elapsedMs;
  // timeBuckets에도 기록
  if (!ctx.timeBuckets) ctx.timeBuckets = { daily: {}, weekly: {}, monthly: {} };
  const nowDate = new Date();
  const dk = getDailyBucket(nowDate);
  const wk = getWeeklyBucket(nowDate);
  const mk = getMonthlyBucket(nowDate);
  const add = (bucket, key) => {
    if (!ctx.timeBuckets[bucket]) ctx.timeBuckets[bucket] = {};
    if (!ctx.timeBuckets[bucket][key]) ctx.timeBuckets[bucket][key] = {};
    ctx.timeBuckets[bucket][key][areaId] = (ctx.timeBuckets[bucket][key][areaId] || 0) + elapsedMs;
  };
  add('daily', dk);
  add('weekly', wk);
  add('monthly', mk);
  ctx.lastMenuChangeTime = now;
}

// ── 메뉴 시간 통계 저장/로드 ──
async function loadMenuTimeStats() {
  try {
    const savedStats = await db.getSetting('menu_time_stats');
    if (savedStats && typeof savedStats === 'object') state.menuTimeStats = savedStats;
    const savedBuckets = await db.getSetting('time_buckets');
    if (savedBuckets && typeof savedBuckets === 'object') state.timeBuckets = savedBuckets;
  } catch (error) {
    console.error('[Worker] 메뉴 시간 통계 로드 실패:', error);
  }
}

async function saveMenuTimeStats() {
  try {
    recordAreaTime(state.selectedArea);
    await db.saveSetting('menu_time_stats', state.menuTimeStats);
    await db.saveSetting('time_buckets', state.timeBuckets);
  } catch (error) {
    console.error('[Worker] 메뉴 시간 통계 저장 실패:', error);
  }
}

// ── 워커 용량 추산 (Worker가 권위적 소스 — 모든 탭 공유) ──
/**
 * Worker state 데이터를 JSON 직렬화해 Blob 크기로 용량을 추정합니다.
 * IndexedDB 오버헤드 1.5배 보정 적용.
 */
function calculateWorkerStorageMB() {
  try {
    const payload = {
      memos:         state.memos,
      stickyNotes:   state.stickyNotes,
      clipboard:     state.clipboard,
      templates:     state.templates,
      menuTimeStats: state.menuTimeStats,
      timeBuckets:   state.timeBuckets,
    };
    const bytes = new Blob([JSON.stringify(payload)]).size;
    return (bytes * 1.5) / (1024 * 1024);
  } catch (_) {
    return 0;
  }
}

/**
 * state.storageUsed 를 최신 값으로 갱신합니다.
 * navigator.storage.estimate() 지원 시 우선 사용, 미지원 시 Blob 추정치 사용.
 * Worker 스코프에서 비동기 await 가능.
 */
async function refreshStorageUsed() {
  state.storageLimit = 50;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      if (estimate.usage && estimate.usage > 0) {
        state.storageUsed = estimate.usage / (1024 * 1024);
        return;
      }
    }
  } catch (_) { /* 미지원 환경 폴백 */ }
  state.storageUsed = calculateWorkerStorageMB();
}

// ========================================
// DB 초기화 및 상태 로드
// ========================================
async function ensureInit(loginId) {
  if (_initialized) return;
  const dbName = loginId ? `AssistantDB_${loginId}` : 'AssistantDB_public';
  db = new AssistantDB(dbName, 6);
  await loadStateFromDB();
  _initialized = true;
}

/**
 * 최초 DB 생성 시 앱 사용법을 안내하는 샘플 데이터를 삽입합니다.
 */
async function seedInitialData() {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const currentArea = state.selectedArea || 'UW';
  const isEn = (state.seedLocale || 'ko-kr').startsWith('en');

  // 로케일별 텍스트 분기
  const SEED = isEn ? {
    memo1Title:   'Welcome 🎉',
    memo1Content: 'Welcome to Solomon Assistant!\n\nWrite your work memos here and boost productivity with the clipboard and template features.',
    memo1MenuId:  'Main',
    memo1Labels:  ['Main'],
    memo2Title:   'Prepare Afternoon Report',
    memo2Content: 'Compile weekly performance data and send the report email to team lead',
    memo2MenuId:  'Main',
    memo2Labels:  ['Main'],
    cb1:          '123-45-67890',
    cb2:          'hong.gildong@solomon.com',
    cbMenu:       'Main',
    tplTitle:     'Approval Request Email',
    tplContent:   'Hello,\nI would like to request approval for the following.\n\n- Contract No.: \n- Customer: \n- Request: \n\nThank you.',
  } : {
    memo1Title:   '환영합니다 🎉',
    memo1Content: '솔로몬 어시스턴트에 오신 것을 환영합니다!\n\n이곳에 업무 메모를 작성하고, 우측의 클립보드와 템플릿 기능을 활용하여 업무 효율을 높여보세요.',
    memo1MenuId:  '메인화면',
    memo1Labels:  ['메인화면'],
    memo2Title:   '오후 업무보고 준비',
    memo2Content: '주간 실적 데이터 취합 및 팀장님께 결과 보고 메일 발송하기',
    memo2MenuId:  '메인화면',
    memo2Labels:  ['메인화면'],
    cb1:          '123-45-67890',
    cb2:          'hong.gildong@solomon.com',
    cbMenu:       '메인화면',
    tplTitle:     '승인 요청 메일',
    tplContent:   '안녕하세요, 담당자님.\n아래 건에 대해 승인 요청드립니다.\n\n- 계약번호: \n- 고객명: \n- 요청사항: \n\n감사합니다.',
  };

  // 1. 환영 메모 (고정)
  await db.addMemo('mdi-sample-1', {
    title: SEED.memo1Title,
    content: SEED.memo1Content,
    pinned: true,
    createdAreaId: currentArea,
    menuId: SEED.memo1MenuId,
    labels: SEED.memo1Labels,
    reminder: null,
    date: today,
    isRichText: false,
    createdAt: now,
    updatedAt: now,
  });

  // 2. 리마인더 포함 메모 (현재 시각 기준 2시간 뒤)
  const reminderTime = new Date(now + 2 * 60 * 60 * 1000);
  const rDate = reminderTime.toISOString().split('T')[0];
  const rTime = `${String(reminderTime.getHours()).padStart(2, '0')}:${String(reminderTime.getMinutes()).padStart(2, '0')}`;
  await db.addMemo('mdi-sample-2', {
    title: SEED.memo2Title,
    content: SEED.memo2Content,
    pinned: false,
    createdAreaId: currentArea,
    menuId: SEED.memo2MenuId,
    labels: SEED.memo2Labels,
    reminder: `${rDate} ${rTime}`,
    reminderRepeat: false,
    done: false,
    date: today,
    isRichText: false,
    createdAt: now + 1,
    updatedAt: now + 1,
  });

  // 3. 클립보드 예시 데이터
  await db.addClipboardItem({ content: SEED.cb1, menu: SEED.cbMenu, areaId: currentArea, timestamp: now,     count: 1 });
  await db.addClipboardItem({ content: SEED.cb2, menu: SEED.cbMenu, areaId: currentArea, timestamp: now + 1, count: 2 });

  // 4. 템플릿 예시 데이터
  await db.addTemplate({
    title: SEED.tplTitle,
    content: SEED.tplContent,
    category: 'default',
    count: 0,
    createdAt: now,
  });
}


async function loadStateFromDB() {
  await db.init();

  // 최초 1회 실행 여부 확인 및 예시 데이터 주입
  const isSeeded = await db.getSetting('isSeeded');
  if (!isSeeded) {
    await seedInitialData();
    await db.saveSetting('isSeeded', true);
  }

  const allMemos = await db.getAllMemos();
  state.memos = {};
  state.memosByArea = {};

  const savedTheme = await db.getSetting('currentTheme');
  if (savedTheme) state.currentTheme = savedTheme;

  const savedDarkMode = await db.getSetting('isDarkMode');
  if (typeof savedDarkMode === 'boolean') state.isDarkMode = savedDarkMode;

  const memoPanelExpanded = await db.getSetting('isMemoPanelExpanded');
  if (typeof memoPanelExpanded === 'boolean') state.isMemoPanelExpanded = memoPanelExpanded;

  const savedMemoFilter = await db.getSetting('memoFilter');
  if (['menu', 'area', 'all'].includes(savedMemoFilter)) state.memoFilter = savedMemoFilter;

  allMemos.forEach(memo => {
    if (!memo.id) return;
    state.memos[memo.id] = memo;
    if (memo.labels && Array.isArray(memo.labels)) {
      memo.labels.forEach(menuId => {
        ensureMenuIndex(menuId);
        if (!state.memosByArea[menuId].includes(memo.id)) {
          state.memosByArea[menuId].push(memo.id);
        }
      });
    }
  });

  // 정렬
  Object.keys(state.memosByArea).forEach(areaId => {
    state.memosByArea[areaId].sort((id1, id2) => {
      const m1 = state.memos[id1];
      const m2 = state.memos[id2];
      if (!m1 || !m2) return 0;
      if (m1.pinned !== m2.pinned) return m2.pinned ? 1 : -1;
      return new Date(m2.date || 0) - new Date(m1.date || 0);
    });
  });

  // memoIdSequence 복원
  const existingIds = Object.keys(state.memos);
  if (existingIds.length > 0) {
    const maxSeq = Math.max(...existingIds.map(id => {
      const match = id.match(/mdi-\d+-(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }));
    memoIdSequence = maxSeq;
  }

  const templates = await db.getAllTemplates();
  if (templates.length > 0) {
    state.templates = templates;
    state.nextTemplateId = Math.max(...templates.map(t => t.id || 0)) + 1;
  }

  const clipboardItems = await db.getClipboardItems(1000);
  if (clipboardItems.length > 0) {
    state.clipboard = clipboardItems;
    state.nextClipboardId = Math.max(...clipboardItems.map(c => c.id || 0)) + 1;
  }

  const settings = await db.getSetting('app_settings');
  if (settings) {
    state.settings = {
      // 1단계: Worker 기본값을 베이스로 깔고
      ...state.settings,
      // 2단계: DB 저장값으로 전체 덮어쓰기 (신규 키도 자동 반영)
      ...settings,
      // 3단계: 중첩 객체는 별도 병합 (스프레드만으로는 깊은 병합 불가)
      autoCleanup: { ...state.settings.autoCleanup, ...(settings.autoCleanup || {}) },
      // 4단계: 타입 안전이 필요한 boolean 키는 명시적으로 재지정
      // (DB에 undefined가 저장된 경우 스프레드 결과가 undefined가 되는 것을 방지)
      markdownEnabled:             settings.markdownEnabled             !== undefined ? settings.markdownEnabled             : state.settings.markdownEnabled,
      browserNotificationEnabled:  settings.browserNotificationEnabled  !== undefined ? settings.browserNotificationEnabled  : state.settings.browserNotificationEnabled,
      reminderNotificationEnabled: settings.reminderNotificationEnabled !== undefined ? settings.reminderNotificationEnabled : state.settings.reminderNotificationEnabled,
      debugLogs:                   settings.debugLogs                   !== undefined ? settings.debugLogs                   : state.settings.debugLogs,
      toastEnabled:                settings.toastEnabled                !== undefined ? settings.toastEnabled                : state.settings.toastEnabled,
      showTimeTab:                 settings.showTimeTab                 !== undefined ? settings.showTimeTab                 : state.settings.showTimeTab,
      showAreaColorSection:        settings.showAreaColorSection        !== undefined ? settings.showAreaColorSection        : state.settings.showAreaColorSection,
    };
    // Issue 5 긴급패치: 업무컬러설정 / 시간인사이트 항상 false로 초기화 (DB 저장값 무시)
    state.settings.showTimeTab = false;
    state.settings.showAreaColorSection = false;
    // 클립보드 캡처는 항상 활성화 (DB에 false가 저장된 경우에도 무시)
    state.settings.enableClipboardCapture = true;
  }

  const stickyNotes = await db.getSetting('sticky_notes');
  if (Array.isArray(stickyNotes)) state.stickyNotes = stickyNotes;

  const areaColors = await db.getSetting('area_colors');
  if (areaColors && typeof areaColors === 'object') state.areaColors = areaColors;

  // 온보딩 가이드 확인 여부 로드
  const hasSeenGuide = await db.getSetting('hasSeenGuide');
  state.hasSeenGuide = hasSeenGuide === true ? true : false;

  // 패널 높이 로드
  const savedPanelHeight = await db.getSetting('panelHeight');
  if (typeof savedPanelHeight === 'number') state.panelHeight = savedPanelHeight;

  // 패널 너비 로드
  const savedPanelWidth = await db.getSetting('panelWidth');
  if (typeof savedPanelWidth === 'number') state.panelWidth = savedPanelWidth;
  const savedPanelWidthCollapsed = await db.getSetting('panelWidthCollapsed');
  if (typeof savedPanelWidthCollapsed === 'number') state.panelWidthCollapsed = savedPanelWidthCollapsed;
  const savedPanelWidthExpanded = await db.getSetting('panelWidthExpanded');
  if (typeof savedPanelWidthExpanded === 'number') state.panelWidthExpanded = savedPanelWidthExpanded;

  // userInfo 로드 (암호화된 채로 state에 보관, 복호화는 클라이언트에서)
  try {
    const savedUserInfo = await db.getUserInfo();
    if (savedUserInfo) state.userInfo = savedUserInfo;
  } catch (e) {
    console.warn('[Worker] userInfo 로드 실패:', e);
  }

  // 알림 이력 로드 (30일 이상 된 항목 자동 정리)
  try {
    const savedNotifications = await db.getAllNotifications();
    if (savedNotifications.length > 0) state.notifications = savedNotifications;
    await db.clearOldNotifications(30);
  } catch (e) {
    console.warn('[Worker] notifications 로드 실패:', e);
  }

  await loadMenuTimeStats();
  await runAutoCleanup({ silent: true });
}

async function runAutoCleanup({ silent = true } = {}) {
  if (!state.settings?.autoCleanup) return;
  const clipboardDays = state.settings.autoCleanup?.clipboard ?? 7;
  const memoDays = state.settings.autoCleanup?.oldMemos ?? 90;
  try {
    if (clipboardDays > 0) {
      await db.deleteOldClipboardItems(clipboardDays);
      const items = await db.getClipboardItems(1000);
      state.clipboard = Array.isArray(items) ? items : [];
    }
    if (memoDays > 0) {
      const deletedIds = await db.deleteOldMemos(memoDays);
      deletedIds.forEach(id => {
        delete state.memos[id];
        Object.keys(state.memosByArea).forEach(areaId => {
          const idx = state.memosByArea[areaId].indexOf(id);
          if (idx > -1) state.memosByArea[areaId].splice(idx, 1);
        });
        state.stickyNotes = (state.stickyNotes || []).filter(n => n.memoId !== id);
      });
      if (deletedIds.length > 0) {
        await db.saveSetting('sticky_notes', state.stickyNotes);
      }
    }
  } catch (error) {
    console.error('[Worker] 자동 정리 실패:', error);
  }
}

// ========================================
// 메시지 핸들러 (모든 비즈니스 로직)
// ========================================

async function handleInit(port, payload) {
  // locale을 ensureInit 전에 먼저 설정 → seedInitialData()가 올바른 로케일로 실행됨
  if (payload?.locale && !state.seedLocale) {
    state.seedLocale = payload.locale;
  }
  await ensureInit(payload?.loginId);
  // CONTEXT_CHANGE가 INIT의 await 도중 먼저 처리된 경우 컨텍스트가 이미 존재할 수 있음
  if (!clientContextMap.has(port)) {
    initClientContext(port);
  }
  // INIT 페이로드의 초기 컨텍스트를 원자적으로 적용
  // bootstrapAssistant에서 수집한 menuId/areaId가 있으면 덮어씀 (레이스 결과 무관하게 보장)
  const ctx = clientContextMap.get(port);
  if (ctx) {
    if (payload?.menuId) ctx.selectedMenu = payload.menuId;
    if (payload?.areaId) ctx.selectedArea = payload.areaId;
  }
  sendTo(port, 'STATE_UPDATE', getSnapshot(port));
}

async function handleContextChange(port, payload) {
  const { areaId, menuId } = payload || {};
  const ctx = getClientContext(port);
  // 이전 area 체류 시간을 이 탭의 컨텍스트에만 기록 (다른 탭 불침범)
  recordClientAreaTime(port, ctx.selectedArea);
  if (areaId) ctx.selectedArea = areaId;
  if (menuId !== undefined) ctx.selectedMenu = menuId;
  // 이 탭에게만 상태 전송 (다른 탭의 selectedArea/selectedMenu를 건드리지 않음)
  sendTo(port, 'STATE_UPDATE', getSnapshot(port));
}

async function handleAddMemo(port, payload) {
  const { memoId, memoData } = payload;
  // 저장 전 용량 갱신 — Worker가 모든 탭의 공유 상태를 기준으로 판단
  await refreshStorageUsed();
  if (state.storageUsed >= state.storageLimit) {
    sendTo(port, 'TOAST', { messageKey: 'system.storageExceeded' });
    return;
  }
  await db.addMemo(memoId, memoData);
  state.memos[memoId] = memoData;
  ensureMenuIndex(memoData.menuId);
  if (!state.memosByArea[memoData.menuId].includes(memoId)) {
    state.memosByArea[memoData.menuId].unshift(memoId);
  }
  // 저장 후 용량 재계산 → broadcastState로 모든 탭에 최신 storageUsed 전파
  await refreshStorageUsed();
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.memoAdded' });
}

async function handleDeleteMemo(port, payload) {
  const { memoId } = payload;
  await db.deleteMemo(memoId);
  delete state.memos[memoId];
  Object.keys(state.memosByArea).forEach(areaId => {
    const idx = state.memosByArea[areaId].indexOf(memoId);
    if (idx > -1) state.memosByArea[areaId].splice(idx, 1);
  });
  state.stickyNotes = (state.stickyNotes || []).filter(n => n.memoId !== memoId);
  await db.saveSetting('sticky_notes', state.stickyNotes);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.memoDeleted' });
}

async function handleTogglePin(port, payload) {
  const { memoId } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;
  memo.pinned = !memo.pinned;
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  // memosByArea 재정렬
  Object.keys(state.memosByArea).forEach(areaId => {
    const list = state.memosByArea[areaId];
    if (!list || !list.includes(memoId)) return;
    const idx = list.indexOf(memoId);
    if (idx > -1) list.splice(idx, 1);
    if (memo.pinned) {
      list.unshift(memoId);
    } else {
      list.push(memoId);
    }
  });
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: memo.pinned ? 'system.memoPinned' : 'system.memoUnpinned' });
}

async function handleSaveMemoTitle(port, payload) {
  const { memoId, title } = payload;
  const memo = state.memos[memoId];
  if (!memo || memo.title === title) return;
  memo.title = title;
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  broadcastState();
}

async function handleSaveInlineEdit(port, payload) {
  const { memoId, content, isRichText } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;
  // 내용이 실제로 변경되지 않았으면 저장/토스트 스킵
  if (memo.content === content && memo.isRichText === isRichText) return;
  memo.content = content;
  memo.isRichText = isRichText;
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.memoUpdated' });
}

async function handleSetReminder(port, payload) {
  const { memoId, reminderStr, title, reminderRepeat } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;
  if (reminderStr) {
    memo.reminder = reminderStr;
    memo.reminderRepeat = !!reminderRepeat;
    memo.done = false;
  } else {
    memo.reminder = null;
    memo.reminderRepeat = false;
  }
  if (title !== undefined) memo.title = title;
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  broadcastState();
  if (reminderStr) {
    sendTo(port, 'TOAST', { messageKey: 'system.reminderSet', params: { reminderStr } });
  } else {
    sendTo(port, 'TOAST', { messageKey: 'system.reminderCleared' });
  }
}

async function handleAddClipboard(port, payload) {
  const { content, options = {} } = payload;
  if (!content || typeof content !== 'string') return;
  const trimmed = content.trim();
  if (!trimmed.length) return;

  if (!Array.isArray(state.clipboard)) state.clipboard = [];
  const existing = state.clipboard.findIndex(item => item.content === trimmed);
  const now = Date.now();

  // ── 슬라이딩 윈도우 업데이트 ──
  if (!options.skipTemplateSuggest) {
    if (!_copyWindowMap.has(trimmed)) _copyWindowMap.set(trimmed, []);
    const timestamps = _copyWindowMap.get(trimmed);
    timestamps.push(now);
    // 윈도우 밖 타임스탬프 제거
    const cutoff = now - COPY_WINDOW_MS;
    while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();

    // 윈도우 내 COPY_THRESHOLD 회 달성 + 최초 1회만 → 템플릿 제안
    if (timestamps.length >= COPY_THRESHOLD && !_suggestedContents.has(trimmed)) {
      const alreadyTemplate = state.templates.some(t => t.content === trimmed);
      if (!alreadyTemplate) {
        sendTo(port, 'TEMPLATE_SUGGEST', { suggestedText: trimmed });
      }
      // 컨텐츠를 제안 리스트에 등록 → 이후 엄마나 복사해도 재발동 안 함
      _suggestedContents.add(trimmed);
    }
  }

  if (existing > -1) {
    // 기존 항목 업데이트 (카운트 증가, 최상단 이동)
    const item = state.clipboard[existing];
    item.count = (item.count || 1) + 1;
    item.timestamp = now;
    state.clipboard.splice(existing, 1);
    state.clipboard.unshift(item);
    await db.updateClipboardItem(item);
    broadcastState();
    sendTo(port, 'TOAST', { messageKey: 'system.clipboardMoved', params: { count: item.count } });
  } else {
    // 신규 항목 추가
    const ctx = getClientContext(port);
    const newItem = {
      content: trimmed,
      menuId: ctx.selectedMenu || state.selectedMenu,
      menu: ctx.selectedMenu || state.selectedMenu,
      areaId: ctx.selectedArea || state.selectedArea,
      timestamp: now,
      count: 1,
    };
    state.clipboard.unshift(newItem);
    const id = await db.addClipboardItem(newItem);
    if (id) newItem.id = id;
    broadcastState();
    sendTo(port, 'TOAST', { messageKey: 'system.clipboardSaved' });
  }
}

async function handleDeleteClipboard(port, payload) {
  const { itemId } = payload;
  await db.deleteClipboardItem(itemId);
  const idx = (state.clipboard || []).findIndex(c => c.id === itemId);
  if (idx > -1) state.clipboard.splice(idx, 1);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.clipboardItemDeleted' });
}

async function handleAddTemplate(port, payload) {
  const { template } = payload;
  const id = await db.addTemplate(template);
  const newTemplate = { ...template, id };
  state.templates.unshift(newTemplate);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.templateAdded' });
}

async function handleEditTemplate(port, payload) {
  const { templateId, title, content, pinned } = payload;
  const template = state.templates.find(t => t.id === templateId);
  if (!template) return;
  template.title = title;
  template.content = content;
  if (pinned !== undefined) template.pinned = pinned;
  await db.updateTemplate(template);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.templateUpdated' });
}

async function handleToggleTemplatePin(port, payload) {
  const { templateId } = payload;
  const template = state.templates.find(t => t.id === templateId);
  if (!template) return;
  template.pinned = !template.pinned;
  await db.updateTemplate(template);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: template.pinned ? 'system.templatePinned' : 'system.templateUnpinned' });
}

async function handleDeleteTemplate(port, payload) {
  const { templateId } = payload;
  await db.deleteTemplate(templateId);
  const idx = state.templates.findIndex(t => t.id === templateId);
  if (idx > -1) state.templates.splice(idx, 1);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.templateDeleted' });
}

async function handleUseTemplate(port, payload) {
  const { templateId } = payload;
  const template = state.templates.find(t => t.id === templateId);
  if (template) {
    template.count = (template.count || 0) + 1;
    await db.updateTemplate(template);
  }
  broadcastState();
}

async function handleSetTheme(port, payload) {
  state.currentTheme = payload.themeKey;
  await db.saveSetting('currentTheme', payload.themeKey);
  broadcastState();
}

async function handleSetDarkMode(port, payload) {
  state.isDarkMode = payload.isDark;
  await db.saveSetting('isDarkMode', payload.isDark);
  broadcastState();
}

async function handleSaveSettings(port, payload) {
  state.settings = {
    ...state.settings,
    ...payload.settings,
    autoCleanup: {
      ...state.settings.autoCleanup,
      ...(payload.settings?.autoCleanup || {}),
    },
  };
  await db.saveSetting('app_settings', state.settings);
  broadcastState();
}

async function handleSaveAreaColors(port, payload) {
  const { areaId, colors } = payload;
  if (!state.areaColors) state.areaColors = {};
  if (colors) {
    state.areaColors[areaId] = { ...colors };
  } else {
    delete state.areaColors[areaId];
  }
  await db.saveSetting('area_colors', state.areaColors);
  broadcastState();
}

async function handleToggleTodo(port, payload) {
  const { memoId } = payload;
  const memo = state.memos[memoId];
  if (memo && memo.reminder) {
    memo.done = !memo.done;
    memo.updatedAt = Date.now();
    await db.updateMemo(memo, memoId);
  }
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: memo?.done ? 'system.memoCompleted' : 'system.memoUncompleted' });
}

async function handleSaveStickyNotes(port, payload) {
  state.stickyNotes = payload.stickyNotes || [];
  await db.saveSetting('sticky_notes', state.stickyNotes);
  broadcastState();
}

async function handleAddStickyNote(port, payload) {
  const { memoId, placement, menuId } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;

  // labels 업데이트
  if (!memo.labels) memo.labels = [];
  if (menuId && !memo.labels.includes(menuId)) {
    memo.labels.push(menuId);
    ensureMenuIndex(menuId);
    if (!state.memosByArea[menuId].includes(memoId)) {
      state.memosByArea[menuId].push(memoId);
    }
    memo.updatedAt = Date.now();
    await db.updateMemo(memo, memoId);
  }

  // stickyNotes 업데이트 — memoId+menuId 모두 일치하는 노트를 찾아야
  // memoId만으로 find하면 다른 화면 노트를 덮어쓰는 버그가 생김
  let note = (state.stickyNotes || []).find(n => n.memoId === memoId && n.menuId === menuId);
  if (!note) {
    note = { memoId, menuId, ...placement };
    if (!state.stickyNotes) state.stickyNotes = [];
    state.stickyNotes.push(note);
  } else if (placement) {
    Object.assign(note, placement);
  }

  await db.saveSetting('sticky_notes', state.stickyNotes);
  broadcastState();
}

async function handleRemoveStickyNote(port, payload) {
  const { memoId, menuId } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;

  // 해당 menuId 라벨 제거
  if (!memo.labels) memo.labels = [];
  if (menuId && memo.labels.includes(menuId)) {
    const idx = memo.labels.indexOf(menuId);
    memo.labels.splice(idx, 1);
    const areaIdx = (state.memosByArea[menuId] || []).indexOf(memoId);
    if (areaIdx > -1) state.memosByArea[menuId].splice(areaIdx, 1);
    memo.updatedAt = Date.now();
    await db.updateMemo(memo, memoId);
  }

  // 현재 menuId 화면의 노트만 제거 (다른 화면 포스트잇 보존)
  state.stickyNotes = (state.stickyNotes || []).filter(n => !(n.memoId === memoId && n.menuId === menuId));
  await db.saveSetting('sticky_notes', state.stickyNotes);

  broadcastState();
}

async function handleToggleLabel(port, payload) {
  const { memoId, menuId, force } = payload;
  const memo = state.memos[memoId];
  if (!memo) return;
  if (!memo.labels) memo.labels = [];

  const hasLabel = memo.labels.includes(menuId);
  const shouldAdd = force !== undefined ? force : !hasLabel;

  if (shouldAdd && !hasLabel) {
    memo.labels.push(menuId);
    ensureMenuIndex(menuId);
    if (!state.memosByArea[menuId].includes(memoId)) {
      state.memosByArea[menuId].push(memoId);
    }
  } else if (!shouldAdd && hasLabel) {
    memo.labels.splice(memo.labels.indexOf(menuId), 1);
    const idx = (state.memosByArea[menuId] || []).indexOf(memoId);
    if (idx > -1) state.memosByArea[menuId].splice(idx, 1);
  }
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  broadcastState();
  sendTo(port, 'TOAST', {
    messageKey: shouldAdd ? 'system.menuLabelAdded' : 'system.menuLabelRemoved',
    params: { menuId },
  });
}

async function handleRecordAreaTime(port, payload) {
  recordClientAreaTime(port, payload.areaId);
  // 시간 기록은 브로드캐스트 없이 로컬 업데이트만 (성능)
}

/**
 * 탭 포커스/비포커스 상태 변경 핸들러
 * isActive=false 탭은 시간 누적을 중단하여 여러 탭 열림 시 중복 집계를 방지합니다.
 */
async function handleTabActive(port, payload) {
  const { isActive } = payload || {};
  const ctx = getClientContext(port);
  if (isActive) {
    // 포커스 복귀: lastMenuChangeTime 갱신 (백그라운드 체류 시간 제외)
    ctx.isActive = true;
    ctx.lastMenuChangeTime = Date.now();
  } else {
    // 포커스 상실: 지금까지 누적 시간을 flush하고 비활성 전환
    recordClientAreaTime(port, ctx.selectedArea);
    ctx.isActive = false;
  }
}

async function handleImportData(port, payload) {
  await db.clearAll();
  await db.importData(payload.importedData);
  await loadStateFromDB();
  await refreshStorageUsed();
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.importSuccess' });
}

async function handleExportData(port) {
  const data = await db.exportAllData();
  sendTo(port, 'EXPORT_DATA_RESULT', { data });
}

async function handleClearOldData(port, payload) {
  const settings = payload?.settings;
  if (settings) {
    state.settings = { ...state.settings, ...settings };
    await db.saveSetting('app_settings', state.settings);
  }
  await runAutoCleanup({ silent: true });
  await refreshStorageUsed();
  broadcastState();
}

async function handleBeforeUnload(port) {
  const ctx = clientContextMap.get(port);
  if (ctx) {
    // 현재 선택 영역의 잔여 시간 기록
    recordClientAreaTime(port, ctx.selectedArea);
    // DB에 저장된 누적 stats + 이 탭의 현재 세션 stats를 병합하여 저장
    try {
      const savedStats   = (await db.getSetting('menu_time_stats')) || {};
      const mergedStats  = mergeStats(savedStats, ctx.menuTimeStats);
      await db.saveSetting('menu_time_stats', mergedStats);
      // 전역 state도 업데이트 (다른 탭의 getSnapshot 기준값 갱신)
      state.menuTimeStats = mergedStats;

      const savedBuckets  = (await db.getSetting('time_buckets')) || { daily: {}, weekly: {}, monthly: {} };
      const mergedBuckets = mergeTimeBuckets(savedBuckets, ctx.timeBuckets);
      await db.saveSetting('time_buckets', mergedBuckets);
      state.timeBuckets = mergedBuckets;

      // 저장 완료 후 이 탭의 세션 stats 리셋 (중복 저장 방지)
      ctx.menuTimeStats = {};
      ctx.timeBuckets   = { daily: {}, weekly: {}, monthly: {} };
      ctx.lastMenuChangeTime = Date.now();
    } catch (error) {
      console.error('[Worker] 탭 종료 시 시간 통계 저장 실패:', error);
    }
  } else {
    // ctx가 없는 경우 기존 방식으로 폴백
    await saveMenuTimeStats();
  }
  if (state.settings) await db.saveSetting('app_settings', state.settings);
  await db.saveSetting('sticky_notes', state.stickyNotes || []);
}

async function handleRefreshClipboard(port) {
  const items = await db.getClipboardItems(1000);
  state.clipboard = Array.isArray(items) ? items : [];
  broadcastState();
}

async function handleSaveUIPrefs(port, payload) {
  const { isMemoPanelExpanded, memoFilter, panelHeight, panelWidth, panelWidthCollapsed, panelWidthExpanded } = payload;
  if (typeof isMemoPanelExpanded === 'boolean') {
    state.isMemoPanelExpanded = isMemoPanelExpanded;
    await db.saveSetting('isMemoPanelExpanded', isMemoPanelExpanded);
  }
  if (['menu', 'area', 'all'].includes(memoFilter)) {
    state.memoFilter = memoFilter;
    await db.saveSetting('memoFilter', memoFilter);
  }
  if (panelHeight === null || typeof panelHeight === 'number') {
    state.panelHeight = panelHeight;
    await db.saveSetting('panelHeight', panelHeight);
  }
  if (panelWidth === null || typeof panelWidth === 'number') {
    state.panelWidth = panelWidth;
    await db.saveSetting('panelWidth', panelWidth);
  }
  if (panelWidthCollapsed === null || typeof panelWidthCollapsed === 'number') {
    state.panelWidthCollapsed = panelWidthCollapsed;
    await db.saveSetting('panelWidthCollapsed', panelWidthCollapsed);
  }
  if (panelWidthExpanded === null || typeof panelWidthExpanded === 'number') {
    state.panelWidthExpanded = panelWidthExpanded;
    await db.saveSetting('panelWidthExpanded', panelWidthExpanded);
  }
  broadcastState();
}

// ========================================
// 메시지 라우터 (Message Router)
// ========================================
async function handleSaveUserInfo(port, payload) {
  const { userInfo } = payload || {};
  if (!userInfo || typeof userInfo !== 'object') return;
  state.userInfo = userInfo;
  await db.saveUserInfo(userInfo);
  // userInfo는 STATE_UPDATE에 포함되어 브로드캐스트됨
  broadcastState();
}

async function handleMarkGuideSeen(port) {
  state.hasSeenGuide = true;
  await db.saveSetting('hasSeenGuide', true);
  // broadcastState 없이 해당 포트에만 응답 (가이드 종료는 다른 탭에 영향 미침)
  sendTo(port, 'STATE_UPDATE', getSnapshot(port));
}

async function handleClearMemoAndClipboard(port) {
  try {
    await db.transaction('memos', 'readwrite', store => store.clear());
    await db.transaction('clipboard', 'readwrite', store => store.clear());
    await db.saveSetting('sticky_notes', []);
    state.memos = {};
    state.memosByArea = {};
    state.clipboard = [];
    state.stickyNotes = [];
    broadcastState();
    sendTo(port, 'TOAST', { messageKey: 'system.dataResetDone' });
  } catch (error) {
    console.error('[Worker] 데이터 초기화 실패:', error);
    sendTo(port, 'TOAST', { messageKey: 'system.initError' });
  }
}

// 미확인 리마인더 읽음 처리: 상태를 false로 변경하고 모든 탭에 브로드캐스트
async function handleMarkReminderRead(port, payload) {
  // hasUnreadReminder 플래그만 리셋 — notifications DB는 연동하지 않음
  // (알림 이력 읽음은 대시보드에서 명시적으로 확인 시에만 변경)
  state.hasUnreadReminder = false;
  broadcastState();
}

// 알림 이력 기록 (클라이언트가 리마인더 발동 시 전송)
async function handleRecordNotification(port, payload) {
  const { memoId, title, firedAt } = payload;
  const notif = { memoId, title: title || '', firedAt: firedAt || Date.now(), isRead: false };
  // DB 영속화 먼저 — 새로고침 시 데이터 손실 방지
  try {
    const newId = await db.addNotification(notif);
    notif.id = newId;
  } catch (e) {
    console.warn('[Worker] 알림 이력 저장 실패 (인메모리에만 반영됨):', e);
  }
  // DB 성공/실패 무관하게 항상 인메모리 반영 + 브로드캐스트 (뱃지·카운트 즉시 갱신)
  state.notifications.unshift(notif);
  state.hasUnreadReminder = true;
  broadcastState();
}

// 개별 알림 읽음 처리
async function handleMarkNotificationRead(port, payload) {
  const { notifId } = payload;
  const notif = state.notifications.find(n => n.id === notifId);
  if (!notif) return;
  notif.isRead = true;
  try { await db.markNotificationRead(notifId); } catch (e) { console.warn('[Worker] 알림 읽음 오류:', e); }
  // 남은 미확인 알림이 없으면 븰지도 해제
  if (!state.notifications.some(n => !n.isRead)) state.hasUnreadReminder = false;
  broadcastState();
}

// 전체 알림 일괄 읽음 처리
async function handleMarkAllNotificationsRead(port) {
  state.notifications.forEach(n => { n.isRead = true; });
  state.hasUnreadReminder = false;
  try { await db.markAllNotificationsRead(); } catch (e) { console.warn('[Worker] 전체 알림 읽음 오류:', e); }
  broadcastState();
}

// 메모 복사 (현재 컨텍스트로)
async function handleCopyMemo(port, payload) {
  const { memoId, targetMenuId, targetAreaId } = payload;
  const source = state.memos[memoId];
  if (!source) return;
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const newId = `mdi-${now}-${++memoIdSequence}`;
  const newMemo = {
    ...source,
    id: newId,
    menuId: targetMenuId,
    createdAreaId: targetAreaId,
    labels: [targetMenuId],
    reminder: null,
    reminderRepeat: false,
    done: false,
    pinned: false,
    date: today,
    createdAt: now,
    updatedAt: now,
  };
  state.memos[newId] = newMemo;
  ensureMenuIndex(targetMenuId);
  state.memosByArea[targetMenuId].unshift(newId);
  await db.addMemo(newId, newMemo);
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.memoCopied' });
}

// 복사 + 포스트잇 동시 실행 (다른 화면의 메모를 현재 화면에 드래그할 때)
async function handleCopyMemoAndSticky(port, payload) {
  const { memoId, targetMenuId, targetAreaId, placement } = payload;
  const source = state.memos[memoId];
  if (!source) return;
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const newId = `mdi-${now}-${++memoIdSequence}`;
  const newMemo = {
    ...source,
    id: newId,
    menuId: targetMenuId,
    createdAreaId: targetAreaId,
    labels: [targetMenuId],
    reminder: null,
    reminderRepeat: false,
    done: false,
    pinned: false,
    date: today,
    createdAt: now,
    updatedAt: now,
  };
  state.memos[newId] = newMemo;
  ensureMenuIndex(targetMenuId);
  state.memosByArea[targetMenuId].unshift(newId);
  await db.addMemo(newId, newMemo);

  // 복사된 메모에 대한 포스트잋 생성
  const finalPlacement = placement || { x: 40, y: 40, width: 220, height: 150 };
  const note = { memoId: newId, menuId: targetMenuId, ...finalPlacement };
  if (!state.stickyNotes) state.stickyNotes = [];
  state.stickyNotes.push(note);
  await db.saveSetting('sticky_notes', state.stickyNotes);

  await refreshStorageUsed();
  broadcastState();
  sendTo(port, 'TOAST', { messageKey: 'system.memoCopied' });
}

const HANDLERS = {
  INIT:              handleInit,
  CONTEXT_CHANGE:    handleContextChange,
  ADD_MEMO:          handleAddMemo,
  DELETE_MEMO:       handleDeleteMemo,
  TOGGLE_PIN:        handleTogglePin,
  SAVE_MEMO_TITLE:   handleSaveMemoTitle,
  SAVE_INLINE_EDIT:  handleSaveInlineEdit,
  SET_REMINDER:      handleSetReminder,
  ADD_CLIPBOARD:     handleAddClipboard,
  DELETE_CLIPBOARD:  handleDeleteClipboard,
  ADD_TEMPLATE:          handleAddTemplate,
  EDIT_TEMPLATE:         handleEditTemplate,
  DELETE_TEMPLATE:       handleDeleteTemplate,
  TOGGLE_TEMPLATE_PIN:   handleToggleTemplatePin,
  USE_TEMPLATE:      handleUseTemplate,
  SET_THEME:         handleSetTheme,
  SET_DARK_MODE:     handleSetDarkMode,
  SAVE_SETTINGS:     handleSaveSettings,
  SAVE_AREA_COLORS:  handleSaveAreaColors,
  TOGGLE_TODO:       handleToggleTodo,
  SAVE_STICKY_NOTES: handleSaveStickyNotes,
  ADD_STICKY_NOTE:   handleAddStickyNote,
  REMOVE_STICKY_NOTE:handleRemoveStickyNote,
  TOGGLE_LABEL:      handleToggleLabel,
  RECORD_AREA_TIME:  handleRecordAreaTime,
  TAB_ACTIVE:        handleTabActive,
  IMPORT_DATA:       handleImportData,
  EXPORT_DATA:       handleExportData,
  CLEAR_OLD_DATA:    handleClearOldData,
  CLEAR_MEMO_AND_CLIPBOARD: handleClearMemoAndClipboard,
  BEFORE_UNLOAD:     handleBeforeUnload,
  REFRESH_CLIPBOARD: handleRefreshClipboard,
  SAVE_UI_PREFS:     handleSaveUIPrefs,
  SAVE_USER_INFO:    handleSaveUserInfo,
  MARK_GUIDE_SEEN:   handleMarkGuideSeen,
  MARK_REMINDER_READ: handleMarkReminderRead,
  RECORD_NOTIFICATION:         handleRecordNotification,
  MARK_NOTIFICATION_READ:      handleMarkNotificationRead,
  MARK_ALL_NOTIFICATIONS_READ: handleMarkAllNotificationsRead,
  COPY_MEMO:                   handleCopyMemo,
  COPY_MEMO_AND_STICKY:        handleCopyMemoAndSticky,
};

async function dispatchMessage(port, event) {
  const { type, payload } = event.data || {};
  const handler = HANDLERS[type];
  if (!handler) {
    workerConsole.warn('[Worker] 알 수 없는 메시지 타입:', type);
    return;
  }
  try {
    workerConsole.log(`📩 수신됨: ${type}`);
    await handler(port, payload);
  } catch (error) {
    workerConsole.error(`[Worker] 핸들러 오류 (${type}):`, error.message, error.stack);
    sendTo(port, 'TOAST', { messageKey: 'system.errorOccurred' });
  }
}

// ========================================
// onconnect - 클라이언트 연결 처리
// ========================================
self.onconnect = function (connectEvent) {
  const port = connectEvent.ports[0];
  ports.add(port);

  port.addEventListener('message', (event) => dispatchMessage(port, event));
  port.addEventListener('messageerror', () => {
    console.warn('[Worker] port messageerror');
    ports.delete(port);
    clientContextMap.delete(port); // 탭별 컨텍스트 정리
  });

  port.start();

  // 이미 초기화된 경우 클라이언트 컨텍스트 초기화 후 즉시 전송
  if (_initialized) {
    initClientContext(port);
    sendTo(port, 'STATE_UPDATE', getSnapshot(port));
  }
};
