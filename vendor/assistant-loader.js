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
    const config = options || {};
    const mountId = config.mountId || 'assistant-mount';
    // const mountContainerId = config.mountContainerId || 'mf_VFrames_Root';
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
      // const container = document.getElementById(mountContainerId) || (allowBodyFallback ? document.body : null);
      // if (!container) {
      //   console.error('[assistant-loader] mount container not found:', mountContainerId);
      //   return;
      // }
      document.body.appendChild(mount);
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

      if (typeof window.bootstrapAssistant === 'function') {
        window.bootstrapAssistant(config);
      } else {
        window.dispatchEvent(new CustomEvent('assistant:mounted', { detail: config }));
      }
    } catch (error) {
      console.error('[assistant-loader] load failed:', error);
    }
  }
  window.loadAssistant = loadAssistant;
})();
