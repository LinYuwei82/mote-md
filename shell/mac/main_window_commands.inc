- (void)performCommand:(mote::CommandId)command
{
    const mote::CommandSpec *spec = mote::findCommand(command);
    if (MoteKeyLogEnabled() && spec)
        std::fprintf(stderr, "NATIVE command %s\n", spec->title.c_str());

    switch (command) {
    case mote::CommandId::New:
        [self newDocument];
        return;
    case mote::CommandId::NewWindow:
        [(id<MoteAppRouting>)NSApp.delegate openNewWindow];
        return;
    case mote::CommandId::Open:
        [self openDocument];
        return;
    case mote::CommandId::Save:
        [self beginSaveAs:NO];
        return;
    case mote::CommandId::SaveAs:
        [self beginSaveAs:YES];
        return;
    case mote::CommandId::ExportHtml:
        _controller->requestExportHtml(self.displayName.UTF8String);
        return;
    case mote::CommandId::ExportPdf:
        if (_sourceOn) {
            [self showStatus:@"源码模式下不能导出 PDF，先退出源码模式"];
            return;
        }
        [self exportPdf];
        return;
    case mote::CommandId::Undo:
        _controller->undo();
        return;
    case mote::CommandId::Redo:
        _controller->redo();
        return;
    // 标准编辑动作交给响应链：WebKit 自己处理选区、剪贴板与页面 copy/cut/paste 事件
    // 例外：自建跨块选区时原生选区是折叠的，WebKit 会判成「没有可复制内容」而
    // 不派发 copy/cut 事件；此时改走页面算内容、外壳写剪贴板这条回路。
    case mote::CommandId::Cut:
        if (_controller->crossSelection()) {
            _controller->clipboardCommand("cut");
            return;
        }
        [self sendResponderAction:@selector(cut:)];
        return;
    case mote::CommandId::Copy:
        if (_controller->crossSelection()) {
            _controller->clipboardCommand("copy");
            return;
        }
        [self sendResponderAction:@selector(copy:)];
        return;
    case mote::CommandId::Paste:
        [self sendResponderAction:@selector(paste:)];
        return;
    case mote::CommandId::SelectAll:
        [self sendResponderAction:@selector(selectAll:)];
        return;
    case mote::CommandId::ToggleToc:
        _controller->toggleToc();
        return;
    case mote::CommandId::ToggleSource:
        _controller->toggleSource();
        return;
    case mote::CommandId::ToggleDark:
        _followSystem = NO;
        _darkMode = !_darkMode;
        [self applyTheme];
        return;
    case mote::CommandId::FollowSystem:
        _followSystem = YES;
        [self applyTheme];
        return;
    case mote::CommandId::ZoomIn:
        _controller->zoomBy(1);
        return;
    case mote::CommandId::ZoomOut:
        _controller->zoomBy(-1);
        return;
    case mote::CommandId::ZoomReset:
        _controller->resetZoom();
        return;
    default:
        break;
    }

    // 剩余的是格式命令：动作名由 core 命令表给出，前端统一解释
    if (spec && !spec->formatAction.empty()) {
        _controller->applyFormat(spec->formatAction);
        return;
    }
}

- (void)sendResponderAction:(SEL)action
{
    [NSApp sendAction:action to:nil from:nil];
}

