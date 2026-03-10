# 솔로몬시스템 어시스턴트 (Solomon System Assistant)

> 보험사 업무 프로세스 관리 UI — 실시간 업무 추적, 메모 관리, 다중 테마를 지원하는 플로팅 어시스턴트

---

## 📁 프로젝트 구조

```
assistant/
├── 솔로몬시스템_어시스턴트_데모.html   # 메인 앱 (단일 페이지)
├── vendor/
│   ├── assistant-loader.js              # 어시스턴트 로더
│   ├── assistant/
│   │   ├── assistant-fragment.html      # 어시스턴트 UI 템플릿
│   │   ├── assistant.js                 # 어시스턴트 핵심 로직
│   │   ├── assistant.css                # 어시스턴트 스타일
│   │   └── assistant-worker.js          # 백그라운드 워커
│   ├── purify/
│   │   └── purify.min.js                # XSS 방지 라이브러리 (DOMPurify)
│   └── quill/
│       ├── quill.min.js                 # Quill 에디터
│       ├── quill.bubble.css
│       ├── quill-better-table.min.js    # 테이블 기능 확장
│       ├── quill-better-table.css
│       └── quill-markdown-shortcuts.js  # 마크다운 단축키
└── README.md
```

---

## 🚀 구동 방법

### 방법 1: VS Code Live Server (권장)
1. VS Code에서 `솔로몬시스템_어시스턴트_데모.html` 파일 오픈
2. 우측 하단 **Go Live** 버튼 클릭
3. 브라우저에서 자동으로 열림

### 방법 2: 브라우저에서 직접 열기
1. `솔로몬시스템_어시스턴트_데모.html` 파일을 Chrome 브라우저로 드래그하여 열기

> ⚠️ IndexedDB 사용으로 인해 `file://` 프로토콜에서는 일부 기능이 제한될 수 있으므로 Live Server 사용을 권장합니다.

---

## 🛠️ 개발 환경 구성

### 필수 환경
| 항목 | 버전/설명 |
|------|----------|
| 브라우저 | Chrome 90+ / Edge 90+ (IndexedDB 지원 필요) |
| VS Code | 최신 버전 권장 |
| Git | 형상관리용 |

### 권장 VS Code 확장
| 확장명 | 용도 |
|--------|------|
| **Live Server** (`ritwickdey.liveserver`) | 로컬 개발 서버 (권장) |
| **GitHub Copilot** | AI 코드 보조 |

### 의존성 라이브러리 (모두 vendor 폴더에 로컬 포함)
| 라이브러리 | 용도 |
|-----------|------|
| Quill.js | 리치 텍스트 에디터 |
| DOMPurify | XSS 방지 |
| quill-better-table | 테이블 기능 확장 |

> ✅ 별도 `npm install` 불필요 — 모든 라이브러리가 `vendor/` 폴더에 포함되어 있습니다.

---

## 🏗️ 기술 스택

- **Frontend:** 순수 HTML / CSS / JavaScript (프레임워크 없음)
- **데이터 저장:** IndexedDB (메모, 템플릿, 클립보드, 설정 등 영구 저장)
- **상태 관리:** 전역 `state` 객체
- **테마:** classic / earthBrown / oceanGreen / lightBeige (라이트/다크 모드 지원)

---

## 📊 주요 기능

- **업무 영역 시간 추적** — 7개 업무 영역별 체류 시간 자동 기록 (인수, 계약, 보상, 회계, 실적, 정산, 재무)
- **플로팅 어시스턴트 패널** — 메모, 클립보드, 템플릿, 즐겨찾기 탭
- **다중 테마 시스템** — 4가지 컬러 테마 + 라이트/다크 모드
- **IndexedDB 영구 저장** — 페이지 새로고침 후에도 데이터 유지

---

## 🔄 개발 워크플로우 (협업)

```bash
# 1. 레포지토리 클론
git clone https://github.com/sincereperson/assistant.git
cd assistant

# 2. VS Code로 열기
code .

# 3. Live Server로 구동 (VS Code 확장 설치 후)
# → 우측 하단 'Go Live' 클릭

# 4. 작업 후 변경사항 반영
git add .
git commit -m "작업 내용 간략히 기술"
git push
```

---

## 📝 브랜치 전략

| 브랜치 | 용도 |
|--------|------|
| `main` | 안정적인 배포 버전 |
| `feature/*` | 기능 개발 |
| `fix/*` | 버그 수정 |

---

## 🗄️ IndexedDB 스키마

| 스토어 | 용도 |
|--------|------|
| `memos` | 업무 메모 (areaId, date, pinned 인덱스) |
| `clipboard` | 클립보드 (7일 후 자동 삭제) |
| `templates` | 재사용 텍스트 블록 |
| `favorites` | 즐겨찾기 메뉴 |
| `settings` | 사용자 설정 (다크모드, 테마 등) |
| `metadata` | 시스템 정보 (lastBackup 등) |

---

## ⚠️ 주의사항

- 한글 파일명 git add 시 인코딩 문제가 발생할 수 있으므로 `git add .` 사용 권장
- IndexedDB는 브라우저별 저장소이므로 다른 브라우저에서는 데이터가 공유되지 않음
- 빌드 프로세스 없음 — 파일 직접 수정 후 브라우저 새로고침으로 확인
