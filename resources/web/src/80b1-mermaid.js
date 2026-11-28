  var Mermaid = (function mermaidModule() {
  // ---- mermaid 代码块 ----
  // Typora 把 ```mermaid 画成图；渲染态与 PDF 导出同样换成图，点图回到源码编辑。
  // 渲染是异步的，pdfContentReady 会等它完成再量高度，避免量到 0 高度。
  var mermaidSeq = 0;
  var mermaidPending = 0;       // 尚未完成的异步渲染计数，导出等它归零
  var mermaidReady = !!(window.mermaid && window.mermaid.initialize);
  var mermaidLoading = false;
  var mermaidLoadQueue = [];
  function initMermaid() {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      fontFamily: '"PingFang SC", "Open Sans", sans-serif',
      themeVariables: { fontSize: '14px' },
      flowchart: { htmlLabels: false, useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false }
    });
  }
  if (mermaidReady)
    initMermaid();

  // mermaid.min.js（3.3MB）不再内联进页面，壳只把它拷到页面同目录；
  // 文档里真的出现 mermaid 块时才动态加载，省掉每次启动/换页的解析开销。
  function ensureMermaidLoaded() {
    if (mermaidReady || mermaidLoading || !window.MOTE_MERMAID_SRC)
      return;
    mermaidLoading = true;
    var s = document.createElement('script');
    // 相对页面自身目录解析（location.href），不受文档目录 <base> 影响
    s.src = new URL(window.MOTE_MERMAID_SRC, location.href).href;
    var settle = function () {
      mermaidLoading = false;
      var q = mermaidLoadQueue.splice(0);
      for (var i = 0; i < q.length; i++) q[i]();
    };
    s.onload = function () {
      if (window.mermaid && window.mermaid.initialize) {
        mermaidReady = true;
        initMermaid();
      } else {
        window.MOTE_MERMAID_SRC = '';
      }
      settle();
    };
    s.onerror = function () {
      // 缺文件：本次会话不再重试，mermaid 块保持源码显示
      window.MOTE_MERMAID_SRC = '';
      settle();
    };
    document.head.appendChild(s);
  }

  function isMermaidBlock(el) {
    return LayoutCode.isCodeBlock(el) && (el.dataset.lang || '').trim().toLowerCase() === 'mermaid';
  }

  function mermaidFigure(el) {
    var pre = el.querySelector('pre.code-block');
    if (!pre)
      return null;
    var fig = pre.querySelector('.mermaid-figure');
    if (fig)
      return fig;
    fig = document.createElement('div');
    fig.className = 'mermaid-figure';
    fig.setAttribute('contenteditable', 'false');
    fig.setAttribute('aria-hidden', 'true');
    // 图不可编辑：点图直接回到源码编辑（enterEdit 会把光标放进 <code>）
    fig.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      CaretEdit.enterEdit(el);
    });
    pre.insertBefore(fig, pre.firstChild);
    return fig;
  }

  function renderMermaidBlock(el) {
    var src = LayoutCode.codeText(el).trim();
    if (!src) {
      el.classList.remove('has-mermaid');
      return;
    }
    var fig = mermaidFigure(el);
    if (!fig || el._mermaidSig === src)
      return;
    if (el._mermaidBusy)
      return;
    el._mermaidBusy = true;
    mermaidPending++;
    window.mermaid.render('mote-mermaid-' + (++mermaidSeq), src).then(function (out) {
      el._mermaidBusy = false;
      mermaidPending--;
      if (fig.isConnected && out && out.svg) {
        fig.innerHTML = out.svg;
        el._mermaidSig = src;
        el.classList.add('has-mermaid');
      } else {
        el._mermaidSig = src;
        el.classList.remove('has-mermaid');
      }
    }, function () {
      // 语法错误：保留源码块，不显示图
      el._mermaidBusy = false;
      mermaidPending--;
      el._mermaidSig = src;
      el.classList.remove('has-mermaid');
    });
  }

  // force=true 时连正在编辑的块也渲染（导出前用），否则让开光标所在的块
  function scanMermaid(force) {
    var ed = document.getElementById('editor');
    if (!ed || ViewState.mode() === 'source')
      return;
    if (!mermaidReady) {
      if (!window.MOTE_MERMAID_SRC)
        return;
      var probe = ed.querySelectorAll('.block.code');
      var has = false;
      for (var i = 0; i < probe.length; i++) {
        if (isMermaidBlock(probe[i])) {
          has = true;
          break;
        }
      }
      if (!has)
        return;
      // 计入 pending：导出路径会等库加载与渲染都完成
      mermaidPending++;
      mermaidLoadQueue.push(function () {
        mermaidPending--;
        scanMermaid(force);
      });
      ensureMermaidLoaded();
      return;
    }
    var blocks = ed.querySelectorAll('.block.code');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (isMermaidBlock(el)) {
        if (force || !el.classList.contains('editing'))
          renderMermaidBlock(el);
      } else if (el.classList.contains('has-mermaid')) {
        el.classList.remove('has-mermaid');
        el._mermaidSig = null;
      }
    }
  }
  return {
    scanMermaid: scanMermaid,
    hasPending: function () { return mermaidPending > 0; }
  };
  })();
