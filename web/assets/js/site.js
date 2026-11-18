/* 小兔在线 · 站点脚本：导航、复制、版本校准（无第三方依赖） */

(function () {
  'use strict';

  /* ---------- 移动端导航 ---------- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- 顶栏描边 ---------- */
  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- 复制 ---------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, area.value.length);
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  function bindCopy(button, getText) {
    button.addEventListener('click', function () {
      var text = getText();
      if (!text || text.indexOf('待补充') === 0) return;
      var label = button.textContent;
      copyText(text).then(function () {
        button.textContent = '已复制';
      }, function () {
        button.textContent = '复制失败';
      }).then(function () {
        window.setTimeout(function () { button.textContent = label; }, 1600);
      });
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    var target = document.getElementById(button.getAttribute('data-copy'));
    if (!target) return;
    bindCopy(button, function () { return target.textContent.trim(); });
  });

  document.querySelectorAll('.dl-row').forEach(function (row) {
    var button = row.querySelector('[data-copy-sha]');
    var sha = row.querySelector('[data-field="sha"]');
    if (!button || !sha) return;
    bindCopy(button, function () { return sha.textContent.trim(); });
  });

  /* ---------- 版本校准 ----------
     页面里的版本号、大小、SHA256、下载地址以 OSS 上的更新清单为准；
     清单取不到（离线、CORS、未发布）时保留页面内置的兜底值，不显示错误。
     三个产品共用统一 Schema v2 的 manifest.json（platforms.<os>.artifacts.*，
     见 mote/docs/更新清单Schema-v2.md）。 */

  var BASE = 'https://dl.xiaotu.online';
  var MANIFEST_URLS = {
    mote: BASE + '/mote/updates/stable/manifest.json',
    xiaotu: BASE + '/xiaotu/updates/stable/manifest.json',
    devcard: BASE + '/devcard/updates/stable/manifest.json'
  };
  var SOURCES = {
    'mote-mac': { url: MANIFEST_URLS.mote, platform: 'macos', artifact: 'dmg' },
    'mote-win-setup': { url: MANIFEST_URLS.mote, platform: 'windows', artifact: 'setup' },
    'mote-win-zip': { url: MANIFEST_URLS.mote, platform: 'windows', artifact: 'portable' },
    'xiaotu-mac': { url: MANIFEST_URLS.xiaotu, platform: 'macos', artifact: 'dmg' },
    'xiaotu-win-setup': { url: MANIFEST_URLS.xiaotu, platform: 'windows', artifact: 'setup' },
    'xiaotu-win-zip': { url: MANIFEST_URLS.xiaotu, platform: 'windows', artifact: 'portable' },
    'devcard-mac': { url: MANIFEST_URLS.devcard, platform: 'macos', artifact: 'dmg' },
    'devcard-win-setup': { url: MANIFEST_URLS.devcard, platform: 'windows', artifact: 'setup' },
    'devcard-win-zip': { url: MANIFEST_URLS.devcard, platform: 'windows', artifact: 'portable' }
  };

  var cache = {};

  function loadManifest(url) {
    if (!cache[url]) {
      cache[url] = fetch(url, { credentials: 'omit', mode: 'cors' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });
    }
    return cache[url];
  }

  function humanSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* v2 清单：platforms.<os>.artifacts.<key> = { url, size, sha256 }。 */
  function pickArtifact(data, platform, artifact) {
    var section = data && data.platforms && data.platforms[platform];
    var arts = section && section.artifacts;
    return (arts && arts[artifact]) || null;
  }

  function setField(row, name, value) {
    if (!value) return;
    var el = row.querySelector('[data-field="' + name + '"]');
    if (!el) return;
    if (name === 'href') {
      el.setAttribute('href', value);
    } else if (name === 'sha') {
      el.textContent = value;
      el.setAttribute('title', value);
    } else {
      el.textContent = value;
    }
  }

  document.querySelectorAll('[data-manifest]').forEach(function (row) {
    var source = SOURCES[row.getAttribute('data-manifest')];
    if (!source) return;
    loadManifest(source.url).then(function (data) {
      var platform = data && data.platforms && data.platforms[source.platform];
      if (!platform) throw new Error('no platforms.' + source.platform);
      var artifact = pickArtifact(data, source.platform, source.artifact);
      if (!artifact) throw new Error('no artifacts.' + source.artifact);
      row.setAttribute('data-synced', 'ok');
      if (platform.version) {
        setField(row, 'version', 'v' + platform.version);
        setField(row, 'version-plain', platform.version);
      }
      if (artifact.size) {
        setField(row, 'size', Number(artifact.size).toLocaleString('en-US'));
        setField(row, 'size-human', '约 ' + humanSize(artifact.size));
      }
      setField(row, 'sha', artifact.sha256);
      setField(row, 'href', artifact.url);
    }).catch(function () {
      row.setAttribute('data-synced', 'fallback');
    });
  });
})();
