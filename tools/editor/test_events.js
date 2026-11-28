#!/usr/bin/env node
/*
 * Mote 前端事件级测试骨架（P1 行为保障）。
 *
 * 目标：在分片命名空间化后保持页面 ↔ 宿主的消息协议不变，用真实事件驱动
 * 最小 DOM 垫片做协议级回归。后续 P3 子系统抽离继续以这里为底线。
 *
 * 明确是骨架，不是完整浏览器：
 *   - DOM 垫片只实现编辑器实际用到的子集（元素树/事件冒泡/classList/dataset/
 *     querySelector 的简单选择器等），不解析 innerHTML；
 *   - setTimeout 换成可控队列，时延由 flushTimers 显式推进，结果可重复；
 *   - 不加载 mermaid / 真实字体 / 真实选区，命中这些路径的用例需先补垫片。
 *
 * 扩展方式：在文件末尾的 TEST 列表里追加用例，用 fire(target, type, props)
 * 造事件、takeMessages() 取消息，断言 window.webkit.messageHandlers.mote 的
 * 收包内容。
 *
 * 运行（在仓库根）：
 *   node tools/editor/test_events.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     tools/editor/test_events.js
 *
 * 有 src 清单时默认拼接源码分片，否则回退到构建产物 editor.js；node 下可用
 * --from-src 强制走源码，--verbose 打印每条消息（jsc 不接受脚本参数）。
 */
'use strict';

var IS_JSC = typeof readFile === 'function' && typeof print === 'function';
var fs = IS_JSC ? null : require('fs');
var argv = (!IS_JSC && typeof process !== 'undefined' && process.argv)
  ? process.argv.slice(2) : [];
var FORCE_FROM_SRC = argv.indexOf('--from-src') >= 0;
var VERBOSE = argv.indexOf('--verbose') >= 0;

var BUNDLE = 'resources/web/editor.js';
var SRC_MANIFEST = 'resources/web/src/editor.manifest.json';

function readText(path) {
  if (IS_JSC)
    return readFile(path);
  return fs.readFileSync(path, 'utf8');
}

function exists(path) {
  if (IS_JSC) {
    try {
      readFile(path);
      return true;
    } catch (error) {
      return false;
    }
  }
  return fs.existsSync(path);
}

function out(line) {
  if (IS_JSC)
    print(line);
  else
    console.log(line);
}

function failLine(line) {
  if (IS_JSC)
    print(line);
  else
    console.error(line);
}

function finish(code) {
  if (IS_JSC)
    quit(code);
  else
    process.exitCode = code;
}

/* ------------------------- 可控时钟 ------------------------- */

var clock = 0;
var timerSeq = 0;
var timers = [];

function now() {
  return clock;
}

function shimSetTimeout(fn, delay) {
  var id = ++timerSeq;
  timers.push({
    id: id,
    at: clock + Math.max(0, Number(delay) || 0),
    fn: fn,
    cancelled: false
  });
  return id;
}

function shimClearTimeout(id) {
  for (var i = 0; i < timers.length; i++) {
    if (timers[i].id === id)
      timers[i].cancelled = true;
  }
}

// 按虚拟时间顺序执行当前所有待触发回调；回调里新排的定时器也会被处理。
// 上限用于兜住意外自循环，正常路径不会触发。
function flushTimers(limit) {
  var guard = 0;
  var max = limit || 5000;
  for (;;) {
    var next = null;
    for (var i = 0; i < timers.length; i++) {
      var item = timers[i];
      if (item.cancelled)
        continue;
      if (!next || item.at < next.at || (item.at === next.at && item.id < next.id))
        next = item;
    }
    if (!next)
      return;
    next.cancelled = true;
    clock = next.at;
    if (typeof next.fn === 'function')
      next.fn();
    if (++guard > max)
      throw new Error('定时器队列疑似自循环，已执行 ' + max + ' 步');
  }
}

/* ------------------------- DOM 垫片 ------------------------- */

var MESSAGES = [];

function makeStyle() {
  var style = {
    setProperty: function (name, value) { style[name] = String(value); },
    removeProperty: function (name) { delete style[name]; },
    getPropertyValue: function (name) {
      return style[name] === undefined ? '' : String(style[name]);
    }
  };
  return style;
}

function ShimEvent(type, options) {
  options = options || {};
  this.type = type;
  this.bubbles = options.bubbles !== false;
  this.cancelable = options.cancelable !== false;
  this.defaultPrevented = false;
  this.target = null;
  this.currentTarget = null;
  this.timeStamp = now();
  this._stop = false;
  this._stopImmediate = false;
}

ShimEvent.prototype.preventDefault = function () {
  if (this.cancelable)
    this.defaultPrevented = true;
};

ShimEvent.prototype.stopPropagation = function () {
  this._stop = true;
};

