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
  constructor(dbName = 'AssistantDB', dbVersion = 5) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.db = null;
    this.stores = ['memos', 'clipboard', 'templates', 'settings', 'metadata', 'userinfo'];
  }

  async init() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
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
    const filteredSettings = settings.filter(s => !['menu_time_stats', 'time_buckets'].includes(s.key));
    return { version: '1.0', exportDate: new Date().toISOString(), data: { memos, templates, settings: filteredSettings } };
  }

  async importData(importedData) {
    if (!importedData.data) throw new Error('잘못된 데이터 형식');
    const { memos = [], templates = [], settings = [] } = importedData.data;
    const normalizedMemos = Array.isArray(memos) ? memos : Object.values(memos || {});
    const normalizedTemplates = Array.isArray(templates) ? templates : Object.values(templates || {});
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
    for (const setting of normalizedSettings) {
      if (!setting || !setting.key) continue;
      if (['menu_time_stats', 'time_buckets'].includes(setting.key)) continue;
      await this.saveSetting(setting.key, setting.value);
    }
    return { success: true, imported: normalizedMemos.length + normalizedTemplates.length };
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
}

// ========================================
// Tier 2: 중앙 상태 (Central State)
// ========================================
let db = null;
let _initialized = false;
let memoIdSequence = 0;

const state = {
  currentTheme: 'earthBrown',
  isDarkMode: false,
  selectedArea: 'UW',
  selectedMenu: '',  // 클라이언트 CONTEXT_CHANGE 수신 전까지 빈 값 유지
  memoFilter: 'menu',
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
    autoCleanup: { clipboard: 7, oldMemos: 90 },
    lowSpecMode: false,
    debugLogs: true,
    backupReminder: true,
    lastBackup: '2026-01-03',
    enableClipboardCapture: true,
    markdownEnabled: true,
    autoNavigateToDashboard: true,
    browserNotificationEnabled: true,
    toastEnabled: true,
    showTimeTab: true,
    showAreaColorSection: true,
  },
  nextMemoId: 10,
  nextTemplateId: 10,
  nextClipboardId: 10,
};

// ========================================
// Tier 1: 클라이언트 포트 관리
// ========================================
const ports = new Set();

/** 모든 연결된 클라이언트에게 메시지 브로드캐스트 */
function broadcast(type, payload) {
  ports.forEach(port => {
    try { port.postMessage({ type, payload }); }
    catch (e) { ports.delete(port); }
  });
}

/** 특정 포트에만 메시지 전송 */
function sendTo(port, type, payload) {
  try { port.postMessage({ type, payload }); }
  catch (e) { ports.delete(port); }
}

/**
 * 전송 가능한 상태 스냅샷 반환 (postMessage에 필요한 직렬화 가능 객체)
 * UI-only 상태 (activeTab, currentModal 등)는 클라이언트가 로컬로 관리합니다.
 */
function getSnapshot() {
  return {
    currentTheme: state.currentTheme,
    isDarkMode: state.isDarkMode,
    selectedArea: state.selectedArea,
    selectedMenu: state.selectedMenu,
    memoFilter: state.memoFilter,
    isMemoPanelExpanded: state.isMemoPanelExpanded,
    lastMenuChangeTime: state.lastMenuChangeTime,
    menuTimeStats: state.menuTimeStats,
    timeBuckets: state.timeBuckets,
    memos: state.memos,
    memosByArea: state.memosByArea,
    clipboard: state.clipboard,
    templates: state.templates,
    stickyNotes: state.stickyNotes,
    areaColors: state.areaColors,
    settings: state.settings,
    nextTemplateId: state.nextTemplateId,
    userInfo: state.userInfo,
  };
}

