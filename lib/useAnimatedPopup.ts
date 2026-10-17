import { useEffect, useState } from "react";

/** Returns { visible, className } to drive a bottom→top slide animation. */
export function useAnimatedPopup(open: boolean, exitDuration = 110) {
  const [visible, setVisible] = useState(open);
  const [phase, setPhase]     = useState<"enter" | "exit">("enter");
  const [prevOpen, setPrevOpen] = useState(open);

  // Adjust state while rendering when `open` flips (no extra effect pass).
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setVisible(true);
      setPhase("enter");
    } else {
      setPhase("exit");
    }
  }

  // Unmount after the exit animation.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setVisible(false), exitDuration);
    return () => clearTimeout(t);
  }, [open, exitDuration]);

  return { visible, className: phase === "enter" ? "float-menu-enter" : "float-menu-exit" };
}
