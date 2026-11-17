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
     小兔进销存的 Windows 绿色包没有进清单，这一行仍为静态值；DevCard 的
     清单是 latest + assets[]，按扩展名从 assets 里挑对应产物。 */

  var MOTEWIN = 'https://dl.xiaotu.online/mote/updates/stable/windows.json';
  var XIAOTUWIN = 'https://dl.xiaotu.online/xiaotu/updates/stable/windows.json';
  var DEVCARD_MAC = 'https://dl.xiaotu.online/devcard/updates/stable/latest.json';
  var DEVCARD_WIN = 'https://dl.xiaotu.online/devcard/updates/stable/windows.json';
  var SOURCES = {
    'mote-mac': {
      url: 'https://dl.xiaotu.online/mote/updates/stable/latest.json',
      version: 'version', size: 'size', sha: 'sha256', href: 'url'
    },
    'mote-win-setup': {
      url: MOTEWIN,
      version: 'version', size: 'setup_size', sha: 'setup_sha256', href: 'setup_url'
    },
    'mote-win-zip': {
      url: MOTEWIN,
      version: 'version', size: 'size', sha: 'sha256', href: 'url'
    },
    'xiaotu-mac': {
      url: 'https://dl.xiaotu.online/xiaotu/updates/stable/latest.json',
      version: 'version', size: 'size', sha: 'sha256', href: 'url'
    },
    'xiaotu-win-setup': {
      url: XIAOTUWIN,
      version: 'version', size: 'size', sha: 'sha256', href: 'url'
    },
    'devcard-mac': { url: DEVCARD_MAC, version: 'latest', asset: '.dmg' },
    'devcard-win-setup': { url: DEVCARD_WIN, version: 'latest', asset: '.exe' },
    'devcard-win-zip': { url: DEVCARD_WIN, version: 'latest', asset: '.zip' }
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

  /* DevCard 清单把产物放在 assets[] 里，按文件名后缀挑；digest 带 sha256: 前缀。 */
  function pickAsset(data, suffix) {
    var list = data && Array.isArray(data.assets) ? data.assets : [];
    for (var i = 0; i < list.length; i++) {
      var name = String((list[i] && list[i].name) || '').toLowerCase();
      if (name.slice(-suffix.length) === suffix) return list[i];
    }
    return null;
  }

  function shaHex(digest) {
    var match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''));
    return match ? match[1].toLowerCase() : '';
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
      var asset = null;
      if (source.asset) {
        asset = pickAsset(data, source.asset);
        if (!asset) throw new Error('no ' + source.asset + ' asset');
      }
      row.setAttribute('data-synced', 'ok');
      var version = (asset && asset.version) || data[source.version];
      if (version) {
        setField(row, 'version', 'v' + version);
        setField(row, 'version-plain', version);
      }
      var size = asset ? asset.size : data[source.size];
      if (size) {
        setField(row, 'size', Number(size).toLocaleString('en-US'));
        setField(row, 'size-human', '约 ' + humanSize(size));
      }
      setField(row, 'sha', asset ? shaHex(asset.digest) : data[source.sha]);
      setField(row, 'href', asset ? asset.download_url : data[source.href]);
    }).catch(function () {
      row.setAttribute('data-synced', 'fallback');
    });
  });
})();
