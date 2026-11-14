#import "html_export.h"

#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

NSString *MoteInlineLocalImages(NSString *html, NSString *baseDir, int *missingCount)
{
    if (missingCount)
        *missingCount = 0;
    if (html.length == 0)
        return html;

    NSRegularExpression *regex = [NSRegularExpression
        regularExpressionWithPattern:@"<img\\b[^>]*?\\bsrc=\"([^\"]*)\"[^>]*>"
                             options:NSRegularExpressionCaseInsensitive
                               error:NULL];
    if (!regex)
        return html;

    const NSArray<NSTextCheckingResult *> *matches =
        [regex matchesInString:html options:0 range:NSMakeRange(0, html.length)];
    NSString *base = baseDir.length > 0 ? baseDir : NSHomeDirectory();

    NSMutableString *output = [NSMutableString stringWithCapacity:html.length];
    NSUInteger cursor = 0;
    int missing = 0;

    for (NSTextCheckingResult *match in matches) {
        [output appendString:[html substringWithRange:
            NSMakeRange(cursor, match.range.location - cursor)]];
        cursor = NSMaxRange(match.range);

        NSString *src = [html substringWithRange:[match rangeAtIndex:1]];
        NSString *trimmed = [src
            stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        const NSString *lowered = [trimmed lowercaseString];
        const BOOL remote = [lowered hasPrefix:@"data:"] || [lowered hasPrefix:@"http:"]
            || [lowered hasPrefix:@"https:"];
        if (trimmed.length == 0 || remote) {
            [output appendString:[html substringWithRange:match.range]];
            continue;
        }

        NSString *decoded = [trimmed stringByRemovingPercentEncoding] ?: trimmed;
        NSString *path = nil;
        if ([lowered hasPrefix:@"file:"]) {
            path = [NSURL URLWithString:trimmed].path;
        } else if ([decoded hasPrefix:@"/"]) {
            path = decoded; // 绝对路径不再拼 baseDir
        } else {
            path = [base stringByAppendingPathComponent:decoded];
        }
        NSData *data = path.length > 0 ? [NSData dataWithContentsOfFile:path] : nil;
        if (data.length == 0) {
            ++missing;
            [output appendFormat:@"<span class=\"mote-img-missing\">[图片缺失] %@</span>", src];
            continue;
        }

        UTType *type = path.pathExtension.length > 0
            ? [UTType typeWithFilenameExtension:path.pathExtension]
            : nil;
        NSString *mime = [type preferredMIMEType] ?: @"application/octet-stream";
        NSString *dataUri = [NSString stringWithFormat:@"data:%@;base64,%@", mime,
                                                       [data base64EncodedStringWithOptions:0]];
        NSString *original = [html substringWithRange:match.range];
        NSString *needle = [NSString stringWithFormat:@"src=\"%@\"", src];
        NSString *replacement = nil;
        if ([original containsString:needle]) {
            replacement = [original stringByReplacingOccurrencesOfString:needle
                                                              withString:
                [NSString stringWithFormat:@"src=\"%@\"", dataUri]];
        } else {
            // 属性里有换行等非常规写法时退回最简标签，至少保证图片能显示
            replacement = [NSString stringWithFormat:@"<img src=\"%@\">", dataUri];
        }
        [output appendString:replacement];
    }

    [output appendString:[html substringFromIndex:cursor]];
    if (missingCount)
        *missingCount = missing;
    return output;
}
