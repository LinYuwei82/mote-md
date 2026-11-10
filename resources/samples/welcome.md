# Mote · 使用说明

这是一个 **C++20 + Qt 6** 外壳加系统 WebView 的 Markdown 编辑器：窗口、文件对话框与
保存由 Qt 负责，正文的渲染与编辑交给系统 WebView（macOS 上是 `WKWebView`）里的
前端页面完成，不引入任何前端框架与外部运行时。

## 快速上手

1. 点击工具栏的 **打开**（`Cmd+O`），或直接把 `.md` 文件拖进窗口。
2. 直接点击正文即可编辑：当前块显示 Markdown 原文，其余块保持排版效果。
3. 点击别处结束编辑，修改会自动写回文档；`Cmd+S` 保存回原文件。

> 提示：未保存的修改会在关闭按钮上显示圆点，关闭窗口时还会再问一次。

## 支持的排版元素

### 文本

普通段落、**加粗**、*斜体*、~~删除线~~、`行内代码`，以及
[Qt 官网链接](https://www.qt.io)。

### 列表

无序列表：

- 拖拽打开
- 目录跳转
- 字号缩放

有序列表：

1. 打开文档
2. 阅读或编辑
3. 保存退出

### 代码块

围栏代码块会保留等宽字体、浅色背景与左侧行号。语法高亮在新架构里尚未接入，
代码目前以纯文本显示。

```cpp
// 代码块使用等宽字体，并带浅色背景
#include <QTextDocument>

int main(int argc, char *argv[])
{
    QTextDocument doc;
    doc.setMarkdown(QStringLiteral("# 你好，Markdown"));
    return 0;
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
  "keywords": ["markdown", "qt6"],
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
mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"
qmake6 /path/to/Mote.pro && make -j4
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

CMake（这里只是示例，本项目用 qmake）：

```cmake
cmake_minimum_required(VERSION 3.21)
project(Mote LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
add_executable(Mote src/main.cpp src/mainwindow.cpp)
target_link_libraries(Mote PRIVATE Qt6::Widgets)
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
| 粗体 / 斜体 / 链接 | `Cmd+B` / `Cmd+I` / `Cmd+K` | 再按一次取消 |
| 标题 1/2/3 | `Cmd+1/2/3` | 同级别再按一次回正文 |
| 行内代码 / 代码块 | `Cmd+Shift+K` / `Cmd+Shift+C` | 整块转换 |
| 无序 / 有序列表 | `Cmd+Shift+8` / `Cmd+Shift+7` | 多选可合并成一个列表 |
| 引用 / 表格 | `Cmd+Shift+B` / `Cmd+Shift+T` | 目录改为 `Cmd+Shift+L` |
| 斜杠命令 | 行首输入 `/` | 上下键选择，Enter 插入，Esc 取消 |
| 转为 | 右键任意块 | 正文 / 标题 / 列表 / 引用 / 代码块 |

### 图片

图片按 Markdown 文件所在目录解析相对路径，下面这张就是相对路径引用的示例：

![应用图标](sample-diagram.png)

## 关于本项目

- 界面：Qt Widgets 外壳（窗口、工具栏、文件对话框、保存），正文由系统 WebView 承载。
- 渲染：前端按空行切块，聚焦块显示 Markdown 原文，其余块渲染为 HTML。
- 高亮：暂未接入，代码块目前为等宽纯文本 + 行号。
- 编辑：直接点击正文，保存时把整篇 Markdown 写回 UTF-8。
- 资源：图标、样式、前端页面和这份示例文档全部通过 `.qrc` 编进可执行文件，不依赖外部路径。

---

祝你阅读愉快。
