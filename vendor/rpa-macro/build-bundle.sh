#!/usr/bin/env bash
# 정본 4개 js를 합쳐 콘솔 페이스트용 bundle.txt 산출물을 생성합니다.
# - 정본(SoT): solomon-adapter.js, rpa-decorator.js, macro-recorder.js, assistant-bridge.js
# - 산출물: bundle.txt (PoC 콘솔 페이스트 전용; 끝에 자동 부트스트랩 포함)
# - 어시스턴트 통합 시에는 정본 4개 js를 그대로 사용하고 init 시점은 어시스턴트가 통제합니다.

set -euo pipefail

cd "$(dirname "$0")"

OUT="bundle.txt"
MODULES=(
  "solomon-adapter.js"
  "rpa-decorator.js"
  "macro-recorder.js"
  "assistant-bridge.js"
)

{
  cat <<'HEADER'
// ─────────────────────────────────────────────────────────────────
// rpa-macro/bundle.txt — 콘솔 paste 전용 합본 (메일 반입 호환)
//
// 사용:
//   1) 솔로몬 화면(또는 어시스턴트 떠있는 페이지)에서 F12 콘솔 열기
//   2) 이 파일 전체를 콘솔에 paste → Enter
//   3) 화면 우하단(또는 어시스턴트 패널 안)에 매크로 토글 박스 등장
//   4) [● 녹화] → 작업 → [■ 종료] → [▶ 재생]
//
// 구성: solomon-adapter → rpa-decorator → macro-recorder → assistant-bridge
//       + 마지막에 자동 init 한 줄
// 의존: 외부 라이브러리 0, 표준 DOM API만 사용
//
// Phase B 보강 (4/28 폐쇄망 검증 결과 반영):
//   1. change 이벤트 캡처 — select/checkbox/날짜위젯/팝업 적용 동작 처리
//   2. 재생 시 $p.comp setValue 우선 호출 — 솔로몬 핸들러 체인 정상 발화
//   3. 재생 후 blur dispatch — onkillfocus 핸들러 트리거
//   4. 어시스턴트/매크로 토글 영역 제외 — 재귀 캡처 방지
// ─────────────────────────────────────────────────────────────────

HEADER

  for m in "${MODULES[@]}"; do
    echo "// ===== ${m} ====="
    cat "${m}"
    echo
  done

  cat <<'BOOT'
// ─────────────────────────────────────────────────────────────────
// 자동 init — paste 직후 즉시 활성화
// ─────────────────────────────────────────────────────────────────
(function bootstrap() {
  try {
    SolomonAdapter.resetStats();
    const decoratedCount = RpaDecorator.decorate();
    RpaDecorator.startObserving(document.body);
    AssistantBridge.init();
    const stats = SolomonAdapter.getStats();
    console.log('[rpa-macro/bundle] 활성화 완료', {
      mountedHost: AssistantBridge.getMountedHost(),
      decoratedCount,
      adapterStats: stats,
    });
  } catch (err) {
    console.error('[rpa-macro/bundle] 활성화 실패:', err);
  }
})();
BOOT
} > "${OUT}"

echo "[build-bundle] ${OUT} 생성 완료 ($(wc -c < "${OUT}") bytes)"