/** 상태 변경 후 모든 클라이언트에게 브로드캐스트 */
function broadcastState() {
  broadcast('STATE_UPDATE', getSnapshot());
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

// ========================================
// DB 초기화 및 상태 로드
// ========================================
async function ensureInit(loginId) {
  if (_initialized) return;
  const dbName = loginId ? `AssistantDB_${loginId}` : 'AssistantDB_public';
  db = new AssistantDB(dbName, 5);
  await loadStateFromDB();
  _initialized = true;
}

async function loadStateFromDB() {
  await db.init();

  const allMemos = await db.getAllMemos();
  state.memos = {};
  state.memosByArea = {};

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
      ...state.settings,
      ...settings,
      autoCleanup: { ...state.settings.autoCleanup, ...(settings.autoCleanup || {}) },
      markdownEnabled: settings.markdownEnabled !== undefined ? settings.markdownEnabled : true,
      browserNotificationEnabled: settings.browserNotificationEnabled !== undefined ? settings.browserNotificationEnabled : true,
      debugLogs: settings.debugLogs !== undefined ? settings.debugLogs : true,
      toastEnabled: settings.toastEnabled !== undefined ? settings.toastEnabled : true,
      showTimeTab: settings.showTimeTab !== undefined ? settings.showTimeTab : true,
      showAreaColorSection: settings.showAreaColorSection !== undefined ? settings.showAreaColorSection : true,
    };
  }

  const stickyNotes = await db.getSetting('sticky_notes');
  if (Array.isArray(stickyNotes)) state.stickyNotes = stickyNotes;

  const areaColors = await db.getSetting('area_colors');
  if (areaColors && typeof areaColors === 'object') state.areaColors = areaColors;

  // userInfo 로드 (암호화된 채로 state에 보관, 복호화는 클라이언트에서)
  try {
    const savedUserInfo = await db.getUserInfo();
    if (savedUserInfo) state.userInfo = savedUserInfo;
  } catch (e) {
    console.warn('[Worker] userInfo 로드 실패:', e);
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
  await ensureInit(payload?.loginId);
  sendTo(port, 'STATE_UPDATE', getSnapshot());
}

async function handleContextChange(port, payload) {
  const { areaId, menuId } = payload || {};
  recordAreaTime(state.selectedArea);
  if (areaId) state.selectedArea = areaId;
  if (menuId !== undefined) state.selectedMenu = menuId;
  broadcastState();
}

async function handleAddMemo(port, payload) {
  const { memoId, memoData } = payload;
  await db.addMemo(memoId, memoData);
  state.memos[memoId] = memoData;
  ensureMenuIndex(memoData.menuId);
  if (!state.memosByArea[memoData.menuId].includes(memoId)) {
    state.memosByArea[memoData.menuId].unshift(memoId);
  }
  broadcastState();
  sendTo(port, 'TOAST', { message: '메모가 추가되었습니다' });
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
  sendTo(port, 'TOAST', { message: '✓ 메모가 삭제되었습니다' });
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
  sendTo(port, 'TOAST', { message: `메모가 ${memo.pinned ? '📌 고정됨' : '📌 고정 해제됨'}` });
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
  memo.content = content;
  memo.isRichText = isRichText;
  memo.updatedAt = Date.now();
  await db.updateMemo(memo, memoId);
  broadcastState();
  sendTo(port, 'TOAST', { message: '메모가 수정되었습니다' });
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
  const msg = reminderStr
    ? `✓ ${reminderStr} 알림이 설정되었습니다`
    : '⏰ 알림이 삭제되었습니다';
  sendTo(port, 'TOAST', { message: msg });
}

async function handleAddClipboard(port, payload) {
  const { content, options = {} } = payload;
  if (!content || typeof content !== 'string') return;
  const trimmed = content.trim();
  if (!trimmed.length) return;

  if (!Array.isArray(state.clipboard)) state.clipboard = [];
  const existing = state.clipboard.findIndex(item => item.content === trimmed);

  if (existing > -1) {
    // 기존 항목 업데이트 (카운트 증가, 최상단 이동)
    const item = state.clipboard[existing];
    item.count = (item.count || 1) + 1;
    item.timestamp = Date.now();
    state.clipboard.splice(existing, 1);
    state.clipboard.unshift(item);
    await db.updateClipboardItem(item);
    broadcastState();
    sendTo(port, 'TOAST', { message: `클립보드 최상단으로 이동됨 (사용 ${item.count}회)` });
  } else {
    // 신규 항목 추가
    const newItem = {
      content: trimmed,
      menu: state.selectedMenu,
      areaId: state.selectedArea,
      timestamp: Date.now(),
      count: 1,
    };
    state.clipboard.unshift(newItem);
    const id = await db.addClipboardItem(newItem);
    if (id) newItem.id = id;
    broadcastState();
    sendTo(port, 'TOAST', { message: '어시스턴트 클립보드에 저장됨' });
  }
}

async function handleDeleteClipboard(port, payload) {
  const { itemId } = payload;
  await db.deleteClipboardItem(itemId);
  const idx = (state.clipboard || []).findIndex(c => c.id === itemId);
  if (idx > -1) state.clipboard.splice(idx, 1);
  broadcastState();
  sendTo(port, 'TOAST', { message: '항목이 삭제되었습니다' });
}

