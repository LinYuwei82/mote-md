#pragma once

#import <Cocoa/Cocoa.h>

typedef NS_ENUM(NSInteger, MoteSaveChoice) {
    MoteSaveChoiceSave = 0,
    MoteSaveChoiceDiscard = 1,
    MoteSaveChoiceCancel = 2,
};

// 打开 Markdown：返回绝对路径，取消返回 nil
NSString *MoteOpenMarkdownPanel(NSString *suggestedDir);

// 保存面板：suggestedPath 是完整建议路径；返回绝对路径，取消返回 nil
NSString *MoteSavePanel(NSString *title, NSString *suggestedPath, NSString *extension);

// 未保存确认：保存 / 不保存 / 取消；MOTE_ANSWER=save|discard|cancel 可跳过弹窗（自动化）
MoteSaveChoice MoteConfirmUnsaved(NSString *displayName);

void MoteAlert(NSString *title, NSString *message);
