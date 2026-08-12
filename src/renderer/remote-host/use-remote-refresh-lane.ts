import { useEffect, useRef, useState } from 'react';

interface RemoteRefreshLaneOptions {
  enabled: boolean;
  identity: string;
  trigger: string;
  run(isCurrent: () => boolean): Promise<void>;
}

/** Keeps one request in flight per resource and collapses a burst into one follow-up. */
export function useRemoteRefreshLane(options: RemoteRefreshLaneOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(false);
  const laneRef = useRef({ key: '', generation: 0, running: false, dirty: false });
  const [kick, setKick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const lane = laneRef.current;
    const key = `${options.identity}\u0000${options.enabled ? 'enabled' : 'disabled'}`;
    if (lane.key !== key) {
      lane.key = key;
      lane.generation += 1;
      lane.running = false;
    }
    lane.dirty = true;
    setKick((value) => value + 1);
  }, [options.enabled, options.identity, options.trigger]);

  useEffect(() => {
    const lane = laneRef.current;
    if (lane.running || !lane.dirty) return;
    lane.running = true;
    const generation = lane.generation;
    const drain = async (): Promise<void> => {
      try {
        while (laneRef.current.dirty && mountedRef.current &&
          laneRef.current.generation === generation) {
          laneRef.current.dirty = false;
          const expected = optionsRef.current;
          if (!expected.enabled) continue;
          const isCurrent = (): boolean => {
            const current = optionsRef.current;
            return mountedRef.current && laneRef.current.generation === generation &&
              current.enabled &&
              current.identity === expected.identity && current.trigger === expected.trigger;
          };
          await expected.run(isCurrent);
        }
      } finally {
        if (laneRef.current.generation !== generation) return;
        laneRef.current.running = false;
        if (laneRef.current.dirty && mountedRef.current) setKick((value) => value + 1);
      }
    };
    void drain();
  }, [kick]);
}
