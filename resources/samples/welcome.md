# Mote · 使用说明

Mote 是一个 **C++20 原生薄外壳 + 系统 WebView** 的 Markdown 查看 / 编辑器。窗口、菜单、
文件对话框、导出与剪贴板由原生外壳负责：macOS 用 AppKit + `WKWebView`（发布包不含 Qt），
Windows 用 Win32 + WebView2（实现到 N3，尚未通过实机验证）。正文的渲染与编辑交给系统
WebView 里的前端页面完成，不引入任何前端框架与外部运行时。

## 快速上手

1. 用「文件 → 打开」（`Cmd+O`），或直接把 `.md` 文件拖进窗口。
2. 直接点击正文即可编辑：当前块显示 Markdown 原文，其余块保持排版效果。
3. 点击别处结束编辑，修改会自动写回文档；`Cmd+S` 保存回原文件。
4. 多篇文档并行：一个窗口一篇，外部打开或「文件 → 新建窗口」（`Cmd+Shift+N`）都会开新窗；已在窗口里打开的文件再打开会自动聚焦那个窗口。「文件 → 最近打开」列出最近 10 个文件。

> 提示：未保存的修改会在窗口标题上标出 `*`（macOS 关闭按钮上还会出现圆点），
> 关闭或打开另一个文件时还会再问一次。Windows 上把 `Cmd` 换成 `Ctrl`、
> `Option` 换成 `Alt`。

## 支持的排版元素

### 文本

普通段落、**加粗**、*斜体*、`行内代码`，以及
[外部链接](https://www.apple.com)（外部链接用 `Cmd+Click` 打开，普通点击仍是进入编辑）。

### 列表

无序列表：

- 拖拽打开
- 目录跳转
- 字号缩放

有序列表：

1. 打开文档
2. 阅读或编辑
3. 保存退出

任务列表（复选框可直接点，原文里的 `[ ]` / `[x]` 会跟着变）：

- [x] 打开一份文档
- [ ] 试着切换源码模式（`Cmd+E`）
- [ ] 导出一份 PDF 或 HTML

### 代码块

围栏代码块会保留等宽字体、浅色背景与左侧行号，并按语言做语法高亮。

```cpp
// 代码块使用等宽字体，并带浅色背景
#include <string>
#include <vector>

std::vector<int> fibonacci(int n)
{
    std::vector<int> result;
    int a = 0;
    int b = 1;
    while (static_cast<int>(result.size()) < n) {
        result.push_back(a);
        const int next = a + b;
        a = b;
        b = next;
    }
    return result;
}
```

Python：

```python
# 计算斐波那契数列
def fib(n: int) -> list:
    """返回前 n 个斐波那契数"""
    result = []
    a, b = 0, 1
    while len(result) < n:
        result.append(a)
        a, b = b, a + b
    return result
```

JavaScript：

```javascript
// 按标题生成目录条目
const headings = [...document.querySelectorAll("h1, h2, h3")];
const toc = headings.map((node, index) => ({
  id: index,
  level: Number(node.tagName.slice(1)),
  text: node.textContent.trim(),
}));
console.log(`共 ${toc.length} 个标题`);
```

JSON：

```json
{
  "name": "Mote",
  "version": "1.0.0",
  "keywords": ["markdown", "native", "webview"],
  "enabled": true,
  "zoom": 1.0
}
```

HTML：

```html
<!-- 一段最小的 HTML 片段 -->
<!DOCTYPE html>
<html lang="zh-CN">
  <body>
    <h1 class="title">你好</h1>
    <p data-role="hint">把 .md 文件拖进窗口即可打开。</p>
  </body>
</html>
```

Shell：

```bash
#!/usr/bin/env bash
# 在临时目录做一次干净构建
BUILD_DIR="${TMPDIR:-/tmp}/mote-build"
cmake -S native -B "$BUILD_DIR"
cmake --build "$BUILD_DIR"
ctest --test-dir "$BUILD_DIR"
```

SQL：

```sql
-- 统计每个分类下的文档数量
SELECT category_id, COUNT(*) AS total
FROM documents
WHERE deleted_at IS NULL
GROUP BY category_id
HAVING COUNT(*) > 1
ORDER BY total DESC
LIMIT 10;
```

CMake（Mote 的原生构建即用 CMake，这里只是示例）：

```cmake
cmake_minimum_required(VERSION 3.25)
project(Mote LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
add_executable(Mote native/main.mm native/main_window.mm)
target_link_libraries(Mote PRIVATE "-framework Cocoa" "-framework WebKit")
```

没有语言标识的代码块（保持纯文本样式）：

```
plain text, no highlighting
second line
```

### 表格

| 功能 | 快捷键 | 说明 |
| --- | --- | --- |
| 打开 | `Cmd+O` | 文件对话框选择 .md |
| 保存 | `Cmd+S` | 保存当前文档 |
| 另存为 | `Cmd+Shift+S` | 写入新文件 |
| 新建 | `Cmd+N` | 空白文档，标题「未命名 - Mote」 |
| 查找替换 | `Cmd+F` | 跨块跳转命中，不破坏行内标记 |
| 粗体 / 斜体 / 链接 | `Cmd+B` / `Cmd+I` / `Cmd+K` | 再按一次取消 |
| 标题 1/2/3 | `Cmd+1/2/3` | 同级别再按一次回正文 |
| 行内代码 / 代码块 | `Cmd+Shift+K` / `Cmd+Shift+C` | 整块转换 |
| 无序 / 有序列表 | `Cmd+Shift+8` / `Cmd+Shift+7` | 多选可合并成一个列表 |
| 引用 / 表格 | `Cmd+Shift+B` / `Cmd+Shift+T` | 整块转换为引用 / 表格 |
| 目录 / 源码模式 | `Cmd+Shift+L` / `Cmd+E` | 目录开关 / 纯文本切换 |
| 导出 HTML | `Option+Cmd+E` | 单文件自包含 HTML |
| 导出 PDF | `Cmd+P` | A4 多页（当前仅 macOS；源码模式下禁用） |
| 斜杠命令 | 行首输入 `/` | 上下键选择，Enter 插入，Esc 取消 |
| 转为 | 右键任意块 | 正文 / 标题 / 列表 / 引用 / 代码块 |

### 图片

图片按 Markdown 文件所在目录解析相对路径，下面这张就是相对路径引用的示例：

![应用图标](sample-diagram.png)

拖入或粘贴的图片会保存到文档同目录的 `assets/`，并插入相对路径。

## 关于本项目

- 外壳：macOS 用 AppKit + `WKWebView`，Windows 用 Win32 + WebView2；两端共用同一份前端页面与 `core/`。
- 渲染：前端按空行切块，聚焦块显示 Markdown 原文，其余块渲染为 HTML。
- 高亮：正文预览按语言着色；源码模式（`Cmd+E`）为纯文本。
- 状态栏：画在页面底部，显示打开 / 保存 / 导出的提示与「中文 N 字 · 英文 M 词」字数统计。
- 编辑：直接点击正文，保存时把整篇 Markdown 写回 UTF-8。
- 导出：macOS 已支持 PDF（A4 多页）与单文件 HTML；Windows 侧的导出计划在 N4 实现。
- 资源：图标、样式、前端页面和这份示例文档都随应用一起打包，不依赖外部路径。

---

祝你阅读愉快。
