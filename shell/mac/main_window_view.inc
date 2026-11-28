- (void)applyViewState:(const mote::ViewState &)state
{
    _tocOn = state.toc;
    _sourceOn = state.source;
    [self updateMenuStates];
    if (MoteKeyLogEnabled())
        std::fprintf(stderr, "NATIVE view toc=%d source=%d zoom=%.2f\n", state.toc ? 1 : 0,
                     state.source ? 1 : 0, state.zoom);
    if (std::abs(state.zoom - _lastZoom) > 0.001) {
        _lastZoom = state.zoom;
        [self showStatus:[NSString stringWithFormat:@"缩放：%d%%", (int)lround(state.zoom * 100)]];
    }
}

- (void)updateMenuStates
{
    // 菜单是应用级共享的：只有 keyWindow 的状态才反映到菜单上
    if (!self.window.isKeyWindow)
        return;
    void (^setState)(mote::CommandId, BOOL) = ^(mote::CommandId id, BOOL on) {
        NSMenuItem *item = gCommandItems[@(static_cast<NSInteger>(id))];
        item.state = on ? NSControlStateValueOn : NSControlStateValueOff;
    };
    setState(mote::CommandId::ToggleToc, _tocOn);
    setState(mote::CommandId::ToggleSource, _sourceOn);
    setState(mote::CommandId::ToggleDark, _darkMode);
    setState(mote::CommandId::FollowSystem, _followSystem);

    NSMenuItem *pdf = gCommandItems[@(static_cast<NSInteger>(mote::CommandId::ExportPdf))];
    pdf.enabled = !_sourceOn;
}

#pragma mark - 主题

- (BOOL)systemIsDark
{
    NSAppearanceName name = [NSApp.effectiveAppearance
        bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
    return [name isEqualToString:NSAppearanceNameDarkAqua];
}

- (void)applyTheme
{
    if (_followSystem)
        _darkMode = [self systemIsDark];
    _controller->setTheme(_darkMode ? "dark" : "light");
    [self updateMenuStates];
}

