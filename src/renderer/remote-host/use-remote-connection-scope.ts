import { useRef } from 'react';

/** Separates requests made before and after a same-identity connection interruption. */
export function useRemoteConnectionScope(identity: string, usable: boolean): string {
  const state = useRef({ identity, usable, generation: 0 });
  if (state.current.identity !== identity) {
    state.current = { identity, usable, generation: 0 };
  } else if (state.current.usable !== usable) {
    state.current = {
      identity,
      usable,
      generation: state.current.generation + 1,
    };
  }
  return `${identity}\0${state.current.generation}`;
}
