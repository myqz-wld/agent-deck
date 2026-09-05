from pathlib import Path
import hashlib,json,subprocess
root=Path.cwd()
scratch=root/'.ref/reviews/2026-09-04-quality-remediation/runtime'
scratch.mkdir(parents=True, exist_ok=True)
claude='src/main/adapters/claude-code/sdk-bridge/'
claude_names=['permission-responder-core.test.ts','session-rollback-core.test.ts','session-lifecycle-core.test.ts','session-lifecycle-host.test.ts','user-message-stream-core.test.ts','user-message-stream-host.test.ts','user-message-acceptance-core.test.ts','message-controller-core.test.ts','pending-outgoing-core.test.ts','pending-cancellation-core.test.ts','stream-finalize-core.test.ts','__tests__/stream-processor-retirement.test.ts','__tests__/stream-processor-user-message.test.ts']
grok='src/main/adapters/grok-build/'
grok_names=['__tests__/pending-outgoing.test.ts','__tests__/turn-queue.test.ts','__tests__/runtime-lifecycle-coordinator.test.ts','__tests__/transport-recovery.test.ts','__tests__/cwd-transition-controller.test.ts','__tests__/provider-completion-recovery.test.ts','__tests__/first-model-event-watchdog.test.ts','session-command-feedback.test.ts']
codex='src/main/adapters/codex-cli/'
codex_names=['sdk-bridge/__tests__','sdk-bridge/fork-session/create-forked-session.test.ts','sdk-bridge/fork-session/two-client-fork.integration.test.ts','sdk-bridge/session-command-controller.test.ts','__tests__/sdk-bridge.consume-fork.test.ts','__tests__/sdk-bridge.restart.test.ts','__tests__/wire-prefix-e2e.test.ts','__tests__/per-session-codex-env.test.ts']
paths=[claude+n for n in claude_names]+[grok+n for n in grok_names]+[codex+n for n in codex_names]
assert all(Path(p).exists() for p in paths)
command=['pnpm','run','test',*paths,'--maxWorkers=1','--minWorkers=1']
(scratch/'focused-command.txt').write_text(' '.join(command)+'\n')
binding=Path('node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node')
def fingerprint(): return hashlib.sha256(binding.read_bytes()).hexdigest()
before=fingerprint()
result=subprocess.run(command,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
after=fingerprint()
output=result.stdout.replace(str(root),'.').replace(str(Path.home()),'$HOME')
(scratch/'focused-tests.txt').write_text(output)
(scratch/'binding-fingerprint.json').write_text(json.dumps({'path':str(binding),'before':before,'after':after,'unchanged':before==after},indent=2)+'\n')
print('\n'.join(output.splitlines()[-12:]))
print('Binding unchanged:',before==after)
raise SystemExit(result.returncode if before==after else 1)
