
#pragma mark - 最近打开（NSUserDefaults）

namespace {

// 与 updater.mm 的 MacStore 同一存储口径：NSUserDefaults，键名加 "Mote" 前缀
class DefaultsStore final : public mote::SettingsStore
{
public:
    std::string getString(const std::string &key) override
    {
        NSString *value = [NSUserDefaults.standardUserDefaults stringForKey:DefaultKey(key)];
        return value ? std::string(value.UTF8String) : std::string();
    }
    void setString(const std::string &key, const std::string &value) override
    {
        NSString *text = [NSString stringWithUTF8String:value.c_str()];
        [NSUserDefaults.standardUserDefaults setObject:text ?: @"" forKey:DefaultKey(key)];
    }
    void clearString(const std::string &key) override
    {
        [NSUserDefaults.standardUserDefaults removeObjectForKey:DefaultKey(key)];
    }
    std::string newInstallId() override { return std::string(); }

private:
    static NSString *DefaultKey(const std::string &key)
    {
        return [NSString stringWithUTF8String:("Mote" + key).c_str()];
    }
};

DefaultsStore gDefaultsStore;

} // namespace

@implementation MoteRecentFiles {
    std::unique_ptr<mote::RecentFiles> _recent;
}

+ (instancetype)shared
{
    static MoteRecentFiles *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[MoteRecentFiles alloc] init];
    });
    return instance;
}

- (instancetype)init
{
    self = [super init];
    if (self)
        _recent = std::make_unique<mote::RecentFiles>(gDefaultsStore);
    return self;
}

- (void)addPath:(NSString *)path
{
    if (path.length == 0)
        return;
    _recent->add(path.UTF8String);
}

- (NSArray<NSString *> *)paths
{
    NSMutableArray<NSString *> *result = [NSMutableArray array];
    for (const std::string &path : _recent->list()) {
        NSString *value = [NSString stringWithUTF8String:path.c_str()];
        if (value)
            [result addObject:value];
    }
    return result;
}

- (void)clear { _recent->clear(); }

@end

#pragma mark - 主窗口

// 菜单项按 tag 索引：应用级构建一次，各窗口按自身状态同步勾选
static NSDictionary<NSNumber *, NSMenuItem *> *gCommandItems = nil;
