import Darwin
import Foundation

private let maximumBookmarkBytes = 1024 * 1024

private func fail() -> Never {
  fputs("Worker 工作区授权创建失败。\n", stderr)
  exit(70)
}

private func canonicalDirectory(_ path: String) -> URL? {
  guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { return nil }
  defer { free(resolved) }
  let canonical = String(cString: resolved)
  guard canonical == path else { return nil }
  var status = stat()
  guard lstat(path, &status) == 0, (status.st_mode & S_IFMT) == S_IFDIR else { return nil }
  return URL(fileURLWithPath: canonical, isDirectory: true)
}

private func writeExclusive(_ data: Data, to path: String) -> Bool {
  guard data.count > 0, data.count <= maximumBookmarkBytes else { return false }
  let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  guard descriptor >= 0 else { return false }
  var success = false
  defer {
    if !success { unlink(path) }
    close(descriptor)
  }
  success = data.withUnsafeBytes { rawBuffer in
    guard let base = rawBuffer.baseAddress else { return false }
    var offset = 0
    while offset < rawBuffer.count {
      let count = Darwin.write(descriptor, base.advanced(by: offset), rawBuffer.count - offset)
      if count <= 0 { return false }
      offset += count
    }
    return fsync(descriptor) == 0
  }
  return success
}

guard CommandLine.arguments.count == 4, CommandLine.arguments[1] == "create" else {
  fail()
}
guard let source = canonicalDirectory(CommandLine.arguments[2]) else { fail() }
let destination = CommandLine.arguments[3]
guard destination.hasPrefix("/"), canonicalDirectory(URL(fileURLWithPath: destination).deletingLastPathComponent().path) != nil else {
  fail()
}

do {
  // A standard URL bookmark is intentionally used here. A separately sandboxed process resolves
  // it and receives a fresh implicit security scope without requiring the desktop app itself to be
  // App-Sandboxed or relying on MAS-only dialog return values.
  let bookmark = try source.bookmarkData(
    options: [],
    includingResourceValuesForKeys: nil,
    relativeTo: nil
  )
  guard writeExclusive(bookmark, to: destination) else { fail() }
} catch {
  fail()
}
