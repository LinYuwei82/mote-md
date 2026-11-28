- (BOOL)applicationShouldTerminate
{
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = MoteAfterSaveTerminate;
    _controller->requestSnapshot();
    return NO;
}

#pragma mark - NSWindowDelegate

- (void)windowWillClose:(NSNotification *)notification
{
    (void)notification;
    [NSNotificationCenter.defaultCenter postNotificationName:MoteWindowWillCloseNotification
                                                      object:self];
}

- (void)windowDidBecomeKey:(NSNotification *)notification
{
    (void)notification;
    [self updateMenuStates];
}

- (BOOL)windowShouldClose:(NSWindow *)sender
{
    (void)sender;
    if (!_controller->dirty())
        return YES;

    const MoteSaveChoice choice = MoteConfirmUnsaved([self displayName]);
    if (choice == MoteSaveChoiceCancel)
        return NO;
    if (choice == MoteSaveChoiceDiscard)
        return YES;

    self.afterSave = MoteAfterSaveClose;
    _controller->requestSnapshot();
    return NO;
}

