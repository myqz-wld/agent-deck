// Exact expression extracted from src/renderer/App.tsx; no handwritten control flow.
export function sourceCallback(remoteHosts: any, logger: any) { return (value) => {
            if (value === 'local') {
              void remoteHosts.setSourceMode('local').catch((err: unknown) => logger.warn('[app] source switch failed', err));
              return;
            }
            const profileId = value.startsWith('remote:') ? value.slice('remote:'.length) : '';
            if (profileId) {
              void remoteHosts.selectProfile(profileId)
                .then(() => remoteHosts.setSourceMode('remote'))
                .catch((err: unknown) => logger.warn('[app] source switch failed', err));
            }
          }; }
