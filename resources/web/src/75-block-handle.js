  var BlockHandle = (function blockHandleModule() {
  /* ---------- 手柄显示与定位 ---------- */

  function positionBlockHandle() {
    if (!blockHandle)
      return;
    var el = blockHandleTarget;
    if (!el || el.parentNode !== root || mode === 'source' || blockDrag
        || document.body.classList.contains('pdf-export')) {
      blockHandle.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    if (r.bottom < -8 || r.top > window.innerHeight + 8) {
      blockHandle.style.display = 'none';
      return;
    }
    var w = blockHandle.offsetWidth || 22;
    var left = r.left - w - 6;
    if (left < 2)
      left = 2;
    blockHandle.style.left = left + 'px';
    blockHandle.style.top = (r.top + 1) + 'px';
    blockHandle.style.display = 'block';
  }

  function setHandleBlock(el) {
    if (blockDrag)
      return;
    blockHandleTarget = el || null;
    positionBlockHandle();
  }

  function hideBlockHandle() {
    if (blockHandleKeep || blockDrag)
      return;
    blockHandleTarget = null;
    if (blockHandle)
      blockHandle.style.display = 'none';
  }

  function ensureBlockHandle() {
    if (blockHandle)
      return blockHandle;
    blockHandle = document.createElement('div');
    blockHandle.id = 'block-handle';
    blockHandle.textContent = '⋮⋮';
    blockHandle.setAttribute('aria-hidden', 'true');
    document.body.appendChild(blockHandle);
    blockHandle.addEventListener('mousedown', onHandleDown);
    blockHandle.addEventListener('mouseenter', function () { blockHandleKeep = true; });
    blockHandle.addEventListener('mouseleave', function () { blockHandleKeep = false; });
    return blockHandle;
  }

  return {
    positionBlockHandle: positionBlockHandle,
    setHandleBlock: setHandleBlock,
    hideBlockHandle: hideBlockHandle,
    ensureBlockHandle: ensureBlockHandle
  };
  })();

  var positionBlockHandle = BlockHandle.positionBlockHandle;
  var setHandleBlock = BlockHandle.setHandleBlock;
  var hideBlockHandle = BlockHandle.hideBlockHandle;
  var ensureBlockHandle = BlockHandle.ensureBlockHandle;
