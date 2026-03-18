if (typeof Quill !== "undefined") {
  console.log("✅ Quill 라이브러리 로드 성공!");
} else {
  alert("❌ Quill 라이브러리를 찾을 수 없습니다. 경로를 확인해주세요.");
}

// ========================================
// Shared Worker 연결 (Tier 2 중계 서버)
// ========================================
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
function workerSend(type, payload) {
  if (!workerPort) {
    console.warn(
      "[Assistant] Worker가 연결되지 않았습니다. 메시지 무시:",
      type,
    );
    return;
  }
  workerPort.postMessage({ type, payload });
}

/**
 * Worker로부터 STATE_UPDATE 메시지를 수신하여
 * 로컬 state를 갱신하고 UI를 리렌더링합니다.
 * @param {Object} newState - Worker가 전달한 최신 상태 스냅샷
 */
let _guideTriggered = false;

function handleStateUpdate(newState) {
  // 드래그/리사이즈 중에는 로컬 stickyNotes 변경사항을 worker 스냅샷으로 덮어쓰지 않습니다.
  if (state.stickyDragActive || state.stickyResizeActive) {
    const saved = state.stickyNotes;
    Object.assign(state, newState);
    state.stickyNotes = saved;
  } else {
    Object.assign(state, newState);
  }
  rebuildAssistantTabs();
  renderAssistant();
  // 드래그 중에는 sticky notes를 다시 그리지 않습니다 — 드래그 mouseup 후 saveStickyNotes() → 새 STATE_UPDATE에서 처리됩니다.
  if (!state.stickyDragActive) {
    renderStickyNotes();
  }

  // 온보딩 가이드: DB 로드 후 최초 1회만 표시
  if (!_guideTriggered && state.hasSeenGuide === false) {
    _guideTriggered = true;
    setTimeout(() => {
      if (typeof AssistantGuide !== 'undefined') AssistantGuide.start();
    }, 800);
  }
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
    link.download = `assistant-backup-${new Date().toISOString().split("T")[0]}.json`;
    getAssistantRoot().appendChild(link);
    link.click();
    getAssistantRoot().removeChild(link);
    URL.revokeObjectURL(url);

    // 백업 일자 자동 갱신
    const today = new Date().toISOString().split("T")[0];
    state.settings.lastBackup = today;
    saveSettings({ silent: true });

    showToast("데이터가 내보내졌습니다");
  } catch (error) {
    console.error("내보내기 실패:", error);
    showToast("데이터 내보내기에 실패했습니다");
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
    console.warn("[Assistant] 필드 복호화 실패 (키 불일치 또는 손상)");
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
    console.warn("[Assistant] UserInfo 소스 실행 실패:", e);
    raw = null;
  }

  if (!raw || !Object.keys(raw).length) {
    console.warn("[Assistant] UserInfo 없음 — 저장 건너뜀");
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
    console.log(
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
async function decryptUserInfo(loginId) {
  const encrypted = state.userInfo;
  if (
    !encrypted ||
    !Array.isArray(encrypted._encrypted) ||
    !encrypted._encrypted.length
  ) {
    return encrypted || null;
  }
  try {
    const key = await deriveUserCryptoKey(loginId);
    const result = { ...encrypted };
    for (const field of encrypted._encrypted) {
      result[field] = await decryptUserField(encrypted[field], key);
    }
    delete result._encrypted;
    delete result._savedAt;
    return result;
  } catch (e) {
    console.error("[Assistant] UserInfo 복호화 실패:", e);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
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
        console.log(
          "Persistent Storage 상태:",
          persisted ? "활성화" : "비활성화",
        );
      } catch (error) {
        console.warn("Persistent Storage 요청 실패:", error);
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
        console.log("IndexedDB 초기화 완료:", this.dbName);
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log("IndexedDB 스토어 생성 중...");

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
            console.log(`[transaction] ${storeName} IDBRequest 성공`);
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
            console.log(`[transaction] ${storeName} 트랜잭션 완료 (${mode})`);
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
    console.log("[db.addMemo] 메모 추가:", memoId);
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
      console.log("[db.deleteMemo] 메모 삭제 시도:", memoId);

      const tx = this.db.transaction("memos", "readwrite");
      const store = tx.objectStore("memos");
      const request = store.delete(memoId);

      request.onsuccess = () => {
        console.log("[db.deleteMemo] 메모 삭제 성공:", memoId);
      };

      request.onerror = () => {
        console.error("[db.deleteMemo] 메모 삭제 요청 실패:", request.error);
        reject(request.error);
      };

      tx.oncomplete = () => {
        console.log("[db.deleteMemo] 트랜잭션 완료:", memoId);
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
        console.log("[db.getAllMemos] 메모 로드 완료:", memos.length, "개");
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
    console.log(item);
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
      },
    };
  }

  // 데이터 가져오기
  async importData(importedData) {
    if (!importedData.data) throw new Error("잘못된 데이터 형식");

    const { memos = [], templates = [], settings = [] } = importedData.data;

    const normalizedMemos = Array.isArray(memos)
      ? memos
      : Object.values(memos || {});
    const normalizedTemplates = Array.isArray(templates)
      ? templates
      : Object.values(templates || {});

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

    // 설정 가져오기
    for (const setting of normalizedSettings) {
      if (!setting || !setting.key) continue;
      if (["menu_time_stats", "time_buckets"].includes(setting.key)) continue;
      await this.saveSetting(setting.key, setting.value);
    }

    return {
      success: true,
      imported: normalizedMemos.length + normalizedTemplates.length,
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

// ========================================
// 데이터 정의
// ========================================
const themes = {
  classic: {
    name: "클래식",
    primary: "#4A90A4",
    primaryLight: "#E8F4F8",
    primaryDark: "#2E5A6A",
  },
  earthbrown: {
    name: "어스 브라운",
    primary: "#C9BEAA",
    primaryLight: "#D6CEC0",
    primaryDark: "#9A9387",
  },
  oceangreen: {
    name: "오션 그린",
    primary: "#7CE0D3",
    primaryLight: "#A9E9E1",
    primaryDark: "#44A79E",
  },
  lightbeige: {
    name: "라이트 베이지",
    primary: "#FBF1E6",
    primaryLight: "#FAF3EB",
    primaryDark: "#D6CEC5",
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

// ========================================
// DOM 유틸리티
// ========================================
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
/**
 * 각 탭의 id, icon, label, render 함수를 선언적으로 정의합니다.
 * 새로운 탭을 추가할 때는 이 객체에 항목을 추가하고
 * 해당 render 함수만 작성하면 됩니다.
 */
const ASSISTANT_TABS = {
  memo: {
    id: "memo",
    icon: "📝",
    label: "메모",
    render: () => renderMemoTab(),
  },
  dashboard: {
    id: "dashboard",
    icon: "📊",
    label: "대시보드",
    render: () => renderDashboardTab(),
  },
  settings: {
    id: "settings",
    icon: "⚙️",
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

// ========================================
// 메뉴 라벨 인덱스 유틸
// ========================================
function ensureMenuIndex(menuId) {
  if (!menuId) return;
  if (!state.memosByArea[menuId]) {
    state.memosByArea[menuId] = [];
  }
}

// ========================================
// 상태 관리
// ========================================
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
    // 저사양 모드
    lowSpecMode: false,
    // 디버그 로그
    debugLogs: false,
    // 백업 알림 설정
    backupReminder: false,
    // 최종 백업 날짜
    lastBackup: "2026-01-03",

    enableClipboardCapture: false,
    // 마크다운 단축키 활성화
    markdownEnabled: false,
    // 알림 설정 후 대시보드 자동 이동
    autoNavigateToDashboard: false,
    // 브라우저 알림 on/off
    browserNotificationEnabled: false,
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

  // 개발자 도구로 개별 온오프할 수 있는 설정 UI 노출 여부 (기본값 false: 숨김)
  hiddenUI: {
    areaColor: false,
    timeInsight: false,
    markdown: false,
    debugLog: false,
    autoNav: false,
    lowSpec: false,
  },
};

// Quill 에디터 인스턴스
let memoQuill = null;

//타겟 컨테이너 설정
const ASSISTANT_DOM_TARGET = window.ASSISTANT_DOM_TARGET || {
  rootId: "mf_VFrames_Root",
  fallbackIds: ["assistant-root"],
  useBodyFallback: true,
};

window.ASSISTANT_DOM_TARGET = ASSISTANT_DOM_TARGET;

//디버그 온오프설정
const CONSOLE_ORIGINAL = {
  log: console.log ? console.log.bind(console) : () => {},
  info: console.info ? console.info.bind(console) : () => {},
  debug: console.debug ? console.debug.bind(console) : () => {},
  warn: console.warn ? console.warn.bind(console) : () => {},
  error: console.error ? console.error.bind(console) : () => {},
};

function setConsoleLoggingEnabled(enabled) {
  if (enabled) {
    console.log = CONSOLE_ORIGINAL.log;
    console.info = CONSOLE_ORIGINAL.info;
    console.debug = CONSOLE_ORIGINAL.debug;
    console.warn = CONSOLE_ORIGINAL.warn;
    console.error = CONSOLE_ORIGINAL.error;
    return;
  }

  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = CONSOLE_ORIGINAL.error;
}

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
  return themes[state.currentTheme] || themes.classic;
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
  const theme = getTheme();
  const isDark = state.isDarkMode;
  return {
    bg: isDark ? "#2B2F35" : "#FFFFFF",
    subBg: isDark ? "#191F28" : "#F8F9FA",
    text: isDark ? "#E0E0E0" : "#191F28",
    subText: isDark ? "#A0A0A0" : "#666666",
    border: isDark ? "#404040" : "#E0E0E0",
    headerText: state.currentTheme === "lightBeige" ? "#191F28" : "#FFF",
    headerSubText:
      state.currentTheme === "lightBeige" ? "#666" : "rgba(255,255,255,0.8)",
  };
}

function applyLowSpecMode() {
  const root =
    document.getElementById("assistant-root") || getAssistantStyleRoot();
  if (!root) return;
  root.classList.toggle("imsmassi-low-spec", !!state.settings?.lowSpecMode);
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

// 메모에 라벨(menuId) 추가 (Worker 경유)
function addLabelToMemo(memoId, menuId) {
  workerSend("TOGGLE_LABEL", { memoId, menuId, force: true });
}

// 메모에서 라벨(menuId) 제거 (Worker 경유)
function removeLabelFromMemo(memoId, menuId) {
  workerSend("TOGGLE_LABEL", { memoId, menuId, force: false });
}

// ========================================
// Quill 메모 에디터 유틸리티
// ========================================
function isQuillAvailable() {
  return typeof Quill !== "undefined";
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
      menus: ["column", "row", "merge", "table", "cell", "wrap", "delete"],
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

  memoQuill = new Quill(editor, {
    theme: "bubble",
    modules: modules,
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
      showToast("⚠️ 메모 용량 초과 (최대 2MB)");
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
    } catch (_) {}
  }

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
        menus: ["column", "row", "merge", "table", "cell", "wrap", "delete"],
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

function startInlineMemoEdit(memoId) {
  state.editingMemoId = memoId;
  renderAssistantContent();
}

function cancelInlineMemoEdit() {
  state.editingMemoId = null;
  renderAssistantContent();
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
    note = { memoId, x: 0, y: 0, width: 220, height: 150 };
    state.stickyNotes.push(note);
  }

  Object.assign(note, patch);
  return note;
}

function getStickyNote(memoId) {
  if (!memoId || !state.stickyNotes) return null;
  return state.stickyNotes.find((note) => note.memoId === memoId) || null;
}

function setStickyNotePosition(memoId, x, y) {
  const nextX = Math.max(0, Number.isFinite(Number(x)) ? Number(x) : 0);
  const nextY = Math.max(0, Number.isFinite(Number(y)) ? Number(y) : 0);
  return upsertStickyNote(memoId, { x: nextX, y: nextY });
}

function setStickyNoteSize(memoId, width, height) {
  const patch = {};
  const nextWidth = Number(width);
  const nextHeight = Number(height);
  // 최소 150, 최대 1200/900 제한
  if (Number.isFinite(nextWidth) && nextWidth > 50)
    patch.width = Math.min(1200, Math.max(150, nextWidth));
  if (Number.isFinite(nextHeight) && nextHeight > 50)
    patch.height = Math.min(900, Math.max(150, nextHeight));

  return upsertStickyNote(memoId, patch);
}

// 2. 포스트잇 생성 위치 계산 로직 개선
function getDefaultStickyPlacement(memoId) {
  const layer = document.getElementById("sticky-layer");
  const panel = document.getElementById("imsmassi-floating-panel");
  const margin = 16;
  const defaultWidth = 220;
  const defaultHeight = 150;

  // sticky-layer 컨테이너 기준 상대좌표 계산
  const layerRect = layer?.getBoundingClientRect() || {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const panelRect = panel?.getBoundingClientRect();

  // 어시스턴트 패널 왼쪽 공간에 배치, 없으면 좌측 상단
  const x = panelRect
    ? Math.max(margin, panelRect.left - layerRect.left - defaultWidth - margin)
    : margin;
  const baseY = panelRect
    ? Math.max(margin, panelRect.top - layerRect.top)
    : margin;

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

  return { x, y, width: defaultWidth, height: defaultHeight };
}

// 3. 포스트잇 추가 로직
function addStickyNote(memoId, x, y) {
  if (!memoId) return;
  const memo = state.memos?.[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  if (!currentMenu) {
    console.warn(
      "[Assistant] addStickyNote: 화면 ID(menuId) 미확인 — 포스트잇 생성 취소",
    );
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
      ? { x, y, width: 220, height: 150 }
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

  const renderWidth = note.width ? Math.max(150, note.width) : 220;
  const renderHeight = note.isCollapsed
    ? 22
    : note.height
      ? Math.max(150, note.height)
      : 150;
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
  console.log(
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
    const collapseIcon = isCollapsed ? "▢" : "—";
    const collapseTitle = isCollapsed ? "펼치기" : "최소화";

    const wrapperEl = document.createElement("div");
    wrapperEl.className = `imsmassi-sticky-note-wrapper${isCollapsed ? " imsmassi-is-collapsed" : ""}`;
    wrapperEl.dataset.memoId = note.memoId;

    // [핵심] 상태에 저장된 크기를 CSS 변수로 주입 (단위 px 확인)
    const renderWidth = note.width ? Math.max(150, note.width) : 220;
    const renderHeight = isCollapsed
      ? 22
      : note.height
        ? Math.max(150, note.height)
        : 150;

    wrapperEl.style.setProperty("--sticky-width", `${renderWidth}px`);
    wrapperEl.style.setProperty("--sticky-height", `${renderHeight}px`);
    wrapperEl.style.left = `${Math.max(0, note.x || 0)}px`;
    wrapperEl.style.top = `${Math.max(0, note.y || 0)}px`;

    // 업무 영역 컬러 CSS 변수 주입 (getAreaWithColors로 커스텀 컬러 병합)
    const noteAreaId =
      memo.createdAreaId || note.menuId?.split("-")?.[0] || state.selectedArea;
    const noteArea = getAreaWithColors(noteAreaId);
    wrapperEl.style.setProperty("--area-primary", noteArea.color);
    wrapperEl.style.setProperty("--area-sub1", noteArea.bgColor);
    wrapperEl.style.setProperty(
      "--area-sub2",
      noteArea.sub2 || noteArea.bgColor,
    );

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
          <button class="imsmassi-sticky-note-btn" onclick="toggleStickyNoteCollapse('${note.memoId}')" title="${collapseTitle}">${collapseIcon}</button>
          <button class="imsmassi-sticky-note-btn" onclick="removeStickyNote('${note.memoId}')" title="닫기">✕</button>
        </div>
      </div>
      ${
        isCollapsed
          ? ""
          : isRichText
            ? `<div class="imsmassi-sticky-note-body imsmassi-sticky-note-richtext" data-memo-id="${note.memoId}" data-content="${encodeURIComponent(sanitizeHtml(memo.content || ""))}"></div>`
            : `<div class="imsmassi-sticky-note-body" contenteditable="true" data-memo-id="${note.memoId}" onfocus="state.isStickyNoteEditing = true; scrollToMemoItem('${note.memoId}')" onblur="saveStickyNoteEdit('${note.memoId}', this)" style="outline: none;">${displayText || "내용 없음"}</div>`
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
    startW = curr.width || 220;
    startH = curr.height || 150;
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
      const nextW = Math.max(150, Math.min(1200, startW + (e.pageX - startX)));
      const nextH = Math.max(150, Math.min(900, startH + (e.pageY - startY)));
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

function initStickyNoteRichText() {
  if (!isQuillAvailable()) return;
  stickyNoteQuillMap = {};
  stickyNoteDirtyMap = {};

  // table-better 등록 (미등록 시)
  const hasBetterTable = typeof window.QuillTableBetter !== "undefined";
  if (hasBetterTable) {
    try {
      Quill.register({ "modules/table-better": window.QuillTableBetter }, true);
    } catch (_) {}
  }

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
        menus: ["column", "row", "merge", "table", "cell", "wrap", "delete"],
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
          saveStickyNoteRichText(memoId);
        } else {
          state.isStickyNoteEditing = false;
        }
      }
    });
  });
}

async function saveStickyNoteRichText(memoId) {
  const memo = state.memos?.[memoId];
  const quill = stickyNoteQuillMap[memoId];
  if (!memo || !quill) return;

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
  const content = (element.innerText || "").trim();
  state.suppressInlineFocus = true;
  workerSend("SAVE_INLINE_EDIT", { memoId, content, isRichText: false });
  state.isStickyNoteEditing = false;
  state.suppressInlineFocus = false;
  renderAssistantContent();
  renderStickyNotes();
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
    // 패널 내 드롭: 기본 위치 배치 (패널과 sticky-layer 좌표계가 다름)
    addStickyNote(memoId);
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
      addStickyNote(memoId, x, y);
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

/** @type {boolean} relocateStickyLayer 실행 중 재진입 방지 플래그 */
let _stickyLayerRelocating = false;

/** @type {Element|null} sticky-layer가 현재 추적 중인 타겟 컨테이너 */
let _stickyLayerTargetEl = null;

/** @type {ResizeObserver|null} 타겟 크기 변화 감지 */
let _stickyLayerResizeObserver = null;

/** @type {AbortController|null} scroll 리스너 정리용 */
let _stickyLayerScrollAC = null;

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
    // 앵커 클래스 변경 시 최신 menuId를 반환하는 함수 (호스트 측에서 주입)
    getMenuId: cfg.getMenuId || null,
    // menuId로부터 areaId를 파생하는 함수 (호스트 측에서 주입)
    // 예: getAreaId: (menuId) => menuId.split('-')[0]
    getAreaId: cfg.getAreaId || null,
  };

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
        console.log(
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
    const anchorEl = document.querySelector(
      `.${_stickyLayerConfig.windowContainerClass}`,
    );
    if (!anchorEl) return false;

    // 앵커의 부모(윈도우 컨테이너)만 감시 — body 전체 감시보다 범위 최소화
    _stickyLayerObserver.observe(anchorEl.parentElement || document.body, {
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
        console.log(
          `[Assistant] 초기 컨텍스트 설정 → menuId: ${initMenuId}, areaId: ${state.selectedArea}`,
        );
      }
    }

    // 초기 배치
    relocateStickyLayer();
    console.log("[Assistant] sticky-layer 옵저버 활성화:", _stickyLayerConfig);
    return true;
  }

  if (!_attachObserver()) {
    // 앵커 미발견 → DOM 추가 감지 옵저버로 대기 (웹스퀘어 init() 이후 동적 생성 대응)
    console.warn(
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
 *   .{windowContainerClass} (앵커)
 *       └── parentElement (윈도우 컨테이너)
 *             └── .{pgIdClass} 중 innerText === state.selectedMenu
 *                   └── parentElement  ← 위치 기준 타겟
 */
function _resolveTargetContainer() {
  const cfg = _stickyLayerConfig;
  const anchorClass = cfg.windowContainerClass;
  const pgIdClass = cfg.pgIdClass || "pg-id";
  const menuId = state.selectedMenu;

  if (!anchorClass || !menuId) return null;

  const anchorEl = document.querySelector(`.${anchorClass}`);
  if (!anchorEl) {
    console.warn(`[Assistant] _resolveTargetContainer: .${anchorClass} 미발견`);
    return null;
  }
  const windowContainer = anchorEl.parentElement;
  if (!windowContainer) return null;

  const pgEls = windowContainer.querySelectorAll(`.${pgIdClass}`);
  const pgEl = Array.from(pgEls).find((el) => el.textContent.trim() === menuId);
  if (!pgEl) {
    console.warn(
      `[Assistant] _resolveTargetContainer: textContent="${menuId}" 인 .${pgIdClass} 미발견`,
    );
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
function relocateStickyLayer() {
  if (_stickyLayerRelocating) return;

  let layer = document.getElementById("sticky-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "sticky-layer";
  }
  // 항상 body 직속 유지
  if (layer.parentElement !== document.body) {
    document.body.appendChild(layer);
  }

  const targetElement = _resolveTargetContainer();

  // 이미 같은 타겟이면 bounds 재동기화 + 노트 재렌더링만
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
  layer.style.visibility = "hidden";
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
    requestAnimationFrame(() => {
      _syncStickyLayerBounds();
      renderStickyNotes();
      requestAnimationFrame(() => {
        layer.style.visibility = "";
      });
    });

    // ④ Scroll 리스너: 스크롤 시 sticky-layer bounds 재동기화
    // capture:true 로 window 하위 모든 스크롤 이벤트를 단일 리스너로 포착
    _stickyLayerScrollAC = new AbortController();
    window.addEventListener('scroll', _syncStickyLayerBounds, {
      passive: true, capture: true, signal: _stickyLayerScrollAC.signal
    });

    console.log(
      `[Assistant] sticky-layer fixed → 타겟: ${targetElement.tagName}#${targetElement.id || ""}`,
    );
  } else {
    layer.style.display = "none";
    layer.style.visibility = "";
    console.log("[Assistant] sticky-layer 비활성화 (대상 없음)");
  }

  _stickyLayerRelocating = false;
}

// ========================================
// 테마/모드/영역 설정
// ========================================
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
  // 테마 변경 알림 (로컬 즉각 처리)
  state.currentTheme = themeKey;
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
  workerSend("CONTEXT_CHANGE", { menuId: menu });
  if (typeof _stickyLayerConfig.getAreaId === "function") {
    const areaId = _stickyLayerConfig.getAreaId(menu);
    if (areaId) {
      state.selectedArea = areaId;
      workerSend("CONTEXT_CHANGE", { areaId });
    }
  }
  relocateStickyLayer();
}

// ========================================
// 기간별 버킷화 함수들
// ========================================
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

  console.log(
    `[recordToBucket] 일: ${dailyKey}, 주: ${weeklyKey}, 월: ${monthlyKey}`,
  );
  console.log(`[recordToBucket] 버킷 업데이트:`, state.timeBuckets);
}

// ========================================
// 시간 추적 함수들
// ========================================
// IndexedDB에서 메뉴 시간 통계 로드
// [Worker 위임] 메뉴 시간 통계 로드 (Worker가 STATE_UPDATE로 복원)
function loadMenuTimeStats() {
  /* Worker INIT 시 자동 복원 */
}

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

function recordMenuTime(menu) {
  if (!menu) return;
  const now = Date.now();
  const elapsedMs = now - state.lastMenuChangeTime;
  state.lastMenuChangeTime = now;
  workerSend("RECORD_AREA_TIME", { areaId: "menu_" + menu, elapsedMs });
}

// ========================================
// 기간별 통계 조회 함수들
// ========================================
// 일별 통계 조회
function getDailyStats(date = new Date()) {
  const bucket = getDailyBucket(date);
  const dailyData = state.timeBuckets.daily[bucket] || {};

  return generateTimeStats(dailyData);
}

// 주별 통계 조회
function getWeeklyStats(date = new Date()) {
  const bucket = getWeeklyBucket(date);
  const weeklyData = state.timeBuckets.weekly[bucket] || {};

  return generateTimeStats(weeklyData);
}

// 월별 통계 조회
function getMonthlyStats(date = new Date()) {
  const bucket = getMonthlyBucket(date);
  const monthlyData = state.timeBuckets.monthly[bucket] || {};

  return generateTimeStats(monthlyData);
}

// 버킷 데이터를 표시용 통계로 변환
function generateTimeStats(bucketData) {
  const items = getBusinessAreas().map((area) => {
    const totalMs = bucketData[area.id] || 0;
    const hours = Math.floor(totalMs / (1000 * 60 * 60));
    const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
    const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

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
  const totalStr =
    totalHours > 0
      ? `${totalHours}시간 ${totalMinutes}분`
      : `${totalMinutes}분`;

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
    totalMs: totalMs,
  };
}

// 기간 범위의 누적 통계
function getDateRangeStats(startDate, endDate) {
  const rangeData = {};
  const current = new Date(startDate);

  while (current <= endDate) {
    const dailyKey = getDailyBucket(current);
    const dailyBucketData = state.timeBuckets.daily[dailyKey] || {};

    Object.keys(dailyBucketData).forEach((areaId) => {
      if (!rangeData[areaId]) rangeData[areaId] = 0;
      rangeData[areaId] += dailyBucketData[areaId];
    });

    current.setDate(current.getDate() + 1);
  }

  return generateTimeStats(rangeData);
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

  console.log(
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
    const timeStr = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;

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
  const totalStr =
    totalHours > 0
      ? `${totalHours}시간 ${totalMinutes}분`
      : `${totalMinutes}분`;

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

  if (days > 0) return `${days}일 전`;
  if (hours > 0) return `${hours}시간 ${minutes % 60}분 전`;
  if (minutes > 0) return `${minutes}분 전`;
  return "방금 전";
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

// ========================================
// [수정] 클립보드 아이템 추가/업데이트 함수
// 중복 시 카운트 증가 및 최상단 이동
// ========================================
function refreshClipboardStateFromDB() {
  workerSend("REFRESH_CLIPBOARD", {});
}

function updateClipboardPanel(preserveScroll = true) {
  if (!state.assistantOpen) return false;
  const panelBody = document.getElementById("clipboard-panel-body");
  if (!panelBody) return false;
  const previousScroll = preserveScroll ? panelBody.scrollTop : 0;
  panelBody.innerHTML = "";
  panelBody.appendChild(renderClipboardTabDOM());
  if (preserveScroll) {
    panelBody.scrollTop = Math.min(previousScroll, panelBody.scrollHeight);
  }
  return true;
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
  showToast("외부 데이터가 수신되었습니다");
  return true;
}

// 부모창이 직접 호출하는 브리지 (same-origin일 때 사용)
window.assistantBridge = {
  pushGridData: (payload) => ingestExternalContent(payload),
  pushText: (payload) => ingestExternalContent(payload),
  setArea: (areaId) => setSelectedArea(areaId),
  setMenu: (menu) => selectMenu(menu),
  open: () => {
    state.assistantOpen = true;
    renderAssistant();
  },
  close: () => {
    state.assistantOpen = false;
    renderAssistant();
  },
  ping: () => "ok",
  // sticky-layer 재배치 제어
  setupStickyLayerObserver: (cfg) => setupStickyLayerObserver(cfg || {}),
  relocateStickyLayer: () => relocateStickyLayer(),
};

// postMessage 기반 브리지 (cross-frame 대응)
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  switch (data.type) {
    case "assistant:gridData":
    case "assistant:text":
      ingestExternalContent(data.payload);
      break;
    case "assistant:setArea":
      setSelectedArea(data.payload);
      break;
    case "assistant:setMenu":
      selectMenu(data.payload);
      break;
    case "assistant:open":
      state.assistantOpen = true;
      renderAssistant();
      break;
    case "assistant:close":
      state.assistantOpen = false;
      renderAssistant();
      break;
    default:
      break;
  }
});

// ========================================
// 대시보드: 할일 리스트 생성 (알림 설정된 메모)
// ========================================
function getTodosFromReminders() {
  const todos = [];

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

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

//당일 리마인더
function getTodayReminders() {
  const filtered = getTodosFromReminders().filter((todo) => !todo.isPast);
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

// ========================================
// 알림 시스템
// ========================================
// 마지막으로 알림을 확인한 분 (중복 방지)
let lastCheckedMinute = null;

// 알림 권한 요청
function requestNotificationPermission() {
  if (!state.settings.browserNotificationEnabled) return;
  if (!("Notification" in window)) {
    console.log("⚠️ 이 브라우저는 Web Notification을 지원하지 않습니다.");
    return;
  }

  if (Notification.permission === "granted") {
    console.log("✓ 알림 권한이 이미 승인되었습니다.");
    return;
  }

  if (Notification.permission === "denied") {
    console.log(
      "⚠️ 사용자가 알림을 거부했습니다. 브라우저 설정에서 권한을 변경하세요.",
    );
    return;
  }

  // 'default' 상태일 때만 요청
  console.log("🔔 알림 권한을 요청 중입니다...");
  Notification.requestPermission()
    .then((permission) => {
      if (permission === "granted") {
        console.log("✓ 알림 권한이 승인되었습니다.");
      } else if (permission === "denied") {
        console.log("⚠️ 사용자가 알림을 거부했습니다.");
      }
    })
    .catch((error) => {
      console.error("알림 권한 요청 실패:", error);
    });
}

// 브라우저 알림 표시
function sendBrowserNotification(title, options = {}) {
  if (!state.settings.browserNotificationEnabled) return;
  if (!("Notification" in window)) {
    console.warn("이 브라우저는 Web Notification을 지원하지 않습니다.");
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
      console.log(`✓ 브라우저 알림 발송: ${title}`);
    } catch (error) {
      console.error("브라우저 알림 전송 실패:", error);
    }
  } else if (Notification.permission !== "denied") {
    console.log("알림 권한이 아직 설정되지 않았습니다.");
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
  let container = styleRoot.querySelector("#notification-toast-container");

  if (!container) {
    const existing = document.getElementById("notification-toast-container");
    if (existing) existing.remove();
    const newContainer = document.createElement("div");
    newContainer.id = "notification-toast-container";
    newContainer.style.position = "fixed";
    newContainer.style.top = "20px";
    newContainer.style.right = "20px";
    newContainer.style.zIndex = "3000";
    newContainer.style.pointerEvents = "none";
    styleRoot.appendChild(newContainer);
    container = newContainer;
  }

  const toastEl = document.createElement("div");
  toastEl.className = "imsmassi-notification-toast";

  const areaName = getAreaName(areaId, "");

  toastEl.innerHTML = `
    <div class="imsmassi-notification-toast-title">${title}</div>
    ${content ? `<div class="imsmassi-notification-toast-content">${content}</div>` : ""}
    ${areaName ? `<div class="imsmassi-notification-toast-area">${areaName}</div>` : ""}
  `;

  container.appendChild(toastEl);

  // 애니메이션 트리거
  setTimeout(() => toastEl.classList.add("imsmassi-show"), 10);

  // 자동 제거
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
    balloonContainer.style.position = "fixed";
    balloonContainer.style.bottom = "100px";
    balloonContainer.style.right = "24px";
    balloonContainer.style.zIndex = "3000";
    balloonContainer.style.pointerEvents = "none";
    styleRoot.appendChild(balloonContainer);
  }

  const balloonEl = document.createElement("div");
  balloonEl.className = "imsmassi-notification-balloon";
  balloonEl.innerHTML = `<div>🔔</div><div style="margin-top: 4px;">${title}</div>`;

  balloonContainer.appendChild(balloonEl);

  // 애니메이션 트리거
  setTimeout(() => balloonEl.classList.add("imsmassi-show"), 10);

  // 자동 제거
  setTimeout(() => {
    balloonEl.classList.remove("imsmassi-show");
    setTimeout(() => balloonEl.remove(), 400);
    if (!state.assistantOpen) {
      setUnreadReminder(true);
    }
  }, duration);
}

function setUnreadReminder(isUnread) {
  state.hasUnreadReminder = isUnread;
  const floatingBtn = document.getElementById("imsmassi-floating-btn");
  if (floatingBtn) {
    floatingBtn.classList.toggle("imsmassi-show-badge", !!isUnread);
  }
}

// 리마인더 확인 및 알림 발송
async function checkReminders() {
  if (!state.memos) return;

  const now = new Date();
  const currentDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
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
        showNotificationToast(
          title,
          plainText || "메모 알림이 도래했습니다",
          areaId,
          6000,
        );

        // 브라우저 알림 발송
        sendBrowserNotification(title, {
          body: plainText || "메모 알림이 도래했습니다",
          tag: `reminder-${memoId}`,
          requireInteraction: false,
        });

        // 반복 알림이면 다음날로 이동
        if (memo.reminderRepeat) {
          const nextDate = new Date(currentDate);
          nextDate.setDate(nextDate.getDate() + 1);
          const nextDateStr = nextDate.toISOString().split("T")[0];
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

        console.log(`알림 발송: ${title}`);
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

  // 5초마다 확인 (5000ms) - 실시간 알림
  window.reminderCheckInterval = setInterval(() => {
    checkReminders();
  }, 5000);

  console.log("알림 시스템이 초기화되었습니다.");
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

  showNotificationToast(title, content, areaId, 6000);
  sendBrowserNotification(title, {
    body: content,
    tag: `reminder-test-${Date.now()}`,
    requireInteraction: false,
  });
  console.log("[testReminderNotification] 리마인더 알림 테스트 실행");
}

// ========================================
// 알림 시스템 테스트 함수
// ========================================
function openAssistant() {
  state.assistantOpen = true;
  setUnreadReminder(false);
  renderAssistant();
}

function closeAssistant() {
  state.assistantOpen = false;
  renderAssistant();
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

// ========================================
// 모달 시스템 - 빌더(Builder) 함수
// ========================================
// 각 모달 타입에 대한 전용 빌더 함수입니다.
// 빌더 함수는 createElement를 사용하여 DOM 요소를 프로그래밍 방식으로 생성하고,
// { content: DOMNode, firstFocus: Element|null } 객체를 반환합니다.
// openModal()은 반환된 content를 appendChild로 삽입하고 firstFocus에 focus()를 호출합니다.

// ── 빌더: 리마인더 설정 모달 ─────────────────────────────
function buildReminderModal(data) {
  const c = getColors();
  const memoId = data ? data.memoId : null;
  const memoForReminder = state.memos[memoId];

  const todayDate = new Date().toISOString().split("T")[0];
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
  title.textContent = "⏰ 리마인더 설정";

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = "메모 제목";
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-title-input",
    placeholder: "메모 제목을 입력하세요",
  });
  titleInput.value = reminderTitle;
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const dateLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  dateLabel.textContent = "알림 날짜";
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
  timeLabel.textContent = "알림 시간";
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
  repeatLabel.textContent = "매일 반복";
  const repeatGroup = createElement("div", {
    className: "imsmassi-modal-repeat-group",
  });
  repeatGroup.append(repeatInput, repeatLabel);

  const quickLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  quickLabel.textContent = "빠른 선택";
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
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", closeModal);
  const clearBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  clearBtn.textContent = "알림 해제";
  clearBtn.addEventListener("click", confirmClearReminder);
  const confirmBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  confirmBtn.textContent = "설정";
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
  title.textContent = "⭐ 템플릿 제안";

  const previewBox = createElement("div", {
    className: "imsmassi-template-suggest-preview",
  });
  const previewLbl = createElement("div", {
    className: "imsmassi-template-suggest-preview-lbl",
  });
  previewLbl.textContent = "자주 사용하는 텍스트";
  const codeEl = createElement("code", {
    className: "imsmassi-template-suggest-code",
  });
  codeEl.textContent = suggestedText;
  previewBox.append(previewLbl, codeEl);

  const tmplLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  tmplLabel.textContent = "템플릿 제목";
  const tmplInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-suggested-template-title",
    placeholder: "이 텍스트의 이름을 정해주세요",
  });
  const tmplGroup = createElement("div");
  tmplGroup.append(tmplLabel, tmplInput);

  const catLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  catLabel.textContent = "카테고리";
  const catSelect = createElement("select", {
    className: "imsmassi-modal-input imsmassi-modal-select-mt",
    id: "modal-suggested-template-category",
  });
  [
    ["default", "일반"],
    ["underwriting", "인수"],
    ["contract", "계약"],
    ["claims", "청구"],
    ["accounting", "회계"],
    ["performance", "실적"],
    ["settlement", "정산"],
    ["finance", "재무"],
  ].forEach(([val, lbl]) => {
    const opt = createElement("option", { value: val });
    opt.textContent = lbl;
    catSelect.appendChild(opt);
  });
  const catGroup = createElement("div", {
    className: "imsmassi-modal-field-mt",
  });
  catGroup.append(catLabel, catSelect);

  const laterBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  laterBtn.textContent = "나중에";
  laterBtn.addEventListener("click", closeModal);
  const addBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  addBtn.textContent = "템플릿으로 추가";
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
  title.textContent = "새 템플릿 추가";

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = "템플릿 제목";
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-template-title",
    placeholder: "예: 확인 요청",
  });
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const contentLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  contentLabel.textContent = "템플릿 내용";
  const contentTextarea = createElement("textarea", {
    className: "imsmassi-modal-textarea",
    id: "modal-template-content",
    placeholder: "자주 사용하는 문구를 입력하세요",
  });
  // data.content가 전달되면 즉시 값을 주입합니다 (기존 setTimeout 해킹 제거).
  if (data && data.content) contentTextarea.value = data.content;
  const contentGroup = createElement("div");
  contentGroup.append(contentLabel, contentTextarea);

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", closeModal);
  const addBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  addBtn.textContent = "추가";
  addBtn.addEventListener("click", confirmAddTemplate);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, addBtn);

  const content = createElement("div");
  content.append(title, titleGroup, contentGroup, btnsGroup);
  return { content, firstFocus: titleInput };
}

// ── 빌더: 템플릿 수정 모달 ─────────────────────────────
function buildEditTemplateModal(data) {
  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.textContent = "✎ 템플릿 수정";

  const titleLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  titleLabel.textContent = "템플릿 제목";
  const titleInput = createElement("input", {
    type: "text",
    className: "imsmassi-modal-input",
    id: "modal-edit-template-title",
    placeholder: "예: 확인 요청",
  });
  const titleGroup = createElement("div");
  titleGroup.append(titleLabel, titleInput);

  const contentLabel = createElement("label", {
    className: "imsmassi-modal-label",
  });
  contentLabel.textContent = "템플릿 내용";
  const contentTextarea = createElement("textarea", {
    className: "imsmassi-modal-textarea",
    id: "modal-edit-template-content",
    placeholder: "자주 사용하는 문구를 입력하세요",
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

  const cancelBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-secondary",
  });
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", closeModal);
  const saveBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-primary",
  });
  saveBtn.textContent = "저장";
  saveBtn.addEventListener("click", confirmEditTemplate);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, saveBtn);

  const content = createElement("div");
  content.append(title, titleGroup, contentGroup, btnsGroup);
  return { content, firstFocus: titleInput };
}

// ── 빌더: 메모 삭제 확인 모달 ─────────────────────────
function buildDeleteConfirmModal(data) {
  const c = getColors();

  const title = createElement("div", { className: "imsmassi-modal-title" });
  title.textContent = "⚠️ 메모 삭제";

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
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", cancelDeleteMemo);
  const deleteBtn = createElement("button", {
    className: "imsmassi-modal-btn imsmassi-modal-btn-danger",
  });
  deleteBtn.textContent = "삭제";
  deleteBtn.addEventListener("click", confirmDeleteMemo);
  const btnsGroup = createElement("div", { className: "imsmassi-modal-btns" });
  btnsGroup.append(cancelBtn, deleteBtn);

  const content = createElement("div");
  content.append(title, bodyDiv, btnsGroup);
  return { content, firstFocus: null };
}

// ── 빌더: 설정 모달 ───────────────────────────────────
function buildSettingsModal(data) {
  const container = createElement("div");
  container.innerHTML = getSettingsHtml("closeModal");
  return { content: container, firstFocus: null };
}

// ── 모달 빌더 라우팅 맵 ───────────────────────────────
const MODAL_BUILDERS = {
  setReminder: buildReminderModal,
  templateSuggest: buildTemplateSuggestModal,
  addTemplate: buildAddTemplateModal,
  editTemplate: buildEditTemplateModal,
  deleteConfirm: buildDeleteConfirmModal,
  settings: buildSettingsModal,
};

// ========================================
// 모달 시스템
// ========================================
function openModal(type, data) {
  console.log("[openModal] 모달 타입:", type, "데이터:", data);
  state.currentModal = type;
  state.currentMemoId = data ? data.memoId : null;
  console.log("[openModal] state.currentMemoId 설정:", state.currentMemoId);

  const modal = document.getElementById("modal-content");

  // ── 빌더 함수 호출 ────────────────────────────────────
  // MODAL_BUILDERS 맵에서 타입에 맞는 빌더를 찾아 호출합니다.
  // 빌더가 없는 타입은 무시됩니다.
  const builder = MODAL_BUILDERS[type];
  if (!builder) {
    console.warn("[openModal] 알 수 없는 모달 타입:", type);
    return;
  }

  const { content: builtContent, firstFocus } = builder(data);

  // ── DOM 삽입 (innerHTML 대신 appendChild) ─────────────
  modal.innerHTML = "";
  modal.appendChild(builtContent);

  // ── 설정 모달 너비 조정 ───────────────────────────────
  if (type === "settings") {
    modal.classList.add("imsmassi-modal-wide");
  } else {
    modal.classList.remove("imsmassi-modal-wide");
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
        <div style="margin-bottom: 16px;">
          <div style="font-size: 13px; font-weight: 600; color: #191F28; margin-bottom: 12px;">알림 설정</div>

          <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">브라우저 알림</span>
              <div style="font-size: 10px; color: #999;">알림 도착 시 브라우저 알림 표시</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-browser-notification" ${state.settings.browserNotificationEnabled ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-top: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">토스트 알림</span>
              <div style="font-size: 10px; color: #999;">어시스턴트 하단 토스트 표시</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-toast" ${state.settings.toastEnabled ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#FFF9E6"}; border-radius: 6px; border: 1px solid #F0E6CC; margin-top: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">백업 알림</span>
              <div style="font-size: 10px; color: #999;">마지막 백업: ${state.settings.lastBackup}</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-backup" ${state.settings.backupReminder ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- 기능 설정 -->
        <div style="margin-bottom: 16px;">
          <div style="font-size: 13px; font-weight: 600; color: #191F28; margin-bottom: 12px;">기능 설정</div>
          <div style="display: ${state.hiddenUI.areaColor ? 'flex' : 'none'}; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-bottom: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">업무 컬러 설정 표시</span>
              <div style="font-size: 10px; color: #999;">대시보드 내 업무 컬러 설정 섹션 표시</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-show-area-color" ${state.settings.showAreaColorSection !== false ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="display: ${state.hiddenUI.timeInsight ? 'flex' : 'none'}; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-bottom: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">시간 인사이트 표시</span>
              <div style="font-size: 10px; color: #999;">대시보드 내 시간 인사이트 섹션 표시</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-show-time-tab" ${state.settings.showTimeTab !== false ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="display: ${state.hiddenUI.markdown ? 'flex' : 'none'}; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-bottom: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">마크다운 단축키</span>
              <div style="font-size: 10px; color: #999;">**굵게**, *기울임*, ~~취소선~~ 등</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-markdown" ${state.settings.markdownEnabled ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="display: ${state.hiddenUI.debugLog ? 'flex' : 'none'}; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-bottom: 10px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">디버그 로그</span>
              <div style="font-size: 10px; color: #999;">콘솔 로그 출력 on/off</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-debug-logs" ${state.settings.debugLogs ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>

          <div style="margin-bottom: 16px; display: ${state.hiddenUI.autoNav ? 'flex' : 'none'}; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">대시보드 자동 이동</span>
              <div style="font-size: 10px; color: #999;">알림 설정 후 대시보드로 이동</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-auto-dashboard" ${state.settings.autoNavigateToDashboard ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>


        <!-- 성능 설정 -->
        <div style="margin-bottom: 16px; display: ${state.hiddenUI.lowSpec ? 'block' : 'none'};">
          <div style="font-size: 13px; font-weight: 600; color: #191F28; margin-bottom: 12px;">성능 설정</div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px;">
            <div>
              <span style="font-size: 12px; color: #191F28;">저사양 모드</span>
              <div style="font-size: 10px; color: #999;">애니메이션 축소, 렌더링 최적화</div>
            </div>
            <label class="imsmassi-toggle-switch">
              <input type="checkbox" id="setting-lowspec" ${state.settings.lowSpecMode ? "checked" : ""}>
              <span class="imsmassi-toggle-slider"></span>
            </label>
          </div>
        </div>

         <!-- 자동정리 설정 -->
          <div style="margin-bottom: 12px;">
            <div style="font-size: 13px; font-weight: 600; color: #191F28; margin-bottom: 12px;">자동 정리 설정</div>
            <div style="display: flex; flex-direction: column; gap: 10px; padding: 10px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 6px; margin-top: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; color: #666;">클립보드 기록</span>
                <select class="imsmassi-modal-input" id="setting-clipboard" style="width: 100px; padding: 6px 8px; font-size: 12px;">
                  <option value="3" ${state.settings.autoCleanup.clipboard === 3 ? "selected" : ""}>3일</option>
                  <option value="7" ${state.settings.autoCleanup.clipboard === 7 ? "selected" : ""}>7일</option>
                  <option value="14" ${state.settings.autoCleanup.clipboard === 14 ? "selected" : ""}>14일</option>
                  <option value="30" ${state.settings.autoCleanup.clipboard === 30 ? "selected" : ""}>30일</option>
                </select>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; color: #666;">오래된 메모</span>
                <select class="imsmassi-modal-input" id="setting-oldmemos" style="width: 100px; padding: 6px 8px; font-size: 12px;">
                  <option value="0">삭제 안 함</option>
                  <option value="90" ${state.settings.autoCleanup.oldMemos === 90 ? "selected" : ""}>90일</option>
                  <option value="180" ${state.settings.autoCleanup.oldMemos === 180 ? "selected" : ""}>180일</option>
                  <option value="365" ${state.settings.autoCleanup.oldMemos === 365 ? "selected" : ""}>1년</option>
                </select>
              </div>
            </div>
          </div>

        <!-- 저장 용량 -->
        <div style="margin-bottom: 20px; padding: 16px; background: ${state.isDarkMode ? "#252525" : "#F8F9FA"}; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 13px; font-weight: 600; color: #191F28;">저장 용량</span>
            <span style="font-size: 12px; color: ${usageColor}; font-weight: 600;">${displayUsed}MB / ${state.storageLimit}MB</span>
          </div>
          <div style="height: 8px; background: #E0E0E0; border-radius: 4px; overflow: hidden;">
            <div style="height: 100%; width: ${usagePercent}%; background: ${usageColor}; border-radius: 4px; transition: width 0.3s;"></div>
          </div>
          <div style="font-size: 11px; color: #999; margin-top: 6px;">${usagePercent >= 80 ? "⚠️ 용량이 부족합니다. 오래된 데이터를 정리해주세요." : "정상적으로 사용 중입니다."}</div>
        </div>

          <div style="display: flex; gap: 8px;">
            <button class="imsmassi-modal-btn" style="flex: 1; background: #191F28; color: #FFF; border: none; font-size: 12px; padding: 10px;" onclick="exportAllData()">📤 내보내기</button>
            <button class="imsmassi-modal-btn" style="flex: 1; background: #5BA55B; color: #FFF; border: none; font-size: 12px; padding: 10px;" onclick="importData()">📥 가져오기</button>
            <button class="imsmassi-modal-btn" style="flex: 1; background: #E74C3C; color: #FFF; border: none; font-size: 12px; padding: 10px;" onclick="clearOldData()">🗑️ 정리</button>
          </div>
        </div>

        <!-- 온보딩 가이드 다시보기 -->
        <div style="margin-bottom: 16px; padding: 14px 16px; background: ${state.isDarkMode ? '#252525' : '#F0F4FF'}; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 12px; font-weight: 600; color: #191F28;">이용 가이드</div>
            <div style="font-size: 10px; color: #999; margin-top: 2px;">어시스턴트 주요 기능 안내를 다시 확인해보세요</div>
          </div>
          <button class="imsmassi-modal-btn" style="background: #4A8CFF; color: #FFF; border: none; font-size: 11px; padding: 7px 14px; white-space: nowrap; flex-shrink: 0;" onclick="AssistantGuide.replay()">📖 다시보기</button>
        </div>

      `;
}

function renderSettingsTab() {
  return getSettingsHtml("closeSettingsTab");
}

function initSettingsTab() {
  const toggleMap = [
    { id: "setting-lowspec", label: "저사양 모드" },
    { id: "setting-markdown", label: "마크다운 단축키" },
    { id: "setting-debug-logs", label: "디버그 로그" },
    { id: "setting-auto-dashboard", label: "대시보드 자동 이동" },
    { id: "setting-backup", label: "백업 알림" },
    { id: "setting-browser-notification", label: "브라우저 알림" },
    { id: "setting-toast", label: "토스트 알림" },
    { id: "setting-show-time-tab", label: "시간 탭 표시" },
    { id: "setting-show-area-color", label: "업무 컬러 설정 표시" },
  ];

  toggleMap.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = () => {
        console.log(`설정 변경 - ${label}: ${el.checked ? "ON" : "OFF"}`);
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
  console.log("[closeModal] 모달 닫기 시작");
  const modalOverlay = document.getElementById("imsmassi-modal-overlay");
  if (modalOverlay) modalOverlay.classList.add("imsmassi-hidden");
  state.currentModal = null;
  state.currentMemoId = null;
  state.editingTemplateId = null;
  console.log("[closeModal] 모달 닫기 완료");
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
    showToast("날짜와 시간을 선택하세요");
    return;
  }

  const memoId = state.currentMemoId;
  const memo = state.memos[memoId];

  if (!memo) {
    showToast("메모를 찾을 수 없습니다");
    return;
  }

  if (!memoId) {
    showToast("메모 ID를 찾을 수 없습니다");
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
    showToast("메모를 찾을 수 없습니다");
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

// ========================================
// 메모 기능
// ========================================
async function addMemo() {
  const memoInput = document.getElementById("memo-input");
  const snapshot = getMemoEditorSnapshot(memoQuill, memoInput);

  if (!state.selectedMenu) {
    showToast("메뉴가 선택되지 않았습니다");
    return;
  }

  if (snapshot.isEmpty) {
    showToast("메모 내용을 입력하세요");
    return;
  }

  // 앱 전체 용량 제한 검사 (50MB)
  if (state.storageUsed >= state.storageLimit) {
    showToast(
      "⚠️ 저장 용량이 초과되었습니다. 오래된 메모를 삭제하거나 자동 정리를 실행하세요.",
    );
    return;
  }

  // 용량 초과 체크 (2MB 제한)
  const MEMO_LIMIT = 2 * 1024 * 1024; // 2MB in bytes
  const useRichText = !!memoQuill;
  const contentForSize = useRichText ? snapshot.html : snapshot.text;
  const currentSize = new Blob([contentForSize]).size;
  if (currentSize > MEMO_LIMIT) {
    showToast("⚠️ 메모 용량이 2MB를 초과했습니다");
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
    date: new Date().toISOString().split("T")[0],
    isRichText: useRichText,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Worker에 ADD_MEMO 전송 (DB 저장 + 상태 브로드캐스트)
  workerSend("ADD_MEMO", { memoId, memoData: newMemo });

  // 에디터 즉시 초기화 (UI-only 로컬 처리)
  if (memoQuill) {
    memoQuill.setText("");
    state.memoDraftHtml = "";
    state.memoDraftText = "";
  } else if (memoInput) {
    memoInput.innerText = "";
  }
  updateMemoCapacity();
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

  // 용량 초과 시 경고 색상
  const c = getColors();
  if (percent > 90) {
    capacityDisplay.style.color = "#E74C3C";
    capacityDisplay.textContent = `⚠️ ${sizeText} / 2 MB (${percent}%)`;
  } else if (percent > 70) {
    capacityDisplay.style.color = "#E67E22";
    capacityDisplay.textContent = `${sizeText} / 2 MB (${percent}%)`;
  } else {
    capacityDisplay.style.color = c.subText;
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
    showToast("⚠️ 메모 용량 초과 (최대 2MB)");
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
    showToast("⚠️ 메모 용량 초과 (최대 2MB)");
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
    showToast("⚠️ 메모 ID를 찾을 수 없습니다");
    return;
  }

  const memo = state.memos[memoId];
  if (!memo) {
    console.error("[openDeleteConfirmModal] 메모를 찾을 수 없습니다:", memoId);
    showToast("⚠️ 메모를 찾을 수 없습니다");
    return;
  }

  state.currentMemoId = memoId;
  openModal("deleteConfirm", { memoId: memoId });
  console.log("[openDeleteConfirmModal] 삭제 확인 모달 열음:", memoId);

  // 리마인더가 설정되어 있으면 모달에 표시
  setTimeout(() => {
    const reminderDisplay = document.getElementById(
      "modal-delete-reminder-display",
    );
    if (reminderDisplay && memo.reminder) {
      reminderDisplay.innerHTML = `<div style="padding: 8px 12px; background: rgba(230, 126, 34, 0.1); border-left: 3px solid #E67E22; border-radius: 4px; margin: 8px 0; font-size: 13px;">
        <strong>⏰ 알림 설정됨:</strong><br>
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
    showToast("⚠️ 메모를 찾을 수 없습니다");
    return;
  }
  if (!state.memos[memoId]) {
    showToast("⚠️ 메모를 찾을 수 없습니다");
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
  console.log("[cancelDeleteMemo] 삭제 취소");
  state.currentMemoId = null;
  closeModal();
}

function togglePin(memoId) {
  const memo = state.memos[memoId];
  if (!memo) {
    showToast("메모를 찾을 수 없습니다");
    return;
  }
  workerSend("TOGGLE_PIN", { memoId });
}

// [레거시 - 미사용] 이전 직접 정렬 로직 (Worker로 이전됨)
function _legacyTogglePinSort(memoId, memo) {
  // memosByArea 인덱스에서 위치 재정렬
  // 고정된 메모는 맨 앞으로, 일반 메모는 날짜순으로 정렬
  Object.keys(state.memosByArea).forEach((areaId) => {
    const memoList = state.memosByArea[areaId];
    if (memoList && memoList.includes(memoId)) {
      // 현재 메모를 배열에서 제거
      const idx = memoList.indexOf(memoId);
      if (idx > -1) {
        memoList.splice(idx, 1);
      }

      // 고정된 메모면 맨 앞에 추가, 아니면 끝에 추가
      if (memo.pinned) {
        memoList.unshift(memoId); // 맨 앞에
      } else {
        // 일반 메모들 중 같은 날짜 메모 다음에 추가 (날짜순 정렬 유지)
        let insertIdx = 0;
        for (let i = 0; i < memoList.length; i++) {
          const m = state.memos[memoList[i]];
          if (m && !m.pinned && m.date === memo.date) {
            insertIdx = i + 1;
          } else if (m && !m.pinned && new Date(m.date) < new Date(memo.date)) {
            insertIdx = i + 1;
          } else if (m && m.pinned) {
            // 고정 메모는 건너뛰고 계속 탐색
            continue;
          } else {
            break;
          }
        }
        memoList.splice(insertIdx, 0, memoId);
      }
    }
  });
}

// 고정 기능 디버깅 헬퍼
async function confirmAddTag() {
  const input = document.getElementById("modal-tag-input");
  const tag = input.value.trim();

  if (!tag) {
    showToast("태그 이름을 입력하세요");
    return;
  }

  const memoId = state.currentMemoId;
  const memo = state.memos[memoId];

  if (!memo) {
    showToast("메모를 찾을 수 없습니다");
    closeModal();
    return;
  }

  if (memo.tags && memo.tags.includes(tag)) {
    showToast("이미 존재하는 태그입니다");
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
  showToast(`"${tag}" 태그가 추가되었습니다`);
  closeModal();
}

// ========================================
// 클립보드 기능: 저장된 항목을 시스템 클립보드에 복사
// ========================================
function copyToClipboard(content) {
  if (!content || typeof content !== "string") {
    console.warn("[copyToClipboard] Invalid content:", content);
    showToast("복사할 내용이 없습니다");
    return false;
  }

  // 내부 클립보드에 즉시 반영 (복사 성공 여부와 무관하게 기록)
  addClipboardItem(content);

  // ① 현대 Clipboard API (포커스 빼앗지 않음)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        console.log(
          "[copyToClipboard] Clipboard API 복사:",
          content.substring(0, 30),
        );
        showToast(
          "✓ 클립보드에 복사됨: " +
            content.substring(0, 20) +
            (content.length > 20 ? "..." : ""),
        );
      })
      .catch((err) => {
        console.warn(
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

  try {
    tempElement.focus();
    tempElement.select();
    tempElement.setSelectionRange(0, 99999);
    const success = document.execCommand("copy");
    if (success) {
      console.log(
        "[copyToClipboard] execCommand 복사:",
        content.substring(0, 30),
      );
      showToast(
        "✓ 클립보드에 복사됨: " +
          content.substring(0, 20) +
          (content.length > 20 ? "..." : ""),
      );
      return true;
    } else {
      console.error("[copyToClipboard] execCommand 실패");
      showToast("클립보드 복사에 실패했습니다");
      return false;
    }
  } catch (error) {
    console.error("[copyToClipboard] 예외 발생:", error);
    showToast("클립보드 복사에 실패했습니다");
    return false;
  } finally {
    getAssistantRoot().removeChild(tempElement);
    // 포커스 복구 (Quill 에디터 등 이전 포커스 상태로 되돌림)
    if (prevFocused && typeof prevFocused.focus === "function") {
      try {
        prevFocused.focus();
      } catch (_) {}
    }
  }
}

function addCurrentAreaLabel(memoId) {
  const memo = state.memos[memoId];
  if (!memo) return;
  const currentMenu = state.selectedMenu;
  if (memo.labels?.includes(currentMenu)) {
    showToast(
      `⚠️ 이 메모는 이미 현재 메뉴(${currentMenu})에 추가되어 있습니다`,
    );
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

function createStickyNoteForMemo(memoId) {
  const memo = state.memos[memoId];
  if (!memo) return;

  const currentMenu = state.selectedMenu;
  if (!currentMenu) return;

  // 현재 화면(menuId) 기준으로 이미 포스트잇이 있는지 확인 (다른 화면 포스트잇과 혼동 방지)
  const alreadyOnScreen = (state.stickyNotes || []).some(
    (n) => n.memoId === memoId && n.menuId === currentMenu,
  );
  if (alreadyOnScreen) {
    removeStickyNote(memoId);
    return;
  }

  addStickyNote(memoId);
  showToast(`✓ 포스트잇이 생성되었습니다`);
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
    showToast(
      "⚠️ 저장 용량이 초과되었습니다. 오래된 데이터를 삭제하고 다시 시도하세요.",
    );
    return;
  }
  const safeContent = decodeURIComponent(suggestedText);
  const title = document
    .getElementById("modal-suggested-template-title")
    ?.value.trim();
  const category = document.getElementById(
    "modal-suggested-template-category",
  )?.value;
  if (!title) {
    showToast("템플릿 이름을 입력하세요");
    return;
  }
  const template = {
    title,
    content: safeContent,
    category: category || "default",
    count: 0,
  };
  workerSend("ADD_TEMPLATE", { template });
  closeModal();
}

function confirmAddTemplate() {
  if (state.storageUsed >= state.storageLimit) {
    showToast(
      "⚠️ 저장 용량이 초과되었습니다. 오래된 데이터를 삭제하고 다시 시도하세요.",
    );
    return;
  }
  const title = document.getElementById("modal-template-title")?.value.trim();
  const content = document
    .getElementById("modal-template-content")
    ?.value.trim();
  if (!title) {
    showToast("템플릿 제목을 입력하세요");
    return;
  }
  if (!content) {
    showToast("템플릿 내용을 입력하세요");
    return;
  }
  const template = { title, content, count: 0 };
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
    showToast("템플릿 제목을 입력하세요");
    return;
  }
  if (!content) {
    showToast("템플릿 내용을 입력하세요");
    return;
  }
  if (!state.editingTemplateId) {
    showToast("템플릿을 찾을 수 없습니다");
    return;
  }
  workerSend("EDIT_TEMPLATE", {
    templateId: state.editingTemplateId,
    title,
    content,
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
  console.log("시간 기간 변경:", period);

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

  console.log(`[setTimePeriod] ${period} (키: ${debugKey})`);
  console.log("[setTimePeriod] 전체 버킷:", state.timeBuckets);

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
      oldMemos:
        parseInt(g("setting-oldmemos")?.value) ||
        state.settings.autoCleanup.oldMemos,
    },
    lowSpecMode: g("setting-lowspec")?.checked ?? state.settings.lowSpecMode,
    backupReminder:
      g("setting-backup")?.checked ?? state.settings.backupReminder,
    markdownEnabled:
      g("setting-markdown")?.checked ?? state.settings.markdownEnabled,
    debugLogs: g("setting-debug-logs")?.checked ?? state.settings.debugLogs,
    autoNavigateToDashboard:
      g("setting-auto-dashboard")?.checked ??
      state.settings.autoNavigateToDashboard,
    browserNotificationEnabled:
      g("setting-browser-notification")?.checked ??
      state.settings.browserNotificationEnabled,
    toastEnabled: g("setting-toast")?.checked ?? state.settings.toastEnabled,
    showTimeTab: g("setting-show-time-tab")
      ? g("setting-show-time-tab").checked
      : state.settings.showTimeTab !== false,
    showAreaColorSection: g("setting-show-area-color")
      ? g("setting-show-area-color").checked
      : state.settings.showAreaColorSection !== false,
  };
}

async function saveSettings(options = {}) {
  const { silent = false } = options;
  const newSettings = _readSettingsFromDOM();
  const prev = { ...state.settings };

  // 로컬 즉각 반영 (UI 반응성)
  Object.assign(state.settings, newSettings);
  state.autoNavigateToDashboard = newSettings.autoNavigateToDashboard;

  if (prev.lowSpecMode !== newSettings.lowSpecMode) applyLowSpecMode();
  if (prev.debugLogs !== newSettings.debugLogs)
    setConsoleLoggingEnabled(!!newSettings.debugLogs);
  if (
    newSettings.browserNotificationEnabled &&
    !prev.browserNotificationEnabled
  )
    requestNotificationPermission();

  // Worker에 SAVE_SETTINGS 전송 (DB 저장 + 브로드캐스트)
  workerSend("SAVE_SETTINGS", { settings: newSettings });

  if (!silent) showToast("설정이 저장되었습니다");
  renderAssistant();
}

function exportAllData() {
  // Worker가 EXPORT_DATA_RESULT 메시지로 데이터를 전달하면
  // downloadExportData()가 자동 호출됩니다.
  workerSend("EXPORT_DATA", {});
}

function importData() {
  const confirmed = window.confirm(
    "가져오기를 실행하면 기존 데이터가 모두 삭제됩니다. (시간 데이터 제외) 계속하시겠습니까?",
  );
  if (!confirmed) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const importedData = JSON.parse(text);
      // Worker에 IMPORT_DATA 전송 → STATE_UPDATE 수신 후 자동 재렌더
      workerSend("IMPORT_DATA", { importedData });
    } catch (error) {
      console.error("데이터 가져오기 실패:", error);
      showToast("데이터 가져오기에 실패했습니다");
    }
  };
  input.click();
}

function clearOldData() {
  const settings = _readSettingsFromDOM();
  workerSend("CLEAR_OLD_DATA", { settings });
}

function removeMemoFromState(memoId) {
  if (!memoId) return;
  delete state.memos[memoId];
  Object.keys(state.memosByArea).forEach((areaId) => {
    const idx = state.memosByArea[areaId].indexOf(memoId);
    if (idx > -1) {
      state.memosByArea[areaId].splice(idx, 1);
    }
  });
  state.stickyNotes = (state.stickyNotes || []).filter(
    (note) => note.memoId !== memoId,
  );
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
  console.log("[loadStateFromDB] Worker 모드 - STATE_UPDATE 대기 중");
}

// ========================================
// 렌더링 함수들
// ========================================
function renderAll() {
  initializeStyles();
  rebuildAssistantTabs();
  renderControlPanel();
  renderSystemPreview();
  renderPalette();
  renderAssistant();
}

// ====== 배포시 제거 시작: 데모/미리보기 렌더링 함수 ======
function renderControlPanel() {
  const theme = getTheme();
  const themeButtons = document.getElementById("theme-buttons");
  if (!themeButtons) return;

  // 테마 버튼
  let themeBtnsHtml = "";
  Object.entries(themes).forEach(([key, t]) => {
    const isActive = state.currentTheme === key;
    const borderStyle = key === "lightBeige" ? "border: 1px solid #ccc;" : "";
    themeBtnsHtml += `
      <button class="imsmassi-theme-btn ${isActive ? "imsmassi-active" : ""}"
              style="border-color: ${isActive ? t.primary : "#E0E0E0"}; background: ${isActive ? t.primaryLight : "#FFF"};"
              onclick="setTheme('${key}')">
        <span class="imsmassi-theme-dot" style="background: ${t.primary}; ${borderStyle}"></span>
        ${t.name}
      </button>
    `;
  });
  themeButtons.innerHTML = themeBtnsHtml;
}

function renderControlPanel() {
  const theme = getTheme();
  const themeButtons = document.getElementById("theme-buttons");
  if (!themeButtons) return;

  // 테마 버튼
  let themeBtnsHtml = "";
  Object.entries(themes).forEach(([key, t]) => {
    const isActive = state.currentTheme === key;
    const borderStyle = key === "lightBeige" ? "border: 1px solid #ccc;" : "";
    themeBtnsHtml += `
      <button class="imsmassi-theme-btn ${isActive ? "imsmassi-active" : ""}"
              style="border-color: ${isActive ? t.primary : "#E0E0E0"}; background: ${isActive ? t.primaryLight : "#FFF"};"
              onclick="setTheme('${key}')">
        <span class="imsmassi-theme-dot" style="background: ${t.primary}; ${borderStyle}"></span>
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
// ====== 배포시 제거 끝: 데모/미리보기 렌더링 함수 ======
function renderAssistant() {
  applyLowSpecMode();

  const theme = getTheme();
  const area = getArea();
  const c = getColors();

  // 플로팅 버튼 — 가시성 + 테마 색상 항상 동기화
  const floatingBtn = document.getElementById("imsmassi-floating-btn");
  if (floatingBtn) {
    floatingBtn.style.backgroundColor = state.isDarkMode
      ? theme.primaryDark
      : theme.primary;
    floatingBtn.classList.toggle("imsmassi-hidden", !!state.assistantOpen);
  }

  // 패널 — 가시성 동기화 + 기본 스타일 세팅
  const panel = document.getElementById("imsmassi-floating-panel");
  if (!panel) return;
  panel.classList.toggle("imsmassi-hidden", !state.assistantOpen);
  panel.style.background = c.bg;
  panel.style.border = `1px solid ${c.border}`;
  // 저장된 높이 복원
  if (state.panelHeight) {
    panel.style.height = `${state.panelHeight}px`;
  } else {
    panel.style.height = "";
  }
  // 리사이즈 핸들 초기화 (처음 한 번만)
  if (!panel._resizeInited) {
    panel._resizeInited = true;
    initPanelResize(panel);
  }

  if (!state.assistantOpen) return;

  // 헤더
  const header = document.getElementById("imsmassi-assistant-header");
  if (!header) return;
  header.style.background = state.isDarkMode
    ? theme.primaryDark
    : theme.primary;
  header.style.color = c.headerText;
  const closeBtn = document.querySelector(".imsmassi-assistant-close");
  if (closeBtn) closeBtn.style.color = c.headerText;
  const dashboardBtn = document.getElementById("assistant-dashboard-btn");
  if (dashboardBtn) {
    dashboardBtn.style.borderColor = c.headerText;
    updateDashboardButton();
  }

  // 푸터
  const footer = document.getElementById("imsmassi-assistant-footer");
  if (!footer) return;
  footer.style.background = state.isDarkMode ? "#252525" : "#FAFAFA";
  footer.style.borderTopColor = c.border;
  footer.style.color = c.subText;
  footer.querySelectorAll(".imsmassi-assistant-footer-btn").forEach((el) => {
    el.style.borderColor = c.border;
    el.style.color = c.subText;
  });
  footer.querySelectorAll(".imsmassi-assistant-footer-group").forEach((el) => {
    el.style.borderColor = c.border;
  });

  const footerModes = document.getElementById(
    "imsmassi-assistant-footer-modes",
  );
  if (footerModes) {
    footerModes.innerHTML = `
      <span style="font-size: 11px;">다크</span>
      <label class="imsmassi-toggle-switch" style="transform: scale(0.85);">
        <input type="checkbox" ${state.isDarkMode ? "checked" : ""} onchange="setDarkMode(this.checked)">
        <span class="imsmassi-toggle-slider"></span>
      </label>
     
    `;
  }

  const footerThemes = document.getElementById(
    "imsmassi-assistant-footer-themes",
  );
  if (footerThemes) {
    let themeIconsHtml = "";
    Object.entries(themes).forEach(([key, t]) => {
      const isActive = state.currentTheme === key;
      const activeRing = isActive
        ? `box-shadow: 0 0 0 2px ${state.isDarkMode ? "#FFF" : "#191F28"};`
        : "";
      themeIconsHtml += `
        <button class="imsmassi-assistant-footer-theme-btn ${isActive ? "imsmassi-active" : ""}"
                title="${t.name}"
                onclick="setTheme('${key}')"
                style="background: ${t.primary}; border-color: ${c.border}; ${activeRing}"></button>
      `;
    });
    footerThemes.innerHTML = themeIconsHtml;
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

  if (usagePercent >= 80) {
    statusText = `⚠️ ${usedMB}MB / ${limitMB}MB`;
    storageInfo.style.color = "#E74C3C";
  } else if (state.settings.lowSpecMode) {
    statusText = `⚡ 저사양 | ${usedMB}MB / ${limitMB}MB`;
    storageInfo.style.color = "#E67E22";
    storageInfo.title = `저사양 모드 활성 | ${usedMB}MB / ${limitMB}MB 사용 중`;
  } else {
    storageInfo.style.color = colors.subText;
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
  const limitMB = 50;
  const usedMB = calculateAppUsageMB();

  state.storageUsed = usedMB;
  state.storageLimit = limitMB;

  const c = getColors();
  updateFooterStorageInfo(c);
}

function estimateTimeDataMB() {
  try {
    const timePayload = {
      menuTimeStats: state.menuTimeStats,
      timeBuckets: state.timeBuckets,
    };
    const bytes = new Blob([JSON.stringify(timePayload)]).size;
    return bytes / (1024 * 1024);
  } catch (error) {
    return 0;
  }
}

function renderAssistantTabs() {
  const area = getArea();
  const c = getColors();

  const tabsContainer = document.getElementById("imsmassi-assistant-tabs");
  if (!tabsContainer) return;
  if (!assistantTabs.length) {
    tabsContainer.innerHTML = "";
    tabsContainer.style.display = "none";
    return;
  }
  tabsContainer.style.display = "flex";
  tabsContainer.style.background = state.isDarkMode ? "#252525" : "#FAFAFA";
  tabsContainer.style.borderBottomColor = c.border;

  // createElement를 사용하여 탭 버튼을 프로그래밍 방식으로 생성합니다.
  tabsContainer.innerHTML = "";
  assistantTabs.forEach((tab) => {
    const isActive = state.activeTab === tab.id;
    const btn = createElement("button", {
      className: `imsmassi-assistant-tab${isActive ? " imsmassi-active" : ""}`,
      style: {
        borderBottomColor: isActive ? area.color : "transparent",
        background: isActive ? c.bg : "transparent",
        color: isActive ? area.color : c.subText,
      },
      onclick: () => setActiveTab(tab.id),
    });
    const iconSpan = createElement("span", {
      className: "imsmassi-assistant-tab-icon",
    });
    iconSpan.textContent = tab.icon;
    const labelSpan = createElement("span", {
      className: "imsmassi-assistant-tab-label",
      style: { fontWeight: isActive ? "600" : "400" },
    });
    labelSpan.textContent = tab.label;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    tabsContainer.appendChild(btn);
  });
}

function renderAssistantContent(previousTab) {
  const area = getArea();
  const c = getColors();
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
      setTimeout(() => {
        initMemoEditor();
        initMemoListEditors();
        initInlineMemoEditors();
        focusInlineMemoEditor();
        updateMemoSidePanelState();
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
    content.style.transition = "opacity 0.18s ease, transform 0.18s ease";
    content.style.opacity = "0";
    content.style.transform = "translateY(6px)";
    setTimeout(() => {
      renderContent();
      requestAnimationFrame(() => {
        content.style.opacity = "1";
        content.style.transform = "translateY(0)";
      });
    }, 120);
  } else {
    content.style.opacity = "1";
    content.style.transform = "none";
    renderContent();
  }
}

// ========================================
// 메모 아이템 컴포넌트 (DOM 빌더)
// ========================================
/**
 * renderMemoItemDOM(memo) - 메모 아이템 하나의 DOM 요소를 생성하는 컴포넌트 함수.
 * HTML 문자열 대신 DOM을 직접 빌드하여 이벤트를 addEventListener로 바인딩합니다.
 * @param {Object} memo - 메모 데이터 객체
 * @returns {HTMLElement} - 완성된 메모 아이템 DOM 요소
 */
function renderMemoItemDOM(memo) {
  const area = getArea();
  const c = getColors();

  // ── 루트 컨테이너 ──
  const item = createElement("div", {
    className: "imsmassi-memo-item",
    "data-id": memo.id,
  });
  if (memo.pinned) {
    item.classList.add("imsmassi-memo-item-pinned");
    item.style.setProperty("--memo-pin-border", area.color);
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
    title: memo.pinned ? "고정 해제" : "고정",
  });
  pinBtn.textContent = "📌";
  pinBtn.addEventListener("click", () =>
    togglePin(memo.id).catch((e) => console.error("고정 실패:", e)),
  );
  pinBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  const titleSpan = createElement("span", {
    className: "imsmassi-memo-title-editable",
    contenteditable: "true",
    "data-memo-id": memo.id,
    "data-placeholder": "제목",
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
    reminderBadge.textContent = `⏰ ${reminderTime}`;
    headerLeft.appendChild(reminderBadge);
  }

  // 헤더 우측: 삭제 버튼
  const headerRight = createElement("div", {
    className: "imsmassi-memo-header-right",
  });

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-header-delete-btn",
    draggable: "false",
    title: "삭제",
  });
  deleteBtn.textContent = "✕";
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

  // ── 푸터 (원산지 · 날짜 · 액션 버튼) ──
  const footer = createElement("div", {
    className: "imsmassi-memo-item-tags imsmassi-memo-item-footer",
  });

  const createdAreaName = getAreaName(memo.createdAreaId, memo.createdAreaId);
  const originBadge = createElement("span", {
    className: "imsmassi-memo-origin-badge",
  });
  originBadge.textContent = createdAreaName;

  const dateSpan = createElement("span", { className: "imsmassi-memo-date" });
  dateSpan.textContent = memo.date;

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
    className: `imsmassi-memo-action-btn imsmassi-toggle-label imsmassi-screen-btn${hasStickyNote ? " imsmassi-screen-btn-active" : ""}`,
    draggable: "false",
    title: `포스트잇 ${hasStickyNote ? "제거" : "추가"}`,
  });
  // 동적 컬러값(area.color)은 CSS 변수로 주입
  if (!hasStickyNote) {
    screenBtn.style.setProperty("--screen-btn-color", area.color);
    screenBtn.style.setProperty("--screen-btn-shadow", `${area.color}55`);
  }
  screenBtn.textContent = hasStickyNote ? "스티커삭제" : "스티커추가";
  screenBtn.addEventListener("click", () => createStickyNoteForMemo(memo.id));
  screenBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  const reminderBtn = createElement("button", {
    className: `imsmassi-memo-action-btn imsmassi-reminder-btn${memo.reminder ? " imsmassi-reminder-btn-active" : ""}`,
    draggable: "false",
    title: memo.reminder ? "리마인더 수정" : "리마인더 설정",
  });
  reminderBtn.textContent = "알림";
  reminderBtn.addEventListener("click", () => openReminderModal(memo.id));
  reminderBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  actionsDiv.append(screenBtn, reminderBtn);

  // 포스트잇이 현재 화면 밖에 위치한 경우 → 화면 밖 표시 뱃지
  if (isStickyOutOfView) {
    const outBadge = createElement("span", {
      className: "imsmassi-sticky-outofview-badge",
      title: "포스트잇이 현재 화면 밖에 위치합니다",
    });
    outBadge.textContent = "📍 화면 밖";
    actionsDiv.appendChild(outBadge);
  }

  footer.append(originBadge, dateSpan, actionsDiv);
  item.append(header, contentDiv, footer);
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
  const c = getColors();
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
    editorSection.style.setProperty("--memo-border-color", c.border);
    editorSection.style.setProperty("--memo-focus-color", area.color);
    editorSection.style.setProperty("--memo-focus-shadow", `${area.color}33`);
    editorSection.style.setProperty(
      "--memo-bg",
      state.isDarkMode ? "#191F28" : "#FFF",
    );
    editorSection.style.setProperty("--memo-text", c.text);
    editorSection.style.setProperty("--memo-placeholder", c.subText);
    editorSection.style.setProperty("--memo-icon-color", c.text);
    const editorDiv = createElement("div", {
      id: "imsmassi-memo-editor",
      className: "imsmassi-memo-editor",
    });
    const capacityDiv = createElement("div", {
      id: "imsmassi-memo-capacity",
      className: "imsmassi-memo-capacity",
    });
    Object.assign(capacityDiv.style, {
      position: "absolute",
      bottom: "6px",
      right: "12px",
      color: c.subText,
      pointerEvents: "none",
      zIndex: "10",
    });
    capacityDiv.textContent = "0 B / 2 MB";
    editorSection.append(editorDiv, capacityDiv);
  } else {
    editorSection = createElement("div");
    editorSection.style.position = "relative";
    const textarea = createElement("div", {
      className: "imsmassi-memo-textarea",
      id: "memo-input",
      contenteditable: "true",
      placeholder: `${area.name} 메모를 입력하세요.`,
    });
    Object.assign(textarea.style, {
      background: state.isDarkMode ? "#1A1A1A" : "#FFF",
      color: c.text,
      border: `2px solid ${c.border}`,
      minHeight: "140px",
      maxHeight: "300px",
      padding: "12px 40px 30px 12px",
      borderRadius: "8px",
      fontSize: "13px",
      lineHeight: "1.6",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      outline: "none",
      transition: "border-color 0.2s, box-shadow 0.2s",
      cursor: "text",
      overflowY: "auto",
    });
    textarea.addEventListener("paste", (e) => handleMemoPaste(e));
    textarea.addEventListener("keydown", (e) => handleMemoKeydown(e));
    textarea.addEventListener("input", () => updateMemoCapacity());
    textarea.addEventListener("blur", () => {
      textarea.style.borderColor = c.border;
      textarea.style.boxShadow = "none";
    });
    textarea.addEventListener("focus", () => {
      textarea.style.borderColor = area.color;
      textarea.style.boxShadow = `0 0 0 2px ${area.color}33`;
    });
    const capacityDiv = createElement("div", {
      id: "imsmassi-memo-capacity",
      className: "imsmassi-memo-capacity",
    });
    Object.assign(capacityDiv.style, {
      position: "absolute",
      bottom: "8px",
      right: "12px",
      color: c.subText,
      pointerEvents: "none",
    });
    capacityDiv.textContent = "0 B / 2 MB";
    editorSection.append(textarea, capacityDiv);
  }

  // ── 옵션 바 (추가 / 패널 토글) ──
  const optionsBar = createElement("div", {
    className: "imsmassi-memo-options",
  });
  optionsBar.style.justifyContent = "space-between";
  const addBtn = createElement("button", {
    className: "imsmassi-memo-option-btn",
  });
  Object.assign(addBtn.style, {
    fontWeight: "600",
  });
  addBtn.textContent = "메모등록";
  addBtn.addEventListener("click", addMemo);
  const sideToggleBtn = createElement("button", {
    className: "imsmassi-memo-option-btn imsmassi-memo-side-toggle-btn",
    id: "imsmassi-memo-side-toggle-btn",
  });
  Object.assign(sideToggleBtn.style, {
    fontWeight: "600",
  });
  sideToggleBtn.textContent = isExpanded ? "접기 ▸" : "펼치기 ◂";
  sideToggleBtn.addEventListener("click", toggleMemoSidePanel);
  optionsBar.append(addBtn, sideToggleBtn);

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
  Object.assign(clipboardCard.style, {
    borderColor: c.border,
    background: state.isDarkMode ? "#191F28" : "#FFF",
    height: "320px",
    minHeight: "240px",
    maxHeight: "420px",
    overflowY: "auto",
  });
  const clipboardCardHeader = createElement("div", {
    className: "imsmassi-memo-card-header",
  });
  Object.assign(clipboardCardHeader.style, {
    color: c.text,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: "32px",
  });
  const clipboardTitleSpan = createElement("span");
  clipboardTitleSpan.textContent = "클립보드";
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
  Object.assign(templateCard.style, {
    borderColor: c.border,
    background: state.isDarkMode ? "#191F28" : "#FFF",
    height: "320px",
    minHeight: "240px",
    maxHeight: "420px",
    overflowY: "auto",
  });
  const templateCardHeader = createElement("div", {
    className: "imsmassi-memo-card-header",
  });
  Object.assign(templateCardHeader.style, {
    color: c.text,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  });
  const templateTitleSpan = createElement("span");
  templateTitleSpan.textContent = "템플릿";
  const addTemplateBtn = createElement("button", {
    className: "imsmassi-memo-option-btn",
  });
  Object.assign(addTemplateBtn.style, {
    borderColor: area.color,
    fontWeight: "600",
  });
  addTemplateBtn.textContent = "✚ 추가";
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
  listHeader.style.color = c.subText;

  const filterBar = createElement("div", {
    className: "imsmassi-memo-filter-bar",
  });
  [
    ["menu", "현재 메뉴"],
    ["area", "현재 업무"],
    ["all", "전체"],
  ].forEach(([val, label]) => {
    const filterBtn = createElement("button", {
      className: `imsmassi-memo-filter-btn${currentFilter === val ? " imsmassi-memo-filter-active" : ""}`,
    });
    filterBtn.style.setProperty("--filter-color", area.color);
    filterBtn.textContent = label;
    filterBtn.addEventListener("click", () => setMemoFilter(val));
    filterBar.appendChild(filterBtn);
  });
  const memoCountSpan = createElement("span");
  Object.assign(memoCountSpan.style, { fontSize: "11px", marginLeft: "4px" });
  memoCountSpan.textContent = `메모 ${memos.length}건`;
  listHeader.append(filterBar, memoCountSpan);
  listArea.appendChild(listHeader);

  // 빈 메시지 헬퍼
  const makeEmptyMsg = (text) => {
    const msg = createElement("div");
    Object.assign(msg.style, {
      color: c.subText,
      fontSize: "13px",
      textAlign: "center",
      padding: "20px",
    });
    msg.textContent = text;
    return msg;
  };

  // 메모 목록 렌더링: renderMemoItemDOM 컴포넌트를 조립합니다.
  if (!isExpanded) {
    // 단일 리스트 모드
    if (memos.length === 0) {
      listArea.appendChild(makeEmptyMsg("메모가 없습니다"));
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
    unpinnedSubheader.style.color = c.subText;
    unpinnedSubheader.textContent = `일반 메모 (${unpinnedMemos.length}건)`;
    unpinnedCol.appendChild(unpinnedSubheader);
    if (unpinnedMemos.length === 0) {
      unpinnedCol.appendChild(makeEmptyMsg("일반 메모가 없습니다"));
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
    pinnedSubheader.style.color = c.subText;
    pinnedSubheader.textContent = `고정 메모 (${pinnedMemos.length}건)`;
    pinnedCol.appendChild(pinnedSubheader);
    if (pinnedMemos.length === 0) {
      pinnedCol.appendChild(makeEmptyMsg("고정 메모가 없습니다"));
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
  if (workerPort) {
    // Worker 상태에도 반영 → 이후 CONTEXT_CHANGE 등 STATE_UPDATE가 와도 필터가 초기화되지 않음
    workerSend("SAVE_UI_PREFS", { memoFilter: filter });
    // SAVE_UI_PREFS → broadcastState() → handleStateUpdate → renderAssistant() 로 리렌더링됨
  } else {
    // SharedWorker 미지원 폴백: 직접 DB 저장 후 리렌더링
    if (db)
      db.transaction("settings", "readwrite", (store) =>
        store.put(filter, "memoFilter"),
      ).catch(() => {});
    renderAssistantContent();
  }
}

function toggleMemoSidePanel() {
  state.isMemoPanelExpanded = !state.isMemoPanelExpanded;
  renderAssistantContent();
  // Worker 상태 동기화 — broadcastState()가 동일한 값을 전송하도록
  workerSend("SAVE_UI_PREFS", {
    isMemoPanelExpanded: state.isMemoPanelExpanded,
  });
}

function updateMemoSidePanelState() {
  const layout = document.getElementById("imsmassi-memo-layout");
  const floatingPanel = document.getElementById("imsmassi-floating-panel");
  if (!floatingPanel || !layout) return;
  const isHidden = !state.isMemoPanelExpanded;
  floatingPanel.classList.toggle("imsmassi-expanded", !isHidden);
  layout.classList.toggle("imsmassi-panel-hidden", isHidden);
  const toggle = document.getElementById("imsmassi-memo-side-toggle-btn");
  if (toggle) {
    toggle.textContent = isHidden ? "펼치기 ◂" : "접기 ▸";
  }
}

function toggleDashboardView() {
  if (state.activeTab === "dashboard") {
    setActiveTab("memo");
  } else {
    setActiveTab("dashboard");
  }
}

function updateDashboardButton() {
  const dashboardBtn = document.getElementById("assistant-dashboard-btn");
  if (!dashboardBtn) return;
  dashboardBtn.textContent =
    state.activeTab === "dashboard" ? "↩ 메인" : "대시보드";
  dashboardBtn.title =
    state.activeTab === "dashboard" ? "메인으로 돌아가기" : "대시보드";
  dashboardBtn.classList.toggle(
    "imsmassi-active",
    state.activeTab === "dashboard",
  );
}

// ========================================
// 클립보드 컴포넌트 (DOM 빌더)
// ========================================
/**
 * renderClipboardItemDOM(item) - 클립보드 아이템 하나의 DOM 요소를 생성합니다.
 * textContent를 사용하여 XSS를 원천 차단합니다.
 */
function renderClipboardItemDOM(item) {
  const c = getColors();
  const areaName = getAreaName(item.areaId, item.areaId);
  const relativeTime = item.timestamp
    ? getRelativeTime(item.timestamp)
    : item.time || "방금";

  const itemDiv = createElement("div", {
    className: "imsmassi-clipboard-item",
  });
  itemDiv.style.background = state.isDarkMode ? "#252525" : "#F8F9FA";
  itemDiv.addEventListener("click", () => copyToClipboard(item.content));

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-delete-btn",
  });
  deleteBtn.style.color = c.subText;
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteClipboardItem(item.id);
  });

  const contentDiv = createElement("div", {
    className: "imsmassi-clipboard-item-content",
  });
  Object.assign(contentDiv.style, { color: c.text, paddingRight: "24px" });
  contentDiv.textContent = item.content; // textContent로 XSS 방지

  const metaDiv = createElement("div", {
    className: "imsmassi-clipboard-item-meta",
  });
  metaDiv.style.color = c.subText;
  const areaSpan = createElement("span");
  areaSpan.textContent = areaName;
  const timeSpan = createElement("span");
  timeSpan.textContent = relativeTime;
  metaDiv.append(areaSpan, timeSpan);

  itemDiv.append(deleteBtn, contentDiv, metaDiv);
  return itemDiv;
}

/**
 * renderClipboardTabDOM() - 클립보드 탭 전체 DOM을 빌드하여 반환합니다.
 */
function renderClipboardTabDOM() {
  const c = getColors();
  const items = Array.isArray(state.clipboard) ? state.clipboard : [];
  const container = createElement("div");

  const header = createElement("div", {
    className: "imsmassi-clipboard-header",
  });
  header.style.color = c.subText;
  const headerSpan = createElement("span");
  headerSpan.textContent = "최근 복사 히스토리";
  header.appendChild(headerSpan);
  container.appendChild(header);

  if (items.length === 0) {
    const empty = createElement("div");
    Object.assign(empty.style, {
      color: c.subText,
      fontSize: "13px",
      textAlign: "center",
      padding: "20px",
    });
    empty.textContent = "복사 기록이 없습니다";
    container.appendChild(empty);
  } else {
    items.forEach((item) =>
      container.appendChild(renderClipboardItemDOM(item)),
    );
  }

  const hint = createElement("div", { className: "imsmassi-clipboard-hint" });
  hint.style.color = c.subText;
  hint.textContent = "클릭하면 클립보드에 복사됩니다";
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
  const area = getArea();
  const c = getColors();

  const itemDiv = createElement("div", { className: "imsmassi-template-item" });
  itemDiv.style.background = state.isDarkMode ? "#252525" : "#F8F9FA";
  itemDiv.addEventListener("click", () => useTemplate(template.id));

  const deleteBtn = createElement("button", {
    className: "imsmassi-memo-delete-btn",
  });
  deleteBtn.style.color = c.subText;
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTemplate(template.id);
  });

  const editBtn = createElement("button", {
    className: "imsmassi-template-edit-btn",
    title: "수정",
  });
  editBtn.style.color = c.subText;
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditTemplateModal(template.id);
  });

  const headerDiv = createElement("div", {
    className: "imsmassi-template-item-header",
  });
  headerDiv.style.paddingRight = "52px";
  const titleSpan = createElement("span", {
    className: "imsmassi-template-item-title",
  });
  titleSpan.style.color = c.text;
  titleSpan.textContent = template.title;
  const countSpan = createElement("span", {
    className: "imsmassi-template-item-count",
  });
  countSpan.style.color = c.subText;
  countSpan.textContent = `사용 ${template.count}회`;
  headerDiv.append(titleSpan, countSpan);

  const contentDiv = createElement("div", {
    className: "imsmassi-template-item-content",
  });
  Object.assign(contentDiv.style, {
    background: state.isDarkMode ? "#1E1E1E" : "#FFF",
    color: c.subText,
    borderColor: c.border,
  });
  contentDiv.textContent = template.content; // textContent로 XSS 방지

  itemDiv.append(deleteBtn, editBtn, headerDiv, contentDiv);
  return itemDiv;
}

/**
 * renderTemplateTabDOM() - 템플릿 탭 전체 DOM을 빌드하여 반환합니다.
 */
function renderTemplateTabDOM() {
  const c = getColors();
  const container = createElement("div");

  const listHeader = createElement("div", {
    className: "imsmassi-template-list-header",
  });
  listHeader.style.color = c.subText;
  listHeader.textContent = `자주 쓰는 문구 (${state.templates.length}건)`;
  container.appendChild(listHeader);

  state.templates.forEach((template) =>
    container.appendChild(renderTemplateItemDOM(template)),
  );
  return container;
}

// 하위 호환용 래퍼
function renderTemplateTab() {
  return renderTemplateTabDOM();
}

function renderTimeTab() {
  const area = getArea();
  const c = getColors();
  const periodMap = { today: "오늘", week: "이번 주", month: "이번 달" };
  const data = getTimeStats(state.timePeriod); // 실시간 데이터 가져오기

  let chartHtml = "";
  data.items.forEach((item) => {
    chartHtml += `
      <div class="imsmassi-time-chart-item" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; margin-top: 6px; border-radius: 8px; background: ${state.isDarkMode ? "#1F1F1F" : "#F6F7F9"};">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="width: 4px; height: 16px; border-radius: 2px; background: ${item.color}; display: inline-block;"></span>
          <span style="color: ${c.text}; font-size: 13px; font-weight: 600;">${item.name}</span>
        </div>
        <div style="display: inline-flex; align-items: center; gap: 10px;">
          <span style="color: ${c.text}; font-size: 12px; min-width: 72px; text-align: right;">${item.time}</span>
          <span style="color: ${c.subText}; font-size: 11px; padding: 4px 8px; background: ${state.isDarkMode ? "#2E2E2E" : "#EDEFF2"}; border-radius: 8px; min-width: 38px; text-align: center;">${item.percent}%</span>
        </div>
      </div>
    `;
  });

  let segmentBarHtml = "";
  data.items.forEach((item) => {
    segmentBarHtml += `
      <div title="${item.name}" style="flex: ${item.percent};  height: 38px; border-radius: 6px; background: ${item.color};"></div>
    `;
  });

  let periodBtnsHtml = "";
  Object.entries(periodMap).forEach(([key, label]) => {
    const isActive = state.timePeriod === key;
    periodBtnsHtml += `
      <button class="imsmassi-time-period-btn ${isActive ? "imsmassi-active" : ""}"
              style="min-width: 64px; padding: 6px 12px; border: 1px solid ${isActive ? area.color : c.border}; background: ${isActive ? (state.isDarkMode ? "#F5F5F5" : "#F5F5F5") : "transparent"}; color: ${isActive ? "#111" : c.subText}; border-radius: 8px; cursor: pointer; font-weight: ${isActive ? "600" : "500"}; font-size: 12px; transition: all 0.2s;"
              onclick="setTimePeriod('${key}')">
        ${label}
      </button>
    `;
  });

  // 기간별 설명 추가
  const periodDescMap = {
    today: "오늘 (자정부터 현재까지)",
    week: "이번 주 (일요일부터 현재까지)",
    month: "이번 달 (1일부터 현재까지)",
  };

  return `
    <div>
      <div class="imsmassi-time-summary" style="background: ${state.isDarkMode ? "#252525" : area.bgColor};">
        <div class="imsmassi-time-summary-label" style="color: ${c.subText};">${periodMap[state.timePeriod]} 총 업무 시간</div>
        <div class="imsmassi-time-summary-value" style="color: ${c.text};">${data.total}</div>
        <div style="font-size: 12px; color: ${c.subText}; margin-top: 6px;">${periodDescMap[state.timePeriod]}</div>
        <div style="display: flex; gap: 6px; margin: 12px 0 6px 0;">${segmentBarHtml}</div>
        <div class="imsmassi-time-period-btns" style="display: flex; justify-content: center; gap: 8px; margin: 4px 0 0 0;">${periodBtnsHtml}</div>
        <div class="imsmassi-time-summary-label" style="color: ${c.subText}; margin-top: 14px;">메뉴별 체류 시간</div>
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
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid ${c.border};">
        <div style="display:flex;align-items:center;gap:4px;min-width:70px;max-width:100px;flex-shrink:0;">
          <span style="width:8px;height:8px;border-radius:50%;background:${primary};display:inline-block;flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,0.1);"></span>
          <span style="font-size:10px;color:${c.text};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${getAreaName(area.id, area.id)}">${getAreaName(area.id, area.id)}</span>
        </div>
        <label style="display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer;">
          <span style="font-size:9px;color:${c.subText};">메인</span>
          <input type="color" value="${primary}" onchange="onAreaColorChange('${area.id}','primary',this.value)"
            style="width:30px;height:22px;border:1px solid ${c.border};padding:1px;cursor:pointer;border-radius:3px;background:none;">
        </label>
        <label style="display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer;">
          <span style="font-size:9px;color:${c.subText};">서브1</span>
          <input type="color" value="${sub1}" onchange="onAreaColorChange('${area.id}','sub1',this.value)"
            style="width:30px;height:22px;border:1px solid ${c.border};padding:1px;cursor:pointer;border-radius:3px;background:none;">
        </label>
        <label style="display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer;">
          <span style="font-size:9px;color:${c.subText};">서브2</span>
          <input type="color" value="${sub2}" onchange="onAreaColorChange('${area.id}','sub2',this.value)"
            style="width:30px;height:22px;border:1px solid ${c.border};padding:1px;cursor:pointer;border-radius:3px;background:none;">
        </label>
        <div style="flex:1;"></div>
        ${hasCustom ? `<button onclick="resetAreaColors('${area.id}')" title="기본값으로 초기화" style="font-size:10px;background:none;border:1px solid ${c.border};border-radius:3px;padding:2px 6px;cursor:pointer;color:${c.subText};">↩</button>` : ""}
      </div>
    `;
    })
    .join("");

  return `
    <div class="imsmassi-area-color-legend">
      메인: 탭·버튼·강조선 &nbsp;/&nbsp; 서브1: 배경 틴트 &nbsp;/&nbsp; 서브2: 포스트잇 배경
    </div>
    ${rows}
  `;
}

function renderDashboardTab() {
  const area = getArea();
  const c = getColors();
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
    if (daysSinceBackup >= 7) {
      backupBannerHtml = `
        <div class="imsmassi-dashboard-banner imsmassi-dashboard-banner-backup">
          <span class="imsmassi-dashboard-banner-icon">💾</span>
          <div class="imsmassi-dashboard-banner-body">
            <div class="imsmassi-dashboard-banner-title imsmassi-dashboard-banner-title-backup">데이터 백업을 권장합니다</div>
            <div class="imsmassi-dashboard-banner-desc imsmassi-dashboard-banner-desc-backup">마지막 백업: ${daysSinceBackup}일 전</div>
          </div>
          <button class="imsmassi-dashboard-banner-btn imsmassi-dashboard-banner-btn-backup" onclick="exportAllData()">백업</button>
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
        <span class="imsmassi-dashboard-banner-icon">⚠️</span>
        <div class="imsmassi-dashboard-banner-body">
          <div class="imsmassi-dashboard-banner-title imsmassi-dashboard-banner-title-storage">저장 용량이 부족합니다</div>
          <div class="imsmassi-dashboard-banner-desc imsmassi-dashboard-banner-desc-storage">${state.storageUsed.toFixed(1)}MB / ${state.storageLimit}MB (${usagePercent.toFixed(0)}%)</div>
        </div>
        <button class="imsmassi-dashboard-banner-btn imsmassi-dashboard-banner-btn-storage" onclick="openSettingsModal()">관리</button>
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
      const areaName = getAreaName(todo.areaId, todo.areaId);
      todayTodosHtml += `
        <div class="imsmassi-todo-item">
          <span class="imsmassi-todo-checkbox ${todo.done ? "imsmassi-checked imsmassi-checked-done" : ""}"
                onclick="toggleTodo('${todo.id}')">
            ${todo.done ? "✓" : ""}
          </span>
          <span class="imsmassi-todo-text ${todo.done ? "imsmassi-done imsmassi-todo-text-done" : "imsmassi-todo-text-pending"}">${todo.title ? `<strong>${todo.title}</strong>` : ""}</span>
          <span class="imsmassi-todo-area-name">${areaName}</span>
          <span class="imsmassi-todo-time ${todo.done ? "imsmassi-todo-time-done" : "imsmassi-todo-time-active"}">${todo.reminder}</span>
        </div>
      `;
    });
  }

  let pastTodosHtml = "";
  if (pastReminders && pastReminders.length > 0) {
    pastReminders.forEach((todo) => {
      if (!todo || !todo.id) return; // null 체크
      const areaName = getAreaName(todo.areaId, todo.areaId);
      pastTodosHtml += `
        <div class="imsmassi-todo-item">
          <span class="imsmassi-todo-checkbox ${todo.done ? "imsmassi-checked imsmassi-checked-done" : ""}"
                onclick="toggleTodo('${todo.id}')">
            ${todo.done ? "✓" : ""}
          </span>
          <span class="imsmassi-todo-text ${todo.done ? "imsmassi-done imsmassi-todo-text-done" : "imsmassi-todo-text-pending"}">${todo.title ? `<strong>${todo.title}</strong>` : ""}</span>
          <span class="imsmassi-todo-area-name">${areaName}</span>
          <span class="imsmassi-todo-date">${todo.reminderDate}</span>
        </div>
      `;
    });
  }

  const emptyTodayHtml =
    todayReminders.length === 0
      ? `<div class="imsmassi-dashboard-empty">오늘 할 일이 없습니다</div>`
      : "";
  const emptyPastHtml =
    pastReminders.length === 0
      ? `<div class="imsmassi-dashboard-empty">지난 할 일이 없습니다</div>`
      : "";

  // 최근 메모
  let recentMemosHtml = "";
  const allMemos = [];
  // state.memos는 객체 구조: {memoId: memoData}
  Object.values(state.memos || {}).forEach((memo) => {
    allMemos.push(memo);
  });
  allMemos
    .sort((a, b) => {
      const aCreated = Number(a.createdAt || 0);
      const bCreated = Number(b.createdAt || 0);
      if (bCreated !== aCreated) return bCreated - aCreated;
      return new Date(b.date || 0) - new Date(a.date || 0);
    })
    .slice(0, 2)
    .forEach((memo) => {
      const areaName = getAreaName(memo.createdAreaId, memo.createdAreaId);
      const memoPreview = getMemoPlainText(memo);
      recentMemosHtml += `
      <div class="imsmassi-recent-memo-item" onclick="setSelectedArea('${memo.createdAreaId}'); goToMemoTab();">
        <div class="imsmassi-recent-memo-menu" style="color: ${area.color};">${areaName}</div>
        <div class="imsmassi-recent-memo-text">${memoPreview}</div>
      </div>
    `;
    });

  // 테스트 버튼 영역
  const testButtonsHtml = `
    <div style="margin-bottom: 16px; padding: 12px; background: ${state.isDarkMode ? "#1a2a1a" : "#F0FFF0"}; border: 1px dashed ${state.isDarkMode ? "#4a6a4a" : "#90EE90"}; border-radius: 8px;">
      <div style="font-size: 11px; color: ${state.isDarkMode ? "#90EE90" : "#228B22"}; margin-bottom: 8px; font-weight: 600;">🧪 상태 시뮬레이션 (테스트용)</div>
      <div style="display: flex; gap: 6px; imsmassi-flex-wrap: wrap;">
        <button style="padding: 5px 10px; font-size: 10px; background: #FFF3CD; color: #856404; border: 1px solid #F0D78C; border-radius: 4px; cursor: pointer;" onclick="simulateBackupWarning()">백업 경고</button>
        <button style="padding: 5px 10px; font-size: 10px; background: #F8D7DA; color: #721C24; border: 1px solid #F5C6CB; border-radius: 4px; cursor: pointer;" onclick="simulateStorageWarning()">용량 부족</button>
        <button style="padding: 5px 10px; font-size: 10px; background: #FFE4B5; color: #8B4513; border: 1px solid #DEB887; border-radius: 4px; cursor: pointer;" onclick="simulateBothWarnings()">둘 다</button>
        <button style="padding: 5px 10px; font-size: 10px; background: #E8F5E9; color: #2E7D32; border: 1px solid #A5D6A7; border-radius: 4px; cursor: pointer;" onclick="simulateNormal()">정상</button>
      </div>
    </div>
  `;
  // ${testButtonsHtml}
  // ${backupBannerHtml}
  return `
    <div>
      ${storageWarningHtml}
      <div class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span> 오늘 할 일</span> 
        </div>
        ${todayTodosHtml}
        ${emptyTodayHtml}
      </div>
      ${
        pastReminders && pastReminders.length > 0
          ? `
      <div class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span> 지난 일</span> 
        </div>
        ${pastTodosHtml}
      </div>
      `
          : ""
      }
      <div class="imsmassi-dashboard-section">
        <div class="imsmassi-dashboard-section-header">
          <span> 최근 메모</span> 
        </div>
        ${recentMemosHtml || `<div class="imsmassi-dashboard-empty">메모가 없습니다</div>`}
      </div>
    </div>

    ${
      state.settings?.showAreaColorSection !== false
        ? `
    <div class="imsmassi-dashboard-section">
      <div class="imsmassi-dashboard-section-header">
        <span>🎨 업무 컬러 설정</span>
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
        <span> 시간 인사이트</span>
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
  if (e.key === "Enter" && state.currentModal) {
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
  // Escape: 모달/어시스턴트 닫기
  if (e.key === "Escape") {
    if (state.currentModal) {
      closeModal();
    } else if (state.assistantOpen) {
      closeAssistant();
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

// ========================================
// 초기 스타일 설정 (로딩 중 깨짐 방지)
// ========================================
function initializeStyles() {
  const theme = getTheme();
  const c = getColors();

  // 이식(embedded) 모드에서 호스트 페이지 바닥화면 보호:
  // getAssistantRoot()가 mf_VFrames_Root 등 호스트 컨테이너를 반환할 수 있으므로
  // #assistant-root 스코프 요소에만 배경/글자색을 적용하고, 호스트 컨테이너에는 미적용.
  const root = getAssistantRoot();
  if (!root) return;
  const assistantScopeEl = document.getElementById("assistant-root");
  // #assistant-root가 존재하면 이식 모드 → 호스트 컨테이너에 배경색 적용 금지
  // #assistant-root가 없거나 root 자체가 #assistant-root인 경우(standalone)만 적용
  if (!assistantScopeEl || root === assistantScopeEl) {
    root.style.backgroundColor = c.bg;
    root.style.color = c.text;
  }
  applyLowSpecMode();

  // 시스템 미리보기 초기 스타일
  const preview = document.getElementById("imsmassi-system-preview");
  if (preview) {
    preview.style.background = c.bg;
    preview.style.border = `1px solid ${c.border}`;
  }

  // 헤더 초기 스타일
  const header = document.getElementById("imsmassi-header");
  if (header) {
    header.style.background = state.isDarkMode
      ? theme.primaryDark
      : theme.primary;
    header.style.color = c.headerText;
  }

  // 플로팅 패널 초기 스타일
  const panel = document.getElementById("imsmassi-floating-panel");
  if (panel) {
    panel.style.background = c.bg;
  }

  // 카드 배경색
  const cards = document.querySelectorAll(".imsmassi-card");
  cards.forEach((card) => {
    card.style.background = c.bg;
    card.style.color = c.text;
    card.style.borderColor = c.border;
  });
}

// ========================================
// 페이지 초기화 및 IndexedDB 설정
// ========================================
var assistantInitialized = window.assistantInitialized || false;

// ========================================
// Shared Worker 연결 초기화
// ========================================
/**
 * Shared Worker에 연결합니다.
 * Worker로부터의 메시지(STATE_UPDATE, TOAST, EXPORT_DATA_RESULT)를 수신하여 처리합니다.
 * @param {string} workerPath - assistant-worker.js 경로
 * @param {string} [loginId] - 사용자 로그인 ID (DB 격리에 사용)
 */
function connectToWorker(workerPath, loginId, initialContext = {}) {
  try {
    const worker = new SharedWorker(workerPath, { name: "assistant-worker" });
    workerPort = worker.port;

    workerPort.addEventListener("message", (event) => {
      const { type, payload } = event.data || {};
      switch (type) {
        case "STATE_UPDATE":
          handleStateUpdate(payload);
          break;
        case "TOAST":
          showToast(payload?.message || "");
          break;
        case "EXPORT_DATA_RESULT":
          downloadExportData(payload?.data);
          break;
        case "TEMPLATE_SUGGEST":
          // 모달이 이미 열려있으면 무시
          if (!state.currentModal) {
            openModal("templateSuggest", {
              suggestedText: payload?.suggestedText || "",
            });
          }
          break;
        default:
          console.warn("[Assistant] Worker로부터 알 수 없는 메시지:", type);
      }
    });

    workerPort.start();
    // INIT 메시지로 초기 상태 요청 (initialContext 포함 → 레이스 없이 원자적 컨텍스트 설정)
    workerPort.postMessage({
      type: "INIT",
      payload: { loginId, ...initialContext },
    });
    console.log("[Assistant] SharedWorker 연결 완료:", workerPath);
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
  console.warn("[Assistant] 폴백 모드: IndexedDB 직접 접근");
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
  console.log("[Assistant] 초기화 시작 (Shared Worker 모드)...");

  // 1단계: 초기 스타일 적용 (깨짐 방지)
  initializeStyles();
  renderAll();

  // 2단계: Shared Worker 연결
  // 초기 컨텍스트(menuId/areaId)를 INIT 페이로드에 포함 → 비동기 레이스 없이 원자적 처리
  // (별도 CONTEXT_CHANGE 메시지를 보내면 INIT의 await ensureInit() 도중 선처리되어 덮어쓰이는 문제 방지)
  const workerPath = config.workerPath || "assistant/assistant-worker.js";
  const _selCfg = config.stickyLayerSelectors;
  const _initialCtx = {};
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
      console.log(
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

  // 5단계: 앱 구동 5초 후 백그라운드 자동 정리 (오래된 데이터 제거)
  setTimeout(() => {
    if (typeof runAutoCleanup === "function") {
      runAutoCleanup({ silent: true, refreshUI: true, reason: "startup" });
    }
  }, 5000);

  console.log("[Assistant] 초기화 완료 (Shared Worker 연결 중)");
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
    notifyActive(document.visibilityState === "visible");
  });

  // 창 포커스 이벤트: 같은 브라우저 내 다른 창으로 전환 감지
  window.addEventListener("focus", () => notifyActive(true));
  window.addEventListener("blur", () => notifyActive(false));
})();

// 페이지 닫기 전 Worker에 저장 요청
window.addEventListener("beforeunload", () => {
  if (!window.assistantInitialized) return;
  // Worker에게 저장 요청 (sync-over-async 불필요, Worker가 자체 처리)
  workerSend("BEFORE_UNLOAD", {});
  stopReminderSystem();
  // 컨텍스트 옵저버 해제
  if (_contextObserver) {
    _contextObserver.disconnect();
    _contextObserver = null;
  }
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
 * @param {string} key - 'areaColor', 'timeInsight', 'markdown', 'debugLog', 'autoNav', 'lowSpec'
 * @param {boolean} visible - 노출 여부 (true: 표시, false: 숨김)
 *
 * 사용 예시 (브라우저 콘솔):
 *   toggleAssistantHiddenUI('lowSpec', true);    // 저사양 모드 섹션 표시
 *   toggleAssistantHiddenUI('areaColor', true);  // 업무 컬러 설정 표시
 *   toggleAssistantHiddenUI('markdown', false);  // 마크다운 단축키 숨김
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
      lowSpec: false,
    };
  }

  if (key in state.hiddenUI) {
    state.hiddenUI[key] = !!visible;
    console.log(`[Assistant] 설정 UI '${key}' 상태가 ${visible ? '표시' : '숨김'}로 변경되었습니다.`);

    // UI 즉각 반영 (설정 모달이 열려있거나 설정 탭인 경우 리렌더링)
    if (state.currentModal === "settings") {
      openModal("settings");
    } else if (state.activeTab === "settings") {
      renderAssistantContent();
    }
  } else {
    console.warn(`[Assistant] 유효하지 않은 키입니다. 사용 가능한 키: ${Object.keys(state.hiddenUI).join(", ")}`);
  }
};

// ========================================
// 패널 높이 리사이즈
// ========================================
/**
 * 패널 상단 가장자리를 드래그하여 높이 조절.
 * top 위치를 고정(right/fixed)하고 height 만 변경합니다.
 */
function initPanelResize(panel) {
  // 기존 핸들이 있으면 제거
  const existing = panel.querySelector('.imsmassi-panel-resize-handle');
  if (existing) existing.remove();

  const handle = document.createElement('div');
  handle.className = 'imsmassi-panel-resize-handle';
  handle.title = '높이 조절';
  panel.prepend(handle);

  const MIN_H = 300;
  const MAX_H_OFFSET = 40; // 뷰포트 상단 여유

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.offsetHeight;

    function onMove(ev) {
      const delta = startY - ev.clientY; // 위로 드래그 → 높이 증가
      const newH = Math.min(
        Math.max(startH + delta, MIN_H),
        window.innerHeight - MAX_H_OFFSET
      );
      state.panelHeight = newH;
      panel.style.height = `${newH}px`;
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // DB 저장
      workerSend('SAVE_UI_PREFS', { panelHeight: state.panelHeight });
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 더블클릭: 기본 높이 복원
  handle.addEventListener('dblclick', () => {
    state.panelHeight = null;
    panel.style.height = '';
    workerSend('SAVE_UI_PREFS', { panelHeight: null });
  });
}

// ========================================
// 온보딩 가이드 (5단계)
// ========================================
const AssistantGuide = {
  steps: [
    {
      targetSelector: '#imsmassi-floating-btn',
      title: '어시스턴트 시작하기',
      description: '이 버튼을 클릭하여 솔로몬 어시스턴트를 열어보세요. 업무 중 언제든 메모를 기록할 수 있습니다.',
      beforeNext: async function () {
        if (!state.assistantOpen) {
          openAssistant();
          await new Promise((r) => setTimeout(r, 450));
        }
      },
    },
    {
      targetSelector: '.ql-editor, #memo-input',
      title: '화면 맞춤 메모 작성',
      description: '현재 보고 있는 화면과 관련된 메모를 작성해보세요. 빠르게 등록할 수 있습니다.',
      beforeNext: null,
    },
    {
      targetSelector: '.imsmassi-screen-btn',
      title: '포스트잇(스티커) 기능',
      description: '작성한 메모를 포스트잇처럼 화면 위에 띄워둘 수 있습니다. 위치와 크기를 자유롭게 조절하며 업무에 활용해 보세요.',
      beforeNext: null,
    },
    {
      targetSelector: '#imsmassi-memo-side-toggle-btn',
      title: '클립보드 & 템플릿',
      description: '사이드 패널을 열어 복사한 텍스트 기록을 확인하거나, 자주 쓰는 양식을 템플릿으로 저장해 원클릭으로 활용하세요.',
      beforeNext: async function () {
        if (!state.isMemoPanelExpanded) {
          toggleMemoSidePanel();
          await new Promise((r) => setTimeout(r, 300));
        }
      },
    },
    {
      targetSelector: '.imsmassi-reminder-btn',
      title: '⏰ 잊지 않게 리마인더',
      description: '메모에 알림을 설정해 보세요! 원하는 시간에 맞춰 바탕화면 알림과 대시보드 할 일 목록으로 리마인드 해줍니다.',
      beforeNext: null,
    },
  ],

  currentStep: 0,
  overlayEl: null,
  spotlightEl: null,
  tooltipEl: null,
  _resizeHandler: null,
  _active: false,
  _padding: 10,

  start() {
    if (this._active) return;
    this._active = true;
    this.currentStep = 0;
    this._createDOM();
    this._renderStep();
    console.log('[Assistant] 온보딩 가이드 시작');
  },

  _createDOM() {
    this._cleanup();
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'imsmassi-guide-overlay';

    this.spotlightEl = document.createElement('div');
    this.spotlightEl.className = 'imsmassi-guide-spotlight';

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'imsmassi-guide-tooltip';

    document.body.appendChild(this.overlayEl);
    document.body.appendChild(this.spotlightEl);
    document.body.appendChild(this.tooltipEl);

    this._resizeHandler = () => this._positionElements();
    window.addEventListener('resize', this._resizeHandler);
    window.addEventListener('scroll', this._resizeHandler, true);
  },

  _getTarget(selector) {
    if (!selector) return null;
    for (const sel of selector.split(',').map((s) => s.trim())) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  },

  _renderStep() {
    const step = this.steps[this.currentStep];
    const total = this.steps.length;
    const isLast = this.currentStep === total - 1;
    const isFirst = this.currentStep === 0;
    const target = this._getTarget(step.targetSelector);

    this._positionSpotlight(target);

    const dots = Array.from({ length: total }, (_, i) =>
      `<span class="imsmassi-guide-dot${i === this.currentStep ? ' imsmassi-guide-dot-active' : ''}"></span>`
    ).join('');

    this.tooltipEl.innerHTML = `
      <div class="imsmassi-guide-progress">${dots}</div>
      <div class="imsmassi-guide-title">${step.title}</div>
      <div class="imsmassi-guide-desc">${step.description}</div>
      <div class="imsmassi-guide-controls">
        <button class="imsmassi-guide-btn imsmassi-guide-btn-skip" onclick="AssistantGuide.skip()">건너뛰기</button>
        <div class="imsmassi-guide-nav">
          ${!isFirst ? `<button class="imsmassi-guide-btn imsmassi-guide-btn-prev" onclick="AssistantGuide.prev()">이전</button>` : ''}
          <button class="imsmassi-guide-btn imsmassi-guide-btn-next${isLast ? ' imsmassi-guide-btn-finish' : ''}" onclick="AssistantGuide.next()">
            ${isLast ? '시작하기 🎉' : '다음 →'}
          </button>
        </div>
      </div>
    `;

    requestAnimationFrame(() => this._positionTooltip(target));
  },

  _positionElements() {
    const step = this.steps[this.currentStep];
    const target = this._getTarget(step.targetSelector);
    this._positionSpotlight(target);
    this._positionTooltip(target);
  },

  _positionSpotlight(target) {
    if (!this.spotlightEl) return;
    if (!target) {
      this.spotlightEl.style.cssText =
        'position:fixed;top:50%;left:50%;width:0;height:0;border-radius:8px;' +
        'box-shadow:0 0 0 9999px rgba(0,0,0,0.65);z-index:99999;pointer-events:none;';
      return;
    }
    const r = target.getBoundingClientRect();
    const p = this._padding;
    this.spotlightEl.style.cssText = [
      'position:fixed',
      `top:${r.top - p}px`,
      `left:${r.left - p}px`,
      `width:${r.width + p * 2}px`,
      `height:${r.height + p * 2}px`,
      'border-radius:8px',
      'box-shadow:0 0 0 9999px rgba(0,0,0,0.65)',
      'z-index:99999',
      'pointer-events:none',
      'transition:top 0.3s ease,left 0.3s ease,width 0.3s ease,height 0.3s ease',
    ].join(';');
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
        top = r.bottom + p + gap; left = cx - tw / 2;
      } else if (r.top - p - gap - th >= 0) {
        top = r.top - p - gap - th; left = cx - tw / 2;
      } else if (r.right + p + gap + tw <= vw) {
        top = r.top + r.height / 2 - th / 2; left = r.right + p + gap;
      } else {
        top = r.top + r.height / 2 - th / 2; left = r.left - p - gap - tw;
      }
      left = Math.max(16, Math.min(left, vw - tw - 16));
      top  = Math.max(16, Math.min(top,  vh - th - 16));
    }
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top  = `${top}px`;
  },

  async next() {
    const step = this.steps[this.currentStep];
    if (typeof step.beforeNext === 'function') {
      await step.beforeNext();
    }
    if (this.currentStep < this.steps.length - 1) {
      this.currentStep++;
      this._renderStep();
    } else {
      this._finish();
    }
  },

  prev() {
    if (this.currentStep > 0) {
      this.currentStep--;
      this._renderStep();
    }
  },

  skip() {
    this._finish();
  },

  replay() {
    // 기존 보임 상태와 관계없이 지금 즐더 다시보기 (\ub2e4시보기 단추 트리거)
    this._active = false; // 새로 시작 허용
    this.start();
  },

  _finish() {
    this._active = false;
    this._cleanup();
    workerSend('MARK_GUIDE_SEEN', {});
    state.hasSeenGuide = true;
    console.log('[Assistant] 온보딩 가이드 완료');
  },

  _cleanup() {
    if (this.overlayEl)   { this.overlayEl.remove();   this.overlayEl   = null; }
    if (this.spotlightEl) { this.spotlightEl.remove();  this.spotlightEl = null; }
    if (this.tooltipEl)   { this.tooltipEl.remove();   this.tooltipEl   = null; }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      window.removeEventListener('scroll', this._resizeHandler, true);
      this._resizeHandler = null;
    }
  },
};