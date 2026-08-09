import Darwin
import Foundation

private let maximumBookmarkBytes = 1024 * 1024

private struct LaunchInput {
  let bookmarkPath: String
  let workspacePath: String
  let executable: String
  let arguments: ArraySlice<String>
}

private func fail(_ stage: String = "input") -> Never {
  fputs("Worker 沙盒启动失败（\(stage)）。\n", stderr)
  exit(70)
}

private func canonicalPath(_ path: String, kind: mode_t) -> String? {
  guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { return nil }
  defer { free(resolved) }
  let canonical = String(cString: resolved)
  guard canonical == path else { return nil }
  var status = stat()
  guard lstat(path, &status) == 0, (status.st_mode & S_IFMT) == kind else { return nil }
  return canonical
}

private func parseInput() -> LaunchInput? {
  let values = Array(CommandLine.arguments.dropFirst())
  guard
    values.count >= 6,
    values[0] == "--bookmark",
    values[2] == "--workspace",
    values[4] == "--",
    !values[5].isEmpty
  else { return nil }
  return LaunchInput(
    bookmarkPath: values[1],
    workspacePath: values[3],
    executable: values[5],
    arguments: values.dropFirst(6)
  )
}

private func readPrivateBookmark(_ path: String) -> Data? {
  guard path.hasPrefix("/") else { return nil }
  let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  guard descriptor >= 0 else { return nil }
  defer { close(descriptor) }
  var status = stat()
  guard
    fstat(descriptor, &status) == 0,
    (status.st_mode & S_IFMT) == S_IFREG,
    (status.st_mode & 0o777) == 0o600,
    status.st_uid == getuid(),
    status.st_size > 0,
    status.st_size <= maximumBookmarkBytes
  else { return nil }
  var output = Data(count: Int(status.st_size))
  let complete = output.withUnsafeMutableBytes { rawBuffer -> Bool in
    guard let base = rawBuffer.baseAddress else { return false }
    var offset = 0
    while offset < rawBuffer.count {
      let count = Darwin.read(descriptor, base.advanced(by: offset), rawBuffer.count - offset)
      if count <= 0 { return false }
      offset += count
    }
    return true
  }
  return complete ? output : nil
}

private func resolveBookmark(_ data: Data) throws -> URL {
  var stale = false
  return try URL(
    resolvingBookmarkData: data,
    options: [],
    relativeTo: nil,
    bookmarkDataIsStale: &stale
  )
}

private func exec(_ input: LaunchInput) -> Never {
  guard input.workspacePath.hasPrefix("/") else { fail("workspace-input") }
  guard let bookmark = readPrivateBookmark(input.bookmarkPath) else { fail("bookmark") }
  do {
    let authorized = try resolveBookmark(bookmark)
    guard let workspace = canonicalPath(input.workspacePath, kind: S_IFDIR) else {
      fail("workspace-identity")
    }
    guard canonicalPath(authorized.path, kind: S_IFDIR) == workspace else {
      fail("bookmark-identity")
    }
    guard canonicalPath(input.executable, kind: S_IFREG) != nil else {
      fail("executable-identity")
    }
    guard chdir(workspace) == 0 else { fail("workspace-chdir") }
  } catch {
    fail("bookmark-resolve")
  }

  // The trusted Worker owns transport/Core state. Model-facing filesystem isolation is applied by
  // the provider child itself; macOS rejects a second Seatbelt policy nested under an outer one.
  let values = [input.executable] + Array(input.arguments)
  var argv = values.map { strdup($0) as UnsafeMutablePointer<CChar>? }
  argv.append(nil)
  execv(input.executable, &argv)
  perror("agent-deck-worker-sandbox execv")
  fail("exec")
}

guard let input = parseInput() else { fail("input") }
exec(input)
