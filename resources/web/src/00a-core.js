  var Core = (function coreModule() {
  // 启动时取一次 DOM 句柄：整页生命周期内不会更换，供各子模块共享
  return {
    root: document.getElementById('editor'),
    sourceEl: document.getElementById('source'),
    tocList: document.getElementById('toc-list')
  };
  })();
