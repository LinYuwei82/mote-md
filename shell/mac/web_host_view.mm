#import "web_host_view.h"
#import "pdf_export.h"

#import <WebKit/WebKit.h>

#include <cstdio>
#include <cstdlib>
#include <unistd.h>

#include "core/perf.h"

@interface MoteWebHostView () <WKNavigationDelegate>
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic) NSUInteger pageGeneration;
@property(nonatomic, copy) NSString *pageFile;
@property(nonatomic, copy) NSString *mermaidFile;
@end

#include "web_host_view_drag.inc"
#include "web_host_view_bundle.inc"

@implementation MoteWebHostView

#include "web_host_view_init.inc"
#include "web_host_view_page.inc"
#include "web_host_view_api.inc"
#include "web_host_view_diag.inc"
#include "web_host_view_dealloc.inc"
#include "web_host_view_nav.inc"
@end
