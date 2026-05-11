(function () {
  function getBaseUrl() {
    const current = document.currentScript && document.currentScript.src;
    if (current) return current;
    const scripts = Array.from(document.querySelectorAll('script'))
      .map(s => s.getAttribute('src'))
      .filter(Boolean);
    const loaderSrc = scripts.find(src => src.includes('assistant-loader.js'));
    return loaderSrc || document.baseURI;
  }

  function resolvePath(path) {
    if (!path) return path;
    try {
      return new URL(path, getBaseUrl()).toString();
    } catch (error) {
      return path;
    }
  }

  /**
   * URL 파라미터로 어시스턴트 자체를 온/오프 제어합니다.
   * ?assistant=off  (또는 assi=off, 0, false) → loadAssistant 자체를 건너뜀
   * ?assistant=on   (또는 assi=on, 1, true)  → 기본 동작 (항상 로드)
   * 파라미터 없음 → 기본 동작
   *
   * @returns {'on'|'off'|null}  null = 파라미터 없음(기본 동작)
   */
  function getAssistantLoadMode() {
    try {
      const q = new URL(window.location.href).searchParams;
      const raw = (q.get('assistant') || q.get('assi') || '').toString().trim().toLowerCase();
      if (!raw) return null;
      if (raw === 'on'  || raw === '1' || raw === 'true')  return 'on';
      if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
      return null;
    } catch (_) {
      return null;
    }
  }

  function ensureStylesheet(href) {
    if (!href) return;
    const resolvedHref = resolvePath(href);
    const exists = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .some(link => link.getAttribute('href') === resolvedHref);
    if (exists) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = resolvedHref;
    document.head.appendChild(link);
  }

  function ensureScript(src) {
    if (!src) return Promise.resolve();
    const resolvedSrc = resolvePath(src);
    const existing = Array.from(document.querySelectorAll('script'))
      .some(script => script.getAttribute('src') === resolvedSrc);
    if (existing) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = resolvedSrc;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load script: ' + src));
      document.body.appendChild(script);
    });
  }

  async function loadAssistant(options) {
    // ─── URL 파라미터로 어시스턴트 자체 온/오프 제어 ──────────────
    // ?assistant=off (또는 assi=off, 0, false) → 어시스턴트를 아예 로드하지 않음
    // ?assistant=on  (또는 assi=on,  1, true)  → 기본 동작과 동일 (로드)
    if (getAssistantLoadMode() === 'off') {
      // 이미 마운트된 어시스턴트가 있으면 완전 제거
      var _mountId = (options && options.mountId) || 'assistant-mount';
      var _existing = document.getElementById(_mountId);
      if (_existing) _existing.remove();
      window.assistantInitialized = false;
      console.info('[assistant-loader] URL 파라미터(assistant=off)로 어시스턴트 비활성화됨.');
      return;
    }
    // ────────────────────────────────────────────────────────────────

    // ─── watchdog 해제 (정상 경로 진입 시 타이머 취소) ─────────────
    if (window.__assiWatchdog) { clearTimeout(window.__assiWatchdog); window.__assiWatchdog = null; }
    window.__assiWatchdogDone = true;
    // 정상 기동 시 hang 배지가 이미 뜨 있으면 자동 제거
    var _hangWrap = document.getElementById('assi-hang-wrap');
    if (_hangWrap) _hangWrap.remove();
    // ────────────────────────────────────────────────────────────────
    const config = options || {};

    // ─── 특정 사번 어시스턴트 차단 목록 ───────────────────────────
    // 아래 목록에 포함된 loginId는 어시스턴트를 로드하지 않음
    const BLOCKED_LOGIN_IDS = [
      'O402321', 'O402322', 'O402324', 'O402328',
      'O402522', 'O402637', 'O402638',
    ];
    if (config.loginId && BLOCKED_LOGIN_IDS.includes(String(config.loginId).toUpperCase())) {
      console.info('[assistant-loader] 차단된 사번입니다. 어시스턴트를 로드하지 않습니다:', config.loginId);
      return;
    }
    // ────────────────────────────────────────────────────────────────

    // ─── 특정 부서 어시스턴트 차단 목록 ───────────────────────────
    // deptCd    : loadAssistant({ deptCd: userObj.userDeptCd, ... }) 로 전달
    // uprDeptCd : loadAssistant({ uprDeptCd: userObj.userUprDeptCd, ... }) 로 전달
    const BLOCKED_DEPT_CDS = [
      // 예시) '240070',  // IT기획파트
    ];
    const BLOCKED_UPR_DEPT_CDS = [
      // 예시) '240000',  // 정보기술팀
    ];
    if (config.deptCd && BLOCKED_DEPT_CDS.includes(String(config.deptCd))) {
      console.info('[assistant-loader] 차단된 부서입니다. 어시스턴트를 로드하지 않습니다:', config.deptCd);
      return;
    }
    if (config.uprDeptCd && BLOCKED_UPR_DEPT_CDS.includes(String(config.uprDeptCd))) {
      console.info('[assistant-loader] 차단된 상위 부서입니다. 어시스턴트를 로드하지 않습니다:', config.uprDeptCd);
      return;
    }
    // ────────────────────────────────────────────────────────────────

    const mountId = config.mountId || 'assistant-mount';
    const mountContainerId = config.mountContainerId || 'mf_VFrames_Root';
    const allowBodyFallback = config.allowBodyFallback === true;
    const htmlPath = config.htmlPath || 'assistant-fragment.html';
    const cssPath = config.cssPath || 'assistant.css';
    const cssPaths = Array.isArray(config.cssPaths) ? config.cssPaths : [];
    const jsPath = config.jsPath || 'assistant.js';
    const scriptPaths = Array.isArray(config.scriptPaths) ? config.scriptPaths : [];

    // 로그인 ID 유무에 따라 인증 모드 또는 공용 모드로 설정
    config.authMode = config.loginId ? 'authenticated' : 'public';
    
    // workerPath 미지정 시 기본값 설정 (loader 위치 기준으로 resolve)
    if (!config.workerPath) {
      config.workerPath = resolvePath(config.jsPath ? config.jsPath.replace(/assistant\.js$/, 'assistant-worker.js') : 'assistant-worker.js');
    }

    let mount = document.getElementById(mountId);
    if (!mount) {
      mount = document.createElement('div');
      mount.id = mountId;
      mount.style.margin = '0';
      mount.style.padding = '0';
      mount.style.border = '0';
      const container = document.getElementById(mountContainerId) || (allowBodyFallback ? document.body : null);
      if (!container) {
        console.error('[assistant-loader] mount container not found:', mountContainerId);
        return;
      }
      container.appendChild(mount);
    }

    ensureStylesheet(cssPath);
    for (const href of cssPaths) {
      ensureStylesheet(href);
    }
    for (const src of scriptPaths) {
      await ensureScript(src);
    }
    await ensureScript(jsPath);

    try {
      const resolvedHtmlPath = resolvePath(htmlPath);
      const response = await fetch(resolvedHtmlPath, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error('Failed to load assistant fragment: ' + response.status);
      }
      const html = await response.text();
      mount.innerHTML = html;

      // fragment 내 상대경로 img src를 fragment 파일 위치 기준 절대경로로 교체
      // resolvedHtmlPath가 상대경로일 수 있으므로 document.baseURI 기준으로 절대 URL 정규화
      const fragmentBaseUrl = (() => {
        try { return new URL(resolvedHtmlPath, document.baseURI).href; } catch (_) { return document.baseURI; }
      })();
      mount.querySelectorAll('img[src]').forEach(img => {
        const rawSrc = img.getAttribute('src');
        if (rawSrc && !rawSrc.startsWith('data:') && !rawSrc.startsWith('http')) {
          try {
            img.src = new URL(rawSrc, fragmentBaseUrl).toString();
          } catch (e) { void e; }
        }
      });

      if (typeof window.bootstrapAssistant === 'function') {
        window.bootstrapAssistant(config);
      } else {
        window.dispatchEvent(new CustomEvent('assistant:mounted', { detail: config }));
      }
    } catch (error) {
      console.error('[assistant-loader] load failed:', error);
    }
  }

  // ─── Boot Hang Watchdog ──────────────────────────────────────────
  // WebSquare init() 가 API 대기로 hang 걸려 loadAssistant() 가 끝내
  // 호출되지 않을 경우를 대비한 안전망.
  //
  // 사용법 (WebSquare <script> 보다 먼저):
  //   loadAssistant.watchdog({ timeout: 20000, jsPath: '...', cssPath: '...', ... })
  //
  // timeout 경과 시 → 임시 경고 배지 표시
  // 배지 클릭 시    → allowBodyFallback 모드로 어시스턴트 재기동
  // ─────────────────────────────────────────────────────────────────
  function _showHangBadge(cfg) {
    if (document.getElementById('assi-hang-wrap')) return;

    // ── 스타일 (1회만 삽입, assistant.css 구조 미러링) ──────────────
    if (!document.getElementById('assi-hang-style')) {
      var s = document.createElement('style');
      s.id = 'assi-hang-style';
      s.textContent = [
        '@keyframes assi-badge-pulse{',
        '  0%,100%{box-shadow:0 0 0 0 rgba(231,76,60,.55)}',
        '  50%    {box-shadow:0 0 0 8px rgba(231,76,60,0)}',
        '}',
        '@keyframes assi-balloon-float{',
        '  0%,100%{transform:scale(1) translateY(0)}',
        '  50%    {transform:scale(1) translateY(-4px)}',
        '}',
        '#assi-hang-wrap{',
        '  position:fixed;bottom:42px;right:30px;',
        '  display:flex;flex-direction:column;align-items:flex-end;gap:8px;',
        '  z-index:2147483647;',
        '}',
        '#assi-hang-balloon{',
        '  background:#e74c3c; color:#fff;',
        '  padding:12px 16px;border-radius:16px;',
        '  font:600 13px/1.5 sans-serif;',
        '  max-width:230px;text-align:center;',
        '  cursor:pointer;border:none;',
        '  box-shadow:0 4px 14px rgba(255,107,107,.45);',
        '  animation:assi-balloon-float 2s ease-in-out infinite;',
        '  position:relative;',
        '}',
        '#assi-hang-balloon::after{',
        '  content:"";position:absolute;bottom:-12px;right:20px;',
        '  width:0;height:0;',
        '  border-left:12px solid transparent;',
        '  border-top:12px solid #e74c3c;',
        '}',
        '#assi-hang-btn{',
        '  width:56px;height:56px;border-radius:50%;',
        '  background:#e74c3c;border:none;cursor:pointer;',
        '  display:flex;align-items:center;justify-content:center;',
        '  box-shadow:0 4px 14px rgba(231,76,60,.55);',
        '  animation:assi-badge-pulse 2s ease-in-out infinite;',
        '  position:relative;',
        '}',
        '#assi-hang-dot{',
        '  position:absolute;top:2px;right:2px;',
        '  width:18px;height:18px;border-radius:9px;',
        '  background:#f5f84b;color:#333;',
        '  font:700 10px/18px sans-serif;text-align:center;',
        '  pointer-events:none;',
        '}',
        '#assi-hang-modal-bg{',
        '  position:fixed;inset:0;background:rgba(0,0,0,.45);',
        '  z-index:2147483646;',
        '  display:flex;align-items:center;justify-content:center;',
        '}',
        '#assi-hang-modal{',
        '  background:#fff;border-radius:14px;',
        '  padding:28px 28px 22px;max-width:400px;width:90%;',
        '  font-family:sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.18);',
        '  text-align:center;',
        '}',
        '#assi-hang-modal h3{margin:0 0 10px;font-size:16px;color:#c0392b;}',
        '#assi-hang-modal p {margin:0 0 18px;font-size:13px;color:#555;line-height:1.65;white-space:pre-line;}',
        '#assi-hang-modal-btns{display:flex;gap:10px;justify-content:center;}',
        '#assi-hang-modal-btns button{padding:9px 22px;border:none;border-radius:8px;font:600 13px sans-serif;cursor:pointer;}',
        '.assi-btn-reload{background:#e74c3c;color:#fff;}',
        '.assi-btn-cancel{background:#ecf0f1;color:#555;}',
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    }

    // ── 진단 메시지 생성 ────────────────────────────────────────────
    var watchUrl = cfg.watchUrl || '';
    var online   = navigator.onLine;
    var diagLines = [];
    if (watchUrl)   diagLines.push('• 미응답 URL: ' + watchUrl);
    diagLines.push('• 네트워크: ' + (online ? '정상' : '❌ 오프라인'));
    diagLines.push('• 권장 조치: 새로고침 또는 정보기술팀 문의');
    var diagText = diagLines.join('\n');

    // ── DOM 구성 ─────────────────────────────────────────────────────
    var wrap = document.createElement('div');
    wrap.id = 'assi-hang-wrap';

    // 말풍선
    var balloon = document.createElement('button');
    balloon.id = 'assi-hang-balloon';
    balloon.innerHTML =
      '시스템이 응답하지 않습니다' +
      '<br><span style="font-size:11px;font-weight:400;opacity:.9">클릭하여 자세히 보기</span>';
    balloon.addEventListener('click', showModal);

    // FAB 버튼 (어시스턴트 아이콘 + 빨간 뱃지 점)
    var iconUrl = resolvePath(
      (cfg.htmlPath || 'assistant/assistant-fragment.html')
        .replace(/[^\/]+$/, '') + '../asset/images/assi_icon.svg'
    );
    var btn = document.createElement('div');
    btn.id = 'assi-hang-btn';
    btn.setAttribute('role', 'button');
    btn.innerHTML =
      '<img src="' + iconUrl + '" width="36" height="37" alt="" draggable="false" style="display:block;pointer-events:none;flex-shrink:0;">'
      + '<span id="assi-hang-dot">!</span>';
    btn.addEventListener('click', showModal);

    wrap.appendChild(balloon);
    wrap.appendChild(btn);
    (document.body || document.documentElement).appendChild(wrap);

    console.warn('[assistant-loader] Boot hang watchdog fired — badge displayed.');

    // ── 새로고침 모달 ────────────────────────────────────────────────
    function showModal() {
      if (document.getElementById('assi-hang-modal-bg')) return;
      var bg = document.createElement('div');
      bg.id = 'assi-hang-modal-bg';
      bg.innerHTML =
        '<div id="assi-hang-modal">'
        + '<h3>⚠ 시스템 응답 없음</h3>'
        + '<p>' + diagText + '</p>'
        + '<div id="assi-hang-modal-btns">'
        + '  <button class="assi-btn-reload" id="assi-hang-modal-reload">새로고침</button>'
        + '  <button class="assi-btn-cancel" id="assi-hang-modal-cancel">닫기</button>'
        + '</div>'
        + '</div>';
      document.body.appendChild(bg);
      document.getElementById('assi-hang-modal-reload').addEventListener('click', function () {
        location.reload();
      });
      document.getElementById('assi-hang-modal-cancel').addEventListener('click', function () {
        bg.remove();
      });
      bg.addEventListener('click', function (e) {
        if (e.target === bg) bg.remove();
      });
    }
  }

  window.loadAssistant = loadAssistant;

  window.loadAssistant.watchdog = function (cfg) {
    if (window.__assiWatchdog) return; // 중복 방지
    var opts    = cfg || {};
    var timeout = opts.timeout || 60000;

    // ── [A] 타이머 감시: loadAssistant()가 timeout 내 미호출 시 배지 표시
    //        WebSquare 동기 script가 hang → onload 미발화 → loadAssistant() 미호출
    //        → 이 타이머가 catch 함
    window.__assiWatchdog = setTimeout(function () {
      if (window.__assiWatchdogDone) return;
      _showHangBadge(opts);
    }, timeout);

    // ── [B] fetch 프로브: async/defer script 등 비동기 구조에서도 정확히 캐치
    //        opts.watchUrl 에 bootloader.js 경로를 지정하면 활성화됨
    //        예) watchdog({ watchUrl: '/websquare5/bootloader.js', timeout: 15000, ... })
    if (opts.watchUrl && typeof AbortController !== 'undefined') {
      var ac = new AbortController();
      var probeTimer = setTimeout(function () { ac.abort(); }, timeout);
      fetch(opts.watchUrl, {
        method: 'HEAD',
        cache:  'no-cache',
        signal: ac.signal,
      })
        .then(function () {
          clearTimeout(probeTimer);
          // 서버 응답은 왔음 → 프로브 성공, 타이머 감시로만 운영
        })
        .catch(function (err) {
          clearTimeout(probeTimer);
          if (window.__assiWatchdogDone) return;
          // 네트워크 hang(abort) 또는 fetch 오류 → 즉시 배지 표시
          console.warn('[assistant-loader] watchUrl fetch failed:', err && err.message);
          // 기존 타이머 취소 후 바로 배지 표시 (중복 방지)
          if (window.__assiWatchdog) { clearTimeout(window.__assiWatchdog); window.__assiWatchdog = null; }
          _showHangBadge(opts);
        });
    }
  };
})();
