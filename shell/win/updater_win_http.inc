// 同步 GET，只在后台线程里调用；失败时 error 给出中文原因
bool fetch_url(const std::wstring &url, std::string *body, std::wstring *error)
{
    URL_COMPONENTS parts = {};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
        if (error)
            *error = L"更新地址不合法";
        return false;
    }

    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0)
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);

    const InternetHandle session(
        WinHttpOpen(L"Mote/" MOTE_VERSION, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.get()) {
        if (error)
            *error = L"无法初始化网络会话";
        return false;
    }
    WinHttpSetTimeouts(session.get(), kRequestTimeoutMs, kRequestTimeoutMs,
                       kRequestTimeoutMs, kRequestTimeoutMs);

    const InternetHandle connection(
        WinHttpConnect(session.get(), host.c_str(), parts.nPort, 0));
    if (!connection.get()) {
        if (error)
            *error = L"无法连接更新服务器";
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
    const InternetHandle request(WinHttpOpenRequest(connection.get(), L"GET", path.c_str(),
                                                    nullptr, WINHTTP_NO_REFERER,
                                                    WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
    if (!request.get()) {
        if (error)
            *error = L"无法创建更新请求";
        return false;
    }

    if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.get(), nullptr)) {
        if (error)
            *error = L"请求更新清单失败" + std::to_wstring(GetLastError());
        return false;
    }

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(),
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                             WINHTTP_NO_HEADER_INDEX)) {
        if (error)
            *error = L"无法读取服务器响应";
        return false;
    }
    if (status != 200) {
        if (error)
            *error = L"服务器返回 HTTP " + std::to_wstring(status);
        return false;
    }

    body->clear();
    std::vector<char> buffer(16 * 1024);
    for (;;) {
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), buffer.data(),
                             static_cast<DWORD>(buffer.size()), &read)) {
            if (error)
                *error = L"读取更新清单失败";
            return false;
        }
        if (read == 0)
            break;
        body->append(buffer.data(), read);
    }
    return true;
}

// 流式下载到本地文件；只在后台线程调用
// retryable（输出）：失败时置 true 表示网络/服务器临时问题，调用方可重试；
//                   false 表示地址非法 / 磁盘权限 / 4xx 等不可恢复错误。
bool download_file(const std::wstring &url, const std::filesystem::path &dest,
                   DownloadState *state, bool *retryable)
{
    if (retryable) *retryable = false;

    URL_COMPONENTS parts = {};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) {
        state->error = L"更新地址不合法";
        return false;
    }

    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0)
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);

    const InternetHandle session(
        WinHttpOpen(L"Mote/" MOTE_VERSION, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.get()) {
        state->error = L"无法初始化网络会话";
        if (retryable) *retryable = true;
        return false;
    }
    // 下载可能较慢：连接/发送用短超时，接收放宽到 60 秒
    WinHttpSetTimeouts(session.get(), kRequestTimeoutMs, kRequestTimeoutMs, 60 * 1000,
                       kRequestTimeoutMs);

    const InternetHandle connection(WinHttpConnect(session.get(), host.c_str(), parts.nPort, 0));
    if (!connection.get()) {
        state->error = L"无法连接更新服务器";
        if (retryable) *retryable = true;
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
    const InternetHandle request(WinHttpOpenRequest(connection.get(), L"GET", path.c_str(),
                                                    nullptr, WINHTTP_NO_REFERER,
                                                    WINHTTP_DEFAULT_ACCEPT_TYPES, flags));
    if (!request.get()) {
        state->error = L"无法创建下载请求";
        if (retryable) *retryable = true;
        return false;
    }
    if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.get(), nullptr)) {
        state->error = L"下载请求失败";
        if (retryable) *retryable = true;
        return false;
    }

    DWORD status = 0;
    DWORD status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(),
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                             WINHTTP_NO_HEADER_INDEX)) {
        state->error = L"无法读取服务器响应";
        if (retryable) *retryable = true;
        return false;
    }
    if (status != 200) {
        state->error = L"服务器返回 HTTP " + std::to_wstring(status);
        // 5xx 服务器临时错误可重试；4xx（404/403/401 等）直接放弃
        if (retryable) *retryable = status >= 500 && status < 600;
        return false;
    }

    // 读 Content-Length：有了才启用百分比进度条
    ULONGLONG content_len = 0;
    DWORD cl_size = sizeof(content_len);
    if (WinHttpQueryHeaders(request.get(),
                            WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER64,
                            WINHTTP_HEADER_NAME_BY_INDEX, &content_len, &cl_size,
                            WINHTTP_NO_HEADER_INDEX)) {
        state->expected_size.store(static_cast<long long>(content_len));
    }

    HANDLE file = CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        state->error = L"无法写入临时文件";
        return false;
    }

    bool ok = true;
    std::vector<char> buffer(64 * 1024);
    for (;;) {
        if (state->cancel.load()) {
            ok = false;
            break;
        }
        DWORD read = 0;
        if (!WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()),
                             &read)) {
            state->error = L"下载中断";
            ok = false;
            if (retryable) *retryable = true;
            break;
        }
        if (read == 0)
            break;
        DWORD written = 0;
        if (!WriteFile(file, buffer.data(), read, &written, nullptr) || written != read) {
            state->error = L"写入更新包失败";
            ok = false;
            break;
        }
        state->written += written;
    }
    CloseHandle(file);
    return ok;
}