ShimEvent.prototype.stopImmediatePropagation = function () {
  this._stop = true;
  this._stopImmediate = true;
};

function addEventListener(type, fn, options) {
  if (typeof fn !== 'function')
    return;
  var capture = options === true || !!(options && options.capture);
  var list = this._listeners[type] || (this._listeners[type] = []);
  for (var i = 0; i < list.length; i++) {
    if (list[i].fn === fn && list[i].capture === capture)
      return;
  }
  list.push({ fn: fn, capture: capture });
}

function removeEventListener(type, fn, options) {
  var capture = options === true || !!(options && options.capture);
  var list = this._listeners[type];
  if (!list)
    return;
  for (var i = 0; i < list.length; i++) {
    if (list[i].fn === fn && list[i].capture === capture) {
      list.splice(i, 1);
      return;
    }
  }
}

function invokeListeners(node, event, captureOnly) {
  var list = node._listeners && node._listeners[event.type];
  if (!list)
    return;
  var snapshot = list.slice();
  for (var i = 0; i < snapshot.length; i++) {
    var item = snapshot[i];
    if (captureOnly !== null && item.capture !== captureOnly)
      continue;
    event.currentTarget = node;
    item.fn.call(node, event);
    if (event._stopImmediate)
      return;
  }
}

function dispatchEvent(event) {
  if (!event || typeof event.type !== 'string')
    throw new Error('dispatchEvent 需要带 type 的事件对象');
  event.target = this;
  var path = [];
  for (var node = this; node; node = node.parentNode)
    path.push(node);

  // 捕获：从最外层向内（不含目标）
  for (var i = path.length - 1; i > 0 && !event._stop; i--)
    invokeListeners(path[i], event, true);

  // 目标阶段：捕获与非捕获监听器都执行
  if (!event._stop)
    invokeListeners(path[0], event, null);

  // 冒泡：从目标的父级向外
  for (var j = 1; j < path.length && !event._stop; j++)
    invokeListeners(path[j], event, false);

  event.currentTarget = null;
  return !event.defaultPrevented;
}