async function handleAddTemplate(port, payload) {
  const { template } = payload;
  const id = await db.addTemplate(template);
  const newTemplate = { ...template, id };
  state.templates.unshift(newTemplate);
  broadcastState();
  sendTo(port, 'TOAST', { message: '템플릿이 추가되었습니다' });
}

async function handleEditTemplate(port, payload) {
  const { templateId, title, content } = payload;
  const template = state.templates.find(t => t.id === templateId);
  if (!template) return;
  template.title = title;
  template.content = content;
  await db.updateTemplate(template);
  broadcastState();
  sendTo(port, 'TOAST', { message: '템플릿이 수정되었습니다' });
}

async function handleDeleteTemplate(port, payload) {
  const { templateId } = payload;
  await db.deleteTemplate(templateId);
  const idx = state.templates.findIndex(t => t.id === templateId);
  if (idx > -1) state.templates.splice(idx, 1);
  broadcastState();
  sendTo(port, 'TOAST', { message: '템플릿이 삭제되었습니다' });
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
  broadcastState();
}

async function handleSetDarkMode(port, payload) {
  state.isDarkMode = payload.isDark;
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
  sendTo(port, 'TOAST', { message: memo?.done ? '완료 처리되었습니다' : '미완료 처리되었습니다' });
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
  const msg = shouldAdd ? `✓ "${menuId}" 메뉴에 추가되었습니다` : `− "${menuId}" 메뉴에서 제거되었습니다`;
  sendTo(port, 'TOAST', { message: msg });
}

async function handleRecordAreaTime(port, payload) {
  recordAreaTime(payload.areaId);
  // 시간 기록은 브로드캐스트 없이 로컬 업데이트만 (성능)
}

async function handleImportData(port, payload) {
  await db.clearAll();
  await db.importData(payload.importedData);
  await loadStateFromDB();
  broadcastState();
  sendTo(port, 'TOAST', { message: '데이터 가져오기가 완료되었습니다' });
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
  await runAutoCleanup({ silent: false });
  broadcastState();
  sendTo(port, 'TOAST', { message: '데이터 정리가 완료되었습니다' });
}

async function handleBeforeUnload(port) {
  await saveMenuTimeStats();
  if (state.settings) await db.saveSetting('app_settings', state.settings);
  await db.saveSetting('sticky_notes', state.stickyNotes || []);
}

async function handleRefreshClipboard(port) {
  const items = await db.getClipboardItems(1000);
  state.clipboard = Array.isArray(items) ? items : [];
  broadcastState();
}

async function handleSaveUIPrefs(port, payload) {
  const { isMemoPanelExpanded, memoFilter } = payload;
  if (typeof isMemoPanelExpanded === 'boolean') {
    state.isMemoPanelExpanded = isMemoPanelExpanded;
    await db.saveSetting('isMemoPanelExpanded', isMemoPanelExpanded);
  }
  if (['menu', 'area', 'all'].includes(memoFilter)) {
    state.memoFilter = memoFilter;
    await db.saveSetting('memoFilter', memoFilter);
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
  ADD_TEMPLATE:      handleAddTemplate,
  EDIT_TEMPLATE:     handleEditTemplate,
  DELETE_TEMPLATE:   handleDeleteTemplate,
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
  IMPORT_DATA:       handleImportData,
  EXPORT_DATA:       handleExportData,
  CLEAR_OLD_DATA:    handleClearOldData,
  BEFORE_UNLOAD:     handleBeforeUnload,
  REFRESH_CLIPBOARD: handleRefreshClipboard,
  SAVE_UI_PREFS:     handleSaveUIPrefs,
  SAVE_USER_INFO:    handleSaveUserInfo,
};

async function dispatchMessage(port, event) {
  const { type, payload } = event.data || {};
  const handler = HANDLERS[type];
  if (!handler) {
    console.warn('[Worker] 알 수 없는 메시지 타입:', type);
    return;
  }
  try {
    await handler(port, payload);
  } catch (error) {
    console.error(`[Worker] 핸들러 오류 (${type}):`, error);
    sendTo(port, 'TOAST', { message: `오류가 발생했습니다` });
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
  });

  port.start();

  // 이미 초기화된 경우 현재 상태를 즉시 전송
  if (_initialized) {
    sendTo(port, 'STATE_UPDATE', getSnapshot());
  }
};
