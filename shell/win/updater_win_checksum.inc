// ---- 下载与校验 ----

std::wstring url_file_name(const std::wstring &url)
{
    std::wstring path = url;
    const size_t query = path.find(L'?');
    if (query != std::wstring::npos)
        path.resize(query);
    const size_t slash = path.find_last_of(L'/');
    std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
    if (name.empty())
        name = L"Mote-update.bin";
    return name;
}

std::string to_hex(const std::vector<UCHAR> &bytes)
{
    static const char digits[] = "0123456789abcdef";
    std::string hex;
    hex.reserve(bytes.size() * 2);
    for (UCHAR byte : bytes) {
        hex.push_back(digits[byte >> 4]);
        hex.push_back(digits[byte & 0x0F]);
    }
    return hex;
}

bool sha256_file(const std::filesystem::path &path, std::string *hex)
{
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return false;

    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_size = 0;
    DWORD digest_size = 0;
    DWORD produced = 0;
    bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0
        && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                             reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
                             &produced, 0) == 0
        && BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                             reinterpret_cast<PUCHAR>(&digest_size), sizeof(digest_size),
                             &produced, 0) == 0;

    std::vector<UCHAR> object;
    std::vector<UCHAR> digest;
    if (ok) {
        object.resize(object_size);
        digest.resize(digest_size);
        ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) == 0;
    }

    std::vector<UCHAR> buffer(64 * 1024);
    while (ok) {
        DWORD read = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
            ok = false;
            break;
        }
        if (read == 0)
            break;
        ok = BCryptHashData(hash, buffer.data(), read, 0) == 0;
    }
    if (ok)
        ok = BCryptFinishHash(hash, digest.data(), digest_size, 0) == 0;
    if (ok)
        *hex = to_hex(digest);

    if (hash)
        BCryptDestroyHash(hash);
    if (algorithm)
        BCryptCloseAlgorithmProvider(algorithm, 0);
    CloseHandle(file);
    return ok;
}

bool equals_ignore_case(const std::string &left, const std::string &right)
{
    if (left.size() != right.size())
        return false;
    for (size_t i = 0; i < left.size(); ++i) {
        const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(left[i])));
        const char b = static_cast<char>(std::tolower(static_cast<unsigned char>(right[i])));
        if (a != b)
            return false;
    }
    return true;
}

struct DownloadState {
    std::atomic<bool> finished{false};
    std::atomic<bool> cancel{false};
    std::atomic<long long> written{0};
    std::atomic<long long> expected_size{0}; // 只读，Content-Length 读到后赋值
    std::string expected_sha256; // 只读，线程启动前赋值
    std::string manifest_text;   // 只读，原始清单 JSON；下载完成后复验用
    bool ok = false;
    std::wstring error;
    std::filesystem::path path;
};

class InternetHandle {
public:
    explicit InternetHandle(HINTERNET handle) : handle_(handle) {}
    ~InternetHandle()
    {
        if (handle_)
            WinHttpCloseHandle(handle_);
    }
    InternetHandle(const InternetHandle &) = delete;
    InternetHandle &operator=(const InternetHandle &) = delete;
    HINTERNET get() const { return handle_; }

private:
    HINTERNET handle_ = nullptr;
};

