import { useCallback, useEffect, useRef, useState } from 'react';

/** Fade image actions while idle, but keep them available during direct interaction. */
export function useLightboxControls(busy: boolean, notice?: string) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interaction = useRef({ hover: false, keyboard: false, busy });
  interaction.current.busy = busy;
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const reveal = useCallback(() => {
    setVisible(true);
    clearTimer();
    const state = interaction.current;
    if (state.hover || state.keyboard || state.busy) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const current = interaction.current;
      if (!current.hover && !current.keyboard && !current.busy) setVisible(false);
    }, 1800);
  }, [clearTimer]);
  const onPointerMove = useCallback(() => {
    interaction.current.keyboard = false;
    reveal();
  }, [reveal]);
  const onKeyboard = useCallback(() => {
    interaction.current.keyboard = true;
    reveal();
  }, [reveal]);
  const onPointerEnter = useCallback(() => {
    interaction.current.hover = true;
    reveal();
  }, [reveal]);
  const onPointerLeave = useCallback(() => {
    interaction.current.hover = false;
    reveal();
  }, [reveal]);
  useEffect(() => {
    reveal();
    return clearTimer;
  }, [busy, notice, reveal, clearTimer]);
  return { visible, onPointerMove, onKeyboard, onPointerEnter, onPointerLeave };
}
