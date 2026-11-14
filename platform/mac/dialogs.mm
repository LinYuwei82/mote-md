#import "dialogs.h"

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <cstdlib>
#include <string>

NSString *MoteOpenMarkdownPanel(NSString *suggestedDir)
{
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"打开 Markdown 文件";
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    if (suggestedDir.length > 0)
        panel.directoryURL = [NSURL fileURLWithPath:suggestedDir isDirectory:YES];

    NSMutableArray<UTType *> *types = [NSMutableArray array];
    for (NSString *ext in @[ @"md", @"markdown", @"mdown", @"mkd", @"txt" ]) {
        UTType *type = [UTType typeWithFilenameExtension:ext];
        if (type)
            [types addObject:type];
    }
    panel.allowedContentTypes = types;

    if ([panel runModal] != NSModalResponseOK)
        return nil;
    return panel.URL.path;
}

NSString *MoteSavePanel(NSString *title, NSString *suggestedPath, NSString *extension)
{
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.title = title;
    if (suggestedPath.length > 0) {
        panel.nameFieldStringValue = suggestedPath.lastPathComponent;
        panel.directoryURL = [NSURL fileURLWithPath:suggestedPath.stringByDeletingLastPathComponent
                                        isDirectory:YES];
    }
    panel.canCreateDirectories = YES;
    if (extension.length > 0) {
        UTType *type = [UTType typeWithFilenameExtension:extension];
        if (type)
            panel.allowedContentTypes = @[ type ];
        panel.allowsOtherFileTypes = YES;
    }

    if ([panel runModal] != NSModalResponseOK)
        return nil;
    return panel.URL.path;
}

MoteSaveChoice MoteConfirmUnsaved(NSString *displayName)
{
    // 诊断用（MOTE_ANSWER=cancel|discard|save）：跳过弹窗直接给出答案
    const char *forced = std::getenv("MOTE_ANSWER");
    if (forced) {
        const std::string value(forced);
        if (value == "cancel")
            return MoteSaveChoiceCancel;
        if (value == "discard")
            return MoteSaveChoiceDiscard;
        if (value == "save")
            return MoteSaveChoiceSave;
    }

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"未保存的修改";
    alert.informativeText =
        [NSString stringWithFormat:@"“%@”有尚未保存的修改，是否保存？", displayName];
    [alert addButtonWithTitle:@"保存"];
    [alert addButtonWithTitle:@"不保存"];
    [alert addButtonWithTitle:@"取消"];

    const NSModalResponse response = [alert runModal];
    if (response == NSAlertFirstButtonReturn)
        return MoteSaveChoiceSave;
    if (response == NSAlertSecondButtonReturn)
        return MoteSaveChoiceDiscard;
    return MoteSaveChoiceCancel;
}

void MoteAlert(NSString *title, NSString *message)
{
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = message ?: @"";
    [alert addButtonWithTitle:@"好"];
    [alert runModal];
}
