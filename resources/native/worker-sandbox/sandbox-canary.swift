import Foundation

guard CommandLine.arguments.count == 3 else { exit(64) }
do {
  let inside = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
  guard inside.trimmingCharacters(in: .whitespacesAndNewlines) == "inside" else { exit(65) }
} catch {
  exit(66)
}

do {
  _ = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
  exit(67)
} catch {
  print("workspace-read-ok outside-read-denied")
}
