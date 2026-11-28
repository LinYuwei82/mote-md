  var Toc = (function tocModule() {
  /* ---------------- 目录侧栏 ---------------- */

  var tocVisible = false;
  var tocItems = [];
  var tocTimer = null;
  // 目录项的文档纵坐标缓存：滚动高亮改二分查表，不再每次滚动对每个标题
  // 调 getBoundingClientRect（900 个标题时每帧 900 次布局读取）。
  var tocTops = null;
  // 标题集合的签名：正文段落增删不应导致目录整天重建。
  var tocSig = null;
  var spyScheduled = false;

  function headingLevel(el) {
    for (var level = 1; level <= 6; level++) {
      if (el.classList.contains('h' + level))
        return level;
    }
    return 0;
  }

  function plainLabel(raw) {
    return String(raw)
      .replace(/^#+\s*/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`]/g, '')
      .trim();
  }

  // 标题锚点：按 GitHub 风格从标题文本生成 slug（保留中文，去标点，空格转 -），
  // 同名标题依次追加 -1、-2，这样 `#标题` 链接才能找到目标。
  function headingSlug(raw) {
    var text = plainLabel(raw).toLowerCase();
    text = text.replace(/[!"#$%&'()*+,.\/:;<=>?@\[\\\]^`{|}~]/g, '');
    text = text.replace(/[，。、：；！？（）【】《》「」『』—…·]/g, '');
    text = text.replace(/[\s\u3000]+/g, '-');
    return text.replace(/^-+|-+$/g, '');
  }

  function headingAnchors() {
    var map = {};
    var seen = {};
    if (mode !== 'wysiwyg')
      return map;
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (!el.classList || !el.classList.contains('block'))
        continue;
      if (!headingLevel(el))
        continue;
      // 锚点用渲染态原文算 slug：正在编辑的块 textContent 会带上零宽标记，
      // 直接取会把标记也算进 slug，导致跳转失灵
      var raw = el.dataset.raw || el.textContent;
      var slug = headingSlug(raw);
      if (!slug)
        continue;
      var count = seen[slug] || 0;
      seen[slug] = count + 1;
      var key = count ? slug + '-' + count : slug;
      if (!map[key])
        map[key] = el;
    }
    return map;
  }

  // 文档内锚点：命中就滚到对应标题，返回是否找到
  function scrollToAnchor(href) {
    var id = String(href || '').replace(/^#/, '');
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // 非法的百分号编码：按字面值匹配
    }
    if (!id)
      return false;
    var map = headingAnchors();
    var target = map[id] || map[id.toLowerCase()];
    if (!target)
      return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }

  function tocData() {
    var items = [];
    if (mode !== 'wysiwyg')
      return items;
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (!el.classList || !el.classList.contains('block'))
        continue;
      var level = headingLevel(el);
      if (!level)
        continue;
      var raw = el.classList.contains('editing') ? el.textContent : (el.dataset.raw || '');
      items.push({ level: level, label: plainLabel(raw), el: el });
    }
    return items;
  }

  function refreshToc() {
    if (!tocVisible || !tocList) {
      tocSig = null;
      return;
    }
    var items = tocData();
    var sig = '';
    for (var k = 0; k < items.length; k++)
      sig += items[k].level + '|' + items[k].label + '\n';
    // 标题没变且原节点仍在文档里：只重算高亮，不重建 innerHTML
    if (sig === tocSig && items.length === tocItems.length
        && (!items.length || (tocItems[0].el && tocItems[0].el.isConnected))) {
      updateActiveHeading();
      return;
    }
    tocSig = sig;
    tocItems = items;
    var html = '';
    for (var i = 0; i < tocItems.length; i++) {
      var item = tocItems[i];
      html += '<a class="toc-item" data-toc="' + i + '" style="padding-left:'
        + (0.5 + (item.level - 1) * 0.75) + 'rem">' + Util.escapeHtml(item.label) + '</a>';
    }
    tocList.innerHTML = html || '<div class="toc-empty">没有标题</div>';
    tocTops = null;
    updateActiveHeading();
  }

  function scheduleTocRefresh() {
    if (!tocVisible)
      return;
    if (tocTimer)
      clearTimeout(tocTimer);
    tocTimer = setTimeout(function () {
      tocTimer = null;
      refreshToc();
    }, 260);
  }

  // 以视口顶部往下 80px 为判定线：最后一个越过判定线的标题即“当前标题”。
  // 降级点：只在渲染态按块位置计算，编辑中的块尚未重排，滚动时可能滞后一帧。
  function tocOffsets() {
    if (tocTops && tocTops.length === tocItems.length)
      return tocTops;
    tocTops = [];
    for (var i = 0; i < tocItems.length; i++)
      tocTops.push(tocItems[i].el.getBoundingClientRect().top + window.scrollY);
    return tocTops;
  }

  function updateActiveHeading() {
    if (!tocVisible || !tocItems.length)
      return;
    var tops = tocOffsets();
    var y = window.scrollY + 80;
    // 最后一个 top <= y 的项；二分避免逐项读布局
    var lo = 0, hi = tops.length - 1, active = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tops[mid] <= y) {
        active = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    var nodes = tocList.querySelectorAll('.toc-item');
    for (var j = 0; j < nodes.length; j++)
      nodes[j].classList.toggle('active', j === active);
  }

  function toggleToc() {
    tocVisible = !tocVisible;
    document.body.classList.toggle('toc-open', tocVisible);
    // 先让侧栏出现，列表放到下一轮事件循环再建：900 个标题的构建约 40ms，
    // 同步做会把点击/快捷键那一帧顶住。
    if (tocVisible)
      setTimeout(function () { if (tocVisible) refreshToc(); }, 0);
    ViewState.postView();
  }

  // 滚动高亮：同一帧只安排一次；侧栏关闭或源码模式下不计算
  function scheduleActiveHeading() {
    if (!tocVisible || mode !== 'wysiwyg' || spyScheduled)
      return;
    spyScheduled = true;
    requestAnimationFrame(function () {
      spyScheduled = false;
      updateActiveHeading();
    });
  }

  function invalidateTops() {
    tocTops = null;
  }

  function itemAt(index) {
    return tocItems[index];
  }

  function resetItems() {
    tocItems = [];
  }

  function isVisible() {
    return tocVisible;
  }

  return {
    headingLevel: headingLevel,
    headingSlug: headingSlug,
    plainLabel: plainLabel,
    scrollToAnchor: scrollToAnchor,
    refreshToc: refreshToc,
    scheduleTocRefresh: scheduleTocRefresh,
    updateActiveHeading: updateActiveHeading,
    toggleToc: toggleToc,
    scheduleActiveHeading: scheduleActiveHeading,
    invalidateTops: invalidateTops,
    itemAt: itemAt,
    resetItems: resetItems,
    isVisible: isVisible
  };
  })();
