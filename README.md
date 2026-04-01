# 솔로몬시스템 어시스턴트 (Solomon System Assistant)

> 보험사 업무 프로세스 관리 UI — 메모·포스트잇·클립보드·리마인더를 지원하는 독립형 플로팅 어시스턴트  
> **최종 업데이트:** 2026-04-01 | **assistant.js** 8,799 lines

---

## 📁 프로젝트 구조

```
assistant_dev/
├── assistant_demo.html          # 통합 데모 / 배포 연동 가이드 포함
├── README.md
└── vendor/
    ├── assistant-loader.js      # 비동기 로더 (loadAssistant 진입점)
    ├── asset/                   # 폰트(Pretendard) · 이미지
    ├── assistant/
    │   ├── assistant.js         # 프론트엔드 코어 (335 KB)
    │   ├── assistant.css        # 스타일 (109 KB)
    │   ├── assistant-fragment.html  # UI 마크업 템플릿
    │   ├── assistant-worker.js  # SharedWorker — IndexedDB I/O (68 KB)
    │   └── i18n/
    │       ├── ko-kr.json
    │       └── en-us.json
    ├── purify/purify.min.js     # XSS 방지 (DOMPurify)
    └── quill/                   # 리치 텍스트 에디터
        ├── quill.min.js
        ├── quill.bubble.css
        ├── quill-better-table.min.js
        ├── quill-better-table.css
        └── quill-markdown-shortcuts.js
```

---

## 🚀 구동 방법

### VS Code Live Server (권장)
1. VS Code에서 `assistant_demo.html` 열기
2. 우측 하단 **Go Live** 클릭

> ⚠️ SharedWorker · IndexedDB · Crypto API(AES-256-GCM)는 `file://`에서 동작하지 않으므로 반드시 HTTP 서버를 통해 실행하세요.

---

## 🏗️ 아키텍처

### 계층 구조

```
호스트 시스템 (웹스퀘어 등)
    │
    ├─ loadAssistant(config)     ← assistant-loader.js
    │       ↓
    ├─ bootstrapAssistant(cfg)   ← assistant.js Section 1
    │       ↓
    ├─ SharedWorker              ← assistant-worker.js
    │       ↓ IndexedDB I/O
    └─ window.assistantBridge    ← 외부 제어 API
```

### assistant.js 섹션 구성

| 섹션 | 역할 | 수정 가능 여부 |
|------|------|--------------|
| Section 1 — Configuration | `AssistantConfig`, `assistantBridge`, IoC config 보존 | ✅ 자유 수정 |
| Section 2 — Worker Communication | `workerSend`, `_WORKER_HOOK_MAP`, `_runHook` | ⚠️ 주의 |
| Section 3 — Global State | `state`, 상수, `handleStateUpdate` | ❌ 수정 금지 |
| Section 4 — Core Utilities | DOM 헬퍼, i18n(`t()`), 암호화 | ⚠️ 주의 |
| Section 5 — Layout & Lifecycle | `bootstrapAssistant`, sticky-layer 옵저버 | ❌ 수정 금지 |
| Section 6 — Memo & Sticky Notes | 메모 CRUD, 포스트잇 렌더링 | ⚠️ 주의 |
| Section 7 — Clipboard & Templates | 클립보드, 템플릿 CRUD | ⚠️ 주의 |
| Section 8 — Reminders · Time Tracking | 리마인더, 알림, 업무 시간 기록 | ⚠️ 주의 |
| Section 9 — Modals & Settings | 모달, 설정 패널, 히든 UI | ⚠️ 주의 |

---

## ⚙️ 주요 기능

| 기능 | 설명 |
|------|------|
| **메모** | 리치텍스트(Quill) · 마크다운 · 할일 체크 · 즐겨찾기 · 화면 라벨 |
| **포스트잇** | 화면 위 오버레이 · 드래그 배치 · 리사이즈 · 화면별 독립 관리 |
| **클립보드** | 텍스트/그리드 외부 주입(`pushText`, `pushGridData`) · 7일 자동 정리 |
| **템플릿** | 재사용 텍스트 블록 · 자동완성 제안 |
| **리마인더** | 일시/반복 알림 · SharedWorker 폴링(5초) |
| **다국어** | `ko-kr` / `en-us` · `getLocale` 옵저버로 자동 감지 |
| **테마** | 4가지 컬러 테마 × 라이트/다크 모드 |
| **암호화** | AES-256-GCM으로 사용자 정보 IndexedDB 저장 (HTTPS 전용) |

---

## 🔌 배포 연동 (최소 예시)

```html
<div id="assistant-mount"></div>
<script src="vendor/assistant-loader.js"></script>
<script>
  (function () {
    const _prev = window.onload;
    window.onload = async function () {
      if (typeof _prev === 'function') await _prev();
      loadAssistant({
        mountId:  'assistant-mount',
        loginId:  gcm.gv_USER_ID,
        locale:   'ko-kr',
        jsPath:   'vendor/assistant/assistant.js',
        cssPath:  'vendor/assistant/assistant.css',
        htmlPath: 'vendor/assistant/assistant-fragment.html',
        stickyLayerSelectors: {
          windowContainerClass: 'w2windowContainer_selectedNameLayer',
          getMenuId: () => window.getActiveMenuId?.(),
          getAreaId: (menuId) => menuId.split('-')[0],
        },
      });
    };
  })();
</script>
```

> 전체 옵션은 `assistant_demo.html` 및 `DEVELOPER_GUIDE.md`를 참조하세요.

---

## 🗄️ IndexedDB 스키마

| 스토어 | 키 | 용도 |
|--------|----|------|
| `memos` | memoId | 메모 본문 · 라벨 · 포스트잇 |
| `clipboard` | auto | 클립보드 (7일 자동 삭제) |
| `templates` | templateId | 재사용 텍스트 블록 |
| `settings` | key-value | 테마 · 다크모드 · UI 설정 |
| `metadata` | key-value | lastBackup 등 시스템 정보 |

---

## 🛠️ 개발 환경

| 항목 | 내용 |
|------|------|
| 브라우저 | Chrome 90+ / Edge 90+ |
| 빌드 도구 | 없음 — 파일 직접 수정 후 새로고침 |
| 번들러 | 미사용 (uglify 배포 시 `DEVELOPER_GUIDE.md` 참조) |
| 의존성 설치 | 불필요 — 모든 라이브러리 `vendor/`에 포함 |

---

## 🔄 Git 워크플로우

```bash
git clone https://github.com/sincereperson/assistant.git
cd assistant_dev
# Live Server로 확인 후
git add .
git commit -m "작업 내용"
git push
```

| 브랜치 | 용도 |
|--------|------|
| `main` | 배포 안정 버전 |
| `feature/*` | 기능 개발 |
| `fix/*` | 버그 수정 |