function matchesSimple(el, token) {
  token = String(token).trim();
  if (!token)
    return false;
  if (token === '*')
    return el.nodeType === 1;
  if (token.charAt(0) === ':')
    return false;   // 骨架不支持 :scope 等伪类
  var parsed = /^([A-Za-z][A-Za-z0-9-]*)?((?:[.#][A-Za-z0-9_-]+)*)$/.exec(token);
  if (!parsed)
    return false;
  if (parsed[1] && el.tagName !== parsed[1].toUpperCase())
    return false;
  var rest = parsed[2];
  var re = /([.#])([A-Za-z0-9_-]+)/g;
  var hit;
  while ((hit = re.exec(rest))) {
    if (hit[1] === '#') {
      if (el.id !== hit[2])
        return false;
    } else if (!el.classList.contains(hit[2])) {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  var parts = String(selector).split(',');
  for (var i = 0; i < parts.length; i++) {
    if (matchesSimple(el, parts[i]))
      return true;
  }
  return false;
}

function isElementNode(node) {
  return !!node && node.nodeType === 1;
}

function Element(tag, doc) {
  this.ownerDocument = doc || null;
  this.tagName = String(tag).toUpperCase();
  this.nodeName = this.tagName;
  this.nodeType = 1;
  this.nodeValue = null;
  this.parentNode = null;
  this._children = [];
  this._listeners = {};
  this._attrs = {};
  this._text = '';
  this._html = '';
  this._classes = [];
  this._classList = null;
  this.dataset = {};
  this.style = makeStyle();
  this.id = '';
  this.value = '';
  this.selectionStart = 0;
  this.selectionEnd = 0;
  this.scrollTop = 0;
  this.scrollLeft = 0;
  this.scrollHeight = 0;
  this.scrollWidth = 0;
  this.clientWidth = 0;
  this.clientHeight = 0;
  this.offsetWidth = 0;
  this.offsetHeight = 0;
  this.checked = false;
}

Element.prototype.addEventListener = addEventListener;
Element.prototype.removeEventListener = removeEventListener;
Element.prototype.dispatchEvent = dispatchEvent;

Object.defineProperty(Element.prototype, 'className', {
  get: function () { return this._classes.join(' '); },
  set: function (value) {
    this._classes = String(value === undefined || value === null ? '' : value)
      .split(/\s+/).filter(function (name) { return !!name; });
  }
});

Object.defineProperty(Element.prototype, 'classList', {
  get: function () {
    var el = this;
    if (!this._classList) {
      this._classList = {
        contains: function (name) { return el._classes.indexOf(name) >= 0; },
        add: function () {
          for (var i = 0; i < arguments.length; i++) {
            if (el._classes.indexOf(arguments[i]) < 0)
              el._classes.push(arguments[i]);
          }
        },
        remove: function () {
          for (var i = 0; i < arguments.length; i++) {
            var at = el._classes.indexOf(arguments[i]);
            if (at >= 0)
              el._classes.splice(at, 1);
          }
        },
        toggle: function (name, force) {
          var has = el._classes.indexOf(name) >= 0;
          var want = force === undefined ? !has : !!force;
          if (want && !has)
            el._classes.push(name);
          else if (!want && has)
            el._classes.splice(el._classes.indexOf(name), 1);
          return want;
        },
        item: function (index) { return el._classes[index] || null; },
        get length() { return el._classes.length; },
        toString: function () { return el._classes.join(' '); }
      };
    }
    return this._classList;
  }
});

Object.defineProperty(Element.prototype, 'children', {
  get: function () { return this._children.filter(isElementNode); }
});

Object.defineProperty(Element.prototype, 'childNodes', {
  get: function () { return this._children.slice(); }
});

Object.defineProperty(Element.prototype, 'firstChild', {
  get: function () { return this._children[0] || null; }
});

Object.defineProperty(Element.prototype, 'lastChild', {
  get: function () { return this._children[this._children.length - 1] || null; }
});

Object.defineProperty(Element.prototype, 'firstElementChild', {
  get: function () { return this.children[0] || null; }
});

Object.defineProperty(Element.prototype, 'lastElementChild', {
  get: function () {
    var kids = this.children;
    return kids[kids.length - 1] || null;
  }
});

Object.defineProperty(Element.prototype, 'nextSibling', {
  get: function () {
    if (!this.parentNode)
      return null;
    var list = this.parentNode._children;
    var at = list.indexOf(this);
    return at >= 0 ? (list[at + 1] || null) : null;
  }
});

Object.defineProperty(Element.prototype, 'previousSibling', {
  get: function () {
    if (!this.parentNode)
      return null;
    var list = this.parentNode._children;
    var at = list.indexOf(this);
    return at > 0 ? list[at - 1] : null;
  }
});

Object.defineProperty(Element.prototype, 'parentElement', {
  get: function () {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
});

Object.defineProperty(Element.prototype, 'isConnected', {
  get: function () {
    var node = this;
    while (node) {
      if (node.nodeType === 9)
        return true;
      node = node.parentNode;
    }
    return false;
  }
});

Object.defineProperty(Element.prototype, 'textContent', {
  get: function () {
    if (this._children.length) {
      return this._children.map(function (child) {
        return child.textContent;
      }).join('');
    }
    return this._text;
  },
  set: function (value) {
    this._children = [];
    this._html = '';
    this._text = String(value === undefined || value === null ? '' : value);
  }
});

Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return this._html; },
  set: function (value) {
    this._children = [];
    this._text = '';
    this._html = String(value === undefined || value === null ? '' : value);
  }
});

Element.prototype.getAttribute = function (name) {
  if (name === 'class')
    return this.className;
  if (name === 'id')
    return this.id;
  if (Object.prototype.hasOwnProperty.call(this._attrs, name))
    return this._attrs[name];
  return null;
};

Element.prototype.setAttribute = function (name, value) {
  this._attrs[name] = String(value);
  if (name === 'class')
    this.className = String(value);
  else if (name === 'id')
    this.id = String(value);
};

Element.prototype.removeAttribute = function (name) {
  delete this._attrs[name];
  if (name === 'class')
    this._classes = [];
  else if (name === 'id')
    this.id = '';
};

Element.prototype.hasAttribute = function (name) {
  if (name === 'class')
    return this._classes.length > 0;
  if (name === 'id')
    return !!this.id;
  return Object.prototype.hasOwnProperty.call(this._attrs, name);
};

Element.prototype.appendChild = function (node) {
  if (!node)
    return node;
  if (node.nodeType === 11) {   // DocumentFragment：拆开子节点依次挂上
    var kids = node._children.slice();
    for (var i = 0; i < kids.length; i++)
      this.appendChild(kids[i]);
    node._children = [];
    return node;
  }
  if (node.parentNode)
    node.parentNode.removeChild(node);
  node.parentNode = this;
  this._text = '';
  this._html = '';
  this._children.push(node);
  return node;
};

Element.prototype.insertBefore = function (node, reference) {
  if (!reference)
    return this.appendChild(node);
  if (node.parentNode)
    node.parentNode.removeChild(node);
  var at = this._children.indexOf(reference);
  node.parentNode = this;
  if (at >= 0)
    this._children.splice(at, 0, node);
  else
    this._children.push(node);
  return node;
};

Element.prototype.removeChild = function (node) {
  var at = this._children.indexOf(node);
  if (at >= 0) {
    this._children.splice(at, 1);
    node.parentNode = null;
  }
  return node;
};

Element.prototype.replaceChild = function (next, old) {
  var at = this._children.indexOf(old);
  if (at < 0)
    return old;
  if (next.parentNode)
    next.parentNode.removeChild(next);
  next.parentNode = this;
  old.parentNode = null;
  this._children[at] = next;
  return old;
};

Element.prototype.remove = function () {
  if (this.parentNode)
    this.parentNode.removeChild(this);
};

Element.prototype.contains = function (node) {
  for (var current = node; current; current = current.parentNode) {
    if (current === this)
      return true;
  }
  return false;
};

Element.prototype.matches = function (selector) {
  return matchesSelector(this, selector);
};

Element.prototype.closest = function (selector) {
  for (var node = this; node; node = node.parentNode) {
    if (node.nodeType === 1 && matchesSelector(node, selector))
      return node;
  }
  return null;
};

Element.prototype.querySelectorAll = function (selector) {
  var found = [];
  function walk(node) {
    for (var i = 0; i < node._children.length; i++) {
      var child = node._children[i];
      if (child.nodeType !== 1)
        continue;
      if (matchesSelector(child, selector))
        found.push(child);
      walk(child);
    }
  }
  walk(this);
  return found;
};

Element.prototype.querySelector = function (selector) {
  var all = this.querySelectorAll(selector);
  return all.length ? all[0] : null;
};

Element.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
};

Element.prototype.focus = function () {
  if (this.ownerDocument)
    this.ownerDocument.activeElement = this;
};

Element.prototype.blur = function () {
  if (this.ownerDocument && this.ownerDocument.activeElement === this)
    this.ownerDocument.activeElement = null;
};

Element.prototype.setSelectionRange = function (start, end) {
  this.selectionStart = start;
  this.selectionEnd = end === undefined ? start : end;
};

Element.prototype.scrollIntoView = function () {};
Element.prototype.insertAdjacentHTML = function () {};
Element.prototype.click = function () {};

function TextNode(text, doc) {
  this.ownerDocument = doc;
  this.tagName = null;
  this.nodeName = '#text';
  this.nodeType = 3;
  this.nodeValue = String(text);
  this.textContent = String(text);
  this.parentNode = null;
}

function DocumentFragment(doc) {
  this.ownerDocument = doc;
  this.tagName = null;
  this.nodeName = '#document-fragment';
  this.nodeType = 11;
  this.nodeValue = null;
  this.parentNode = null;
  this._children = [];
  this._listeners = {};
}

DocumentFragment.prototype.appendChild = Element.prototype.appendChild;
DocumentFragment.prototype.removeChild = Element.prototype.removeChild;

function DocumentShim() {
  this._listeners = {};
  this.ownerDocument = null;
  this.tagName = '#document';
  this.nodeName = '#document';
  this.nodeType = 9;
  this.nodeValue = null;
  this.parentNode = null;
  this._children = [];
  this._attrs = {};
  this._text = '';
  this._html = '';
  this._byId = {};
  this.activeElement = null;
  this.fonts = null;          // 故意不提供：字体分支在垫片里跳过
  this.documentElement = new Element('html', this);
  this.head = new Element('head', this);
  this.body = new Element('body', this);
  this.documentElement.appendChild(this.head);
  this.documentElement.appendChild(this.body);
  this._children.push(this.documentElement);
  this.documentElement.parentNode = this;
}

DocumentShim.prototype = Object.create(Element.prototype);
DocumentShim.prototype.constructor = DocumentShim;

DocumentShim.prototype.createElement = function (tag) {
  return new Element(tag, this);
};

DocumentShim.prototype.createTextNode = function (text) {
  return new TextNode(text, this);
};

DocumentShim.prototype.createDocumentFragment = function () {
  return new DocumentFragment(this);
};

// 编辑器恢复光标时会遍历文本节点；垫片只实现 SHOW_TEXT 的前序 DFS。
DocumentShim.prototype.createTreeWalker = function (root, whatToShow) {
  var showText = !whatToShow || !!(whatToShow & 4);
  var stack = [root];
  return {
    nextNode: function () {
      while (stack.length) {
        var node = stack.pop();
        if (node !== root && showText && node.nodeType === 3)
          return node;
        if (node._children && node._children.length) {
          for (var i = node._children.length - 1; i >= 0; i--)
            stack.push(node._children[i]);
        }
      }
      return null;
    }
  };
};

DocumentShim.prototype.getElementById = function (id) {
  if (Object.prototype.hasOwnProperty.call(this._byId, id))
    return this._byId[id];
  var all = this.querySelectorAll('#' + id);
  return all.length ? all[0] : null;
};

DocumentShim.prototype.createRange = function () {
  return new RangeShim(this);
};

DocumentShim.prototype.getSelection = function () {
  if (!this._selection)
    this._selection = new SelectionShim();
  return this._selection;
};

DocumentShim.prototype.execCommand = function () {
  return false;
};

DocumentShim.prototype.hasFocus = function () {
  return !!this.activeElement;
};

function RangeShim(doc) {
  this.ownerDocument = doc;
  this.startContainer = null;
  this.startOffset = 0;
  this.endContainer = null;
  this.endOffset = 0;
  this.collapsed = true;
}

RangeShim.prototype.selectNodeContents = function (node) {
  this.startContainer = node;
  this.endContainer = node;
  this.startOffset = 0;
  this.endOffset = node && node._children ? node._children.length : 0;
  this.collapsed = false;
};

RangeShim.prototype.setStart = function (node, offset) {
  this.startContainer = node;
  this.startOffset = offset;
  this.collapsed = this.startContainer === this.endContainer
    && this.startOffset === this.endOffset;
};

RangeShim.prototype.setEnd = function (node, offset) {
  this.endContainer = node;
  this.endOffset = offset;
  this.collapsed = this.startContainer === this.endContainer
    && this.startOffset === this.endOffset;
};

RangeShim.prototype.collapse = function () {
  this.endContainer = this.startContainer;
  this.endOffset = this.startOffset;
  this.collapsed = true;
};

RangeShim.prototype.cloneRange = function () {
  var copy = new RangeShim(this.ownerDocument);
  copy.startContainer = this.startContainer;
  copy.startOffset = this.startOffset;
  copy.endContainer = this.endContainer;
  copy.endOffset = this.endOffset;
  copy.collapsed = this.collapsed;
  return copy;
};

RangeShim.prototype.toString = function () {
  return '';
};

RangeShim.prototype.cloneContents = function () {
  return new DocumentFragment(this.ownerDocument);
};

RangeShim.prototype.intersectsNode = function () {
  return false;
};

RangeShim.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
};

function SelectionShim() {
  this.rangeCount = 0;
  this.isCollapsed = true;
  this.anchorNode = null;
  this.anchorOffset = 0;
  this.focusNode = null;
  this.focusOffset = 0;
  this._range = null;
}

SelectionShim.prototype.removeAllRanges = function () {
  this.rangeCount = 0;
  this.isCollapsed = true;
  this.anchorNode = null;
  this.anchorOffset = 0;
  this.focusNode = null;
  this.focusOffset = 0;
  this._range = null;
};

SelectionShim.prototype.addRange = function (range) {
  this._range = range || null;
  this.rangeCount = this._range ? 1 : 0;
  this.isCollapsed = this._range ? !!this._range.collapsed : true;
  this.anchorNode = this._range ? this._range.startContainer : null;
  this.anchorOffset = this._range ? this._range.startOffset : 0;
  this.focusNode = this._range ? this._range.endContainer : null;
  this.focusOffset = this._range ? this._range.endOffset : 0;
};

SelectionShim.prototype.getRangeAt = function (index) {
  if (!this._range)
    throw new Error('DOM 垫片没有真实选区，请先补充 Selection 桩件');
  return this._range;
};

SelectionShim.prototype.toString = function () {
  return '';
};

function WindowShim(doc) {
  this._listeners = {};
  this.document = doc;
  this.innerWidth = 1280;
  this.innerHeight = 800;
  this.devicePixelRatio = 1;
  this.pageYOffset = 0;
  this.scrollY = 0;
  this.scrollX = 0;
  this.MOTE_INLINE_PROTO = undefined;
  this.MOTE_PERF = false;
  this.performance = { now: now };
  this.webkit = {
    messageHandlers: {
      mote: {
        postMessage: function (message) {
          MESSAGES.push(JSON.parse(JSON.stringify(message)));
        }
      }
    }
  };
}

WindowShim.prototype.addEventListener = addEventListener;
WindowShim.prototype.removeEventListener = removeEventListener;
WindowShim.prototype.dispatchEvent = dispatchEvent;

WindowShim.prototype.getSelection = function () {
  return this.document.getSelection();
};

WindowShim.prototype.getComputedStyle = function () {
  return makeStyle();
};

WindowShim.prototype.scrollTo = function (x, y) {
  this.scrollX = Number(x) || 0;
  this.scrollY = Number(y) || 0;
  this.pageYOffset = this.scrollY;
};

WindowShim.prototype.scrollBy = function () {};
WindowShim.prototype.focus = function () {};
WindowShim.prototype.alert = function () {};

/* ------------------------- 环境装配 ------------------------- */

function buildEnvironment() {
  var doc = new DocumentShim();
  var win = new WindowShim(doc);
  doc.defaultView = win;

  var ids = [
    'layout', 'toc', 'toc-title', 'toc-list', 'main', 'editor',
    'source', 'statusbar', 'status-message', 'status-stats'
  ];
  ids.forEach(function (id) {
    var tag = id === 'source' ? 'textarea' : 'div';
    var el = doc.createElement(tag);
    el.id = id;
    doc.body.appendChild(el);
    doc._byId[id] = el;
  });

  return { doc: doc, win: win };
}

function installGlobals(doc, win) {
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.getComputedStyle = function () { return makeStyle(); };
  globalThis.setTimeout = shimSetTimeout;
  globalThis.clearTimeout = shimClearTimeout;
  globalThis.setInterval = function () { return 0; };
  globalThis.clearInterval = function () {};
  globalThis.requestAnimationFrame = function (callback) {
    return shimSetTimeout(function () { callback(now()); }, 16);
  };
  globalThis.cancelAnimationFrame = shimClearTimeout;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
  globalThis.NodeFilter = {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3
  };
}

function sourceText() {
  var useSrc = FORCE_FROM_SRC || exists(SRC_MANIFEST);
  if (!useSrc)
    return readText(BUNDLE);
  var manifest = JSON.parse(readText(SRC_MANIFEST));
  return (manifest.files || []).map(function (name) {
    return readText('resources/web/src/' + name);
  }).join('');
}

function loadEditor(doc, win) {
  installGlobals(doc, win);
  var source = sourceText();
  new Function(source)();
  if (!win.mote || typeof win.mote.state !== 'function')
    throw new Error('加载后 window.mote 未导出，页面脚本可能提前中止');
  return win.mote;
}

/* ------------------------- 断言与用例 ------------------------- */

var total = 0;
var passed = 0;
var failures = [];

function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

function assertEqual(actual, expected, label) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  if (a !== b)
    throw new Error(label + '：期望 ' + b + '，实际 ' + a);
}

function takeMessages() {
  var copy = MESSAGES.slice();
  MESSAGES.length = 0;
  if (VERBOSE) {
    copy.forEach(function (message) {
      out('      消息 ' + JSON.stringify(message));
    });
  }
  return copy;
}

function fire(target, type, props) {
  var event = new ShimEvent(type);
  if (props) {
    for (var key in props)
      event[key] = props[key];
  }
  target.dispatchEvent(event);
  return event;
}

function messagesOfType(list, type) {
  return list.filter(function (message) {
    return message.type === type;
  });
}

function runTest(name, fn) {
  total++;
  try {
    fn();
    passed++;
    out('ok   ' + name);
  } catch (error) {
    failures.push({ name: name, error: error });
    failLine('FAIL ' + name);
    failLine('     ' + (error && error.stack ? error.stack : error));
  }
}

function main() {
  if (!exists(SRC_MANIFEST) && !exists(BUNDLE)) {
    failLine('找不到 editor.js 或 src 清单，请在仓库根执行');
    return finish(1);
  }

  var env;
  var mote;
  try {
    env = buildEnvironment();
    mote = loadEditor(env.doc, env.win);
  } catch (error) {
    failLine('加载 editor.js 失败：' + (error && error.stack ? error.stack : error));
    return finish(1);
  }

  var doc = env.doc;
  var editor = doc.getElementById('editor');

  // 1. 页面启动握手：IIFE 末尾必须恰好发一次 ready。
  runTest('boot/ready：加载后握手恰好一次', function () {
    var ready = messagesOfType(MESSAGES, 'ready');
    assertEqual(ready.length, 1, 'ready 数量');
    assertEqual(MESSAGES[0].type, 'ready', '首条消息类型');
    assertEqual(typeof mote.state, 'function', 'mote.state 类型');
    takeMessages();
  });

  // 2. 宿主快捷键：Cmd/Ctrl+S 由页面算整篇文本后回传 save。
  runTest('keydown/meta+S：回传 save 文本', function () {
    takeMessages();
    var event = fire(doc, 'keydown', { key: 's', metaKey: true });
    var list = takeMessages();
    assertEqual(messagesOfType(list, 'save').length, 1, 'save 数量');
    assertEqual(list[0].type, 'save', '消息类型');
    assertEqual(list[0].text, '', 'save.text');
    assert(event.defaultPrevented, '快捷键应 preventDefault');
  });

  // 3. Cmd/Ctrl+O 交给外壳弹打开面板。
  runTest('keydown/meta+O：请求宿主打开文件', function () {
    takeMessages();
    var event = fire(doc, 'keydown', { key: 'o', ctrlKey: true });
    var list = takeMessages();
    assertEqual(messagesOfType(list, 'open').length, 1, 'open 数量');
    assertEqual(list[0].type, 'open', '消息类型');
    assert(event.defaultPrevented, '快捷键应 preventDefault');
  });

  // 4. 无修饰键的普通按键不应触发宿主消息。
  runTest('keydown/plain：普通按键不发消息', function () {
    takeMessages();
    fire(doc, 'keydown', { key: 'x' });
    assertEqual(takeMessages().length, 0, '消息数量');
  });

  // 5. 空撤销栈：只记录 log，不应崩溃或误发 save。
  runTest('keydown/meta+Z：空历史安全退回', function () {
    takeMessages();
    fire(doc, 'keydown', { key: 'z', metaKey: true });
    var list = takeMessages();
    var logs = messagesOfType(list, 'log');
    assert(logs.length >= 1, '应记录 log 消息');
    assert(/undo skipped/.test(logs[logs.length - 1].message || ''), 'log 应说明撤销被跳过');
    assertEqual(messagesOfType(list, 'save').length, 0, '不应误发 save');
  });

  // 6. 编辑输入：input 事件同步 dataset.raw，延迟合并后回传 dirty + stats。
  runTest('input/block：同步原文并回传 dirty/stats', function () {
    takeMessages();
    var block = doc.createElement('div');
    block.className = 'block';
    block.dataset.raw = 'a';
    block.setAttribute('contenteditable', 'true');
    block.textContent = 'ab';
    editor.appendChild(block);

    fire(block, 'input', {});
    flushTimers(200);

    var list = takeMessages();
    var dirty = messagesOfType(list, 'dirty');
    var stats = messagesOfType(list, 'stats');
    assert(dirty.length >= 1, '应有 dirty 消息');
    assertEqual(dirty[dirty.length - 1].value, true, 'dirty.value');
    assert(stats.length >= 1, '应有 stats 消息');
    assertEqual(stats[stats.length - 1].words, 1, 'stats.words');
    assertEqual(block.dataset.raw, 'ab', 'dataset.raw 应与输入同步');
  });

  // 7. 链接点击：Cmd/Ctrl+Click 交给外壳打开，不在 WebView 内导航。
  runTest('click/link+meta：回传 openLink', function () {
    takeMessages();
    var block = doc.createElement('div');
    block.className = 'block';
    editor.appendChild(block);
    var anchor = doc.createElement('a');
    anchor.className = 'md-link';
    anchor.setAttribute('data-href', 'https://example.com/doc');
    anchor.textContent = '文档';
    block.appendChild(anchor);

    var event = fire(anchor, 'click', { metaKey: true });
    var list = takeMessages();
    assertEqual(messagesOfType(list, 'openLink').length, 1, 'openLink 数量');
    assertEqual(list[0].type, 'openLink', '消息类型');
    assertEqual(list[0].href, 'https://example.com/doc', 'openLink.href');
    assert(event.defaultPrevented, '链接点击应 preventDefault');
  });

  // 8. 模式切换：源码 ↔ 渲染态，body class、textarea 与 view 消息都要同步。
  runTest('mode/toggleSource：切换源码模式并回传 view', function () {
    var text = 'a\n\nb';
    mote.setMarkdown(text);
    takeMessages();

    mote.toggleSource();
    var list = takeMessages();
    var state = mote.state();
    var views = messagesOfType(list, 'view');
    assertEqual(state.mode, 'source', 'state.mode');
    assert(doc.body.classList.contains('source-mode'), 'body 应带 source-mode');
    assertEqual(doc.getElementById('source').value, text, 'source.value');
    assert(views.length >= 1, '应回传 view 消息');
    assertEqual(views[views.length - 1].source, true, 'view.source');

    mote.toggleSource();
    state = mote.state();
    assertEqual(state.mode, 'wysiwyg', 'state.mode 切回');
    assert(!doc.body.classList.contains('source-mode'), 'body 不应带 source-mode');
    var blocks = editor.children;
    assertEqual(blocks.length, 2, '块数');
    assertEqual(blocks[0].dataset.raw, 'a', '首块原文');
    assertEqual(blocks[1].dataset.raw, 'b', '次块原文');
    takeMessages();
  });

  // 9. 缩放：步进 + 上下限夹取，并同步字号与 view.zoom。
  runTest('zoom/zoomBy：步进、夹取并回传 view', function () {
    mote.resetZoom();
    takeMessages();

    mote.zoomBy(1);
    var list = takeMessages();
    var views = messagesOfType(list, 'view');
    assertEqual(mote.state().zoom, 1.1, 'state.zoom');
    assertEqual(doc.documentElement.style.fontSize, '18.15px', 'font-size');
    assert(views.length >= 1, '应回传 view 消息');
    assertEqual(views[views.length - 1].zoom, 1.1, 'view.zoom');

    mote.zoomBy(100);
    assertEqual(mote.state().zoom, 2.6, '上限');
    mote.zoomBy(-100);
    assertEqual(mote.state().zoom, 0.6, '下限');
    mote.resetZoom();
    assertEqual(mote.state().zoom, 1, '复位');
    takeMessages();
  });

  // 10. 撤销/重做：输入提交后整篇快照来回恢复。
  runTest('undo/redo：输入后撤销与重做恢复整篇文本', function () {
    mote.setMarkdown('a');
    takeMessages();
    var block = editor.querySelector('.block');
    assert(block, '应挂载块');

    block.textContent = 'ab';
    fire(block, 'input', {});
    flushTimers(1000);
    takeMessages();
    assertEqual(mote.state().source, 'ab', '提交后文本');

    fire(doc, 'keydown', { key: 'z', metaKey: true });
    var list = takeMessages();
    assertEqual(mote.state().source, 'a', '撤销后文本');
    var logs = messagesOfType(list, 'log');
    assert(/undo -> index=0/.test((logs[logs.length - 1] || {}).message || ''), '撤销日志');

    fire(doc, 'keydown', { key: 'z', metaKey: true, shiftKey: true });
    takeMessages();
    assertEqual(mote.state().source, 'ab', '重做后文本');
  });

  // 11. 组合输入：会话期间屏蔽撤销快捷键，结束后恢复可用。
  runTest('composition：组合输入期间忽略撤销快捷键', function () {
    mote.setMarkdown('x');
    takeMessages();
    var block = editor.querySelector('.block');
    block.textContent = 'xy';
    fire(block, 'input', {});
    flushTimers(1000);
    takeMessages();
    assertEqual(mote.state().source, 'xy', '提交后文本');

    fire(block, 'compositionstart', {});
    takeMessages();
    fire(doc, 'keydown', { key: 'z', metaKey: true });
    var during = takeMessages();
    assertEqual(messagesOfType(during, 'log').length, 0, '组合期间不应执行撤销');
    assertEqual(mote.state().source, 'xy', '组合期间文本不变');

    fire(block, 'compositionend', {});
    takeMessages();
    fire(doc, 'keydown', { key: 'z', metaKey: true });
    takeMessages();
    assertEqual(mote.state().source, 'x', '组合结束后可撤销');
  });

  // 12. 保存基准：markSaved 后 dirty 归零，撤销离开保存点又变脏。
  runTest('dirty/markSaved：保存基准与撤销回退', function () {
    mote.setMarkdown('m');
    flushTimers(1000);
    takeMessages();
    assertEqual(mote.state().dirty, false, '载入后不脏');

    var block = editor.querySelector('.block');
    block.textContent = 'mn';
    fire(block, 'input', {});
    flushTimers(1000);
    var list = takeMessages();
    var dirty = messagesOfType(list, 'dirty');
    assertEqual(mote.state().dirty, true, '编辑后变脏');
    assertEqual(dirty[dirty.length - 1].value, true, 'dirty 消息');

    mote.markSaved(mote.state().source);
    flushTimers(1000);
    list = takeMessages();
    dirty = messagesOfType(list, 'dirty');
    assertEqual(mote.state().dirty, false, '保存后不脏');
    assertEqual(dirty[dirty.length - 1].value, false, 'dirty false 消息');

    fire(doc, 'keydown', { key: 'z', metaKey: true });
    flushTimers(1000);
    takeMessages();
    assertEqual(mote.state().source, 'm', '撤销回到保存点前');
    assertEqual(mote.state().dirty, true, '撤销后变脏');
  });

  // 13. 目录开关：切换 body class、生成目录项并回传 view.toc。
  runTest('toc/toggle：切换目录并回传 view.toc', function () {
    mote.setMarkdown('# 标题\n\n正文');
    takeMessages();
    assertEqual(mote.state().toc, false, '默认关闭');

    mote.toggleToc();
    var list = takeMessages();
    var views = messagesOfType(list, 'view');
    assertEqual(mote.state().toc, true, '打开');
    assertEqual(views[views.length - 1].toc, true, 'view.toc');
    assert(doc.body.classList.contains('toc-open'), 'body 应带 toc-open');
    flushTimers(1000);
    assert(doc.getElementById('toc-list').innerHTML.indexOf('toc-item') >= 0, '目录项已生成');

    mote.toggleToc();
    takeMessages();
    assertEqual(mote.state().toc, false, '关闭');
    assert(!doc.body.classList.contains('toc-open'), 'body 不应带 toc-open');
  });

  out('');
  out('合计：' + passed + '/' + total + ' 通过');
  if (failures.length) {
    out('');
    out('失败明细：');
    failures.forEach(function (item) {
      failLine('  - ' + item.name + '：' + (item.error && item.error.message
        ? item.error.message : item.error));
    });
    return finish(1);
  }
  return finish(0);
}

main();
