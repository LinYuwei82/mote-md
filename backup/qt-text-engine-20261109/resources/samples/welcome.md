# Mote · 使用说明

这是一个用 **C++20 + Qt 6** 写的 Markdown 查看 / 编辑桌面程序：不依赖任何第三方
Markdown 解析库，渲染完全交给 Qt 内置的 `QTextDocument::setMarkdown`。

## 快速上手

1. 点击工具栏的 **打开**（`Ctrl+O`），或直接把 `.md` 文件拖进窗口。
2. 左侧目录由文档标题自动生成，点击即可跳转到对应章节。
3. 按 `Ctrl+=` 放大、`Ctrl+-` 缩小、`Ctrl+0` 复位。
4. 点击 **编辑**（`Ctrl+E`）进入源码编辑，改完再点一次回到预览，`Ctrl+S` 保存。

> 提示：未保存的修改会在窗口标题上以 `*` 标记，关闭时还会再问一次。

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

带语言标识的围栏代码块会自动做语法高亮（关键字、字符串、注释、数字、函数 / 类型名），
没有写语言标识时只保留等宽字体与浅色背景。

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
BUILD_DIR="${TMPDIR:-/tmp}/mdviewer-build"
mkdir -p "$BUILD_DIR" && cd "$BUILD_DIR"
qmake6 /path/to/MarkdownViewer.pro && make -j4
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
| 打开 | `Ctrl+O` | 文件对话框选择 .md |
| 保存 | `Ctrl+S` | 保存当前文档 |
| 编辑 | `Ctrl+E` | 预览 / 编辑切换 |
| 放大 | `Ctrl+=` | 字号放大一级 |
| 缩小 | `Ctrl+-` | 字号缩小一级 |

### 图片

图片按 Markdown 文件所在目录解析相对路径，下面这张就是相对路径引用的示例：

![应用图标](sample-diagram.png)

## 关于本项目

- 界面：Qt Widgets，单一主窗口，左侧目录 + 右侧内容。
- 渲染：`QTextDocument::setMarkdown`（GitHub 方言，支持表格与删除线）。
- 高亮：读取代码围栏的语言标识，用自带的轻量着色器区分关键字、字符串、注释、数字与函数 / 类型名；
  不引入第三方解析库。
- 编辑：右侧切换为纯文本编辑器，保存时写回 UTF-8。
- 资源：图标、样式和这份示例文档全部通过 `.qrc` 编进可执行文件，不依赖外部路径。

---

祝你阅读愉快。
