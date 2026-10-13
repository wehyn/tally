"use client";

import { useEffect, useRef, type MouseEventHandler, type ReactNode, type TransitionEventHandler } from "react";

export function ModalPresence({ open, className = "", onMouseDown, onTransitionEnd, children }: {
  open: boolean;
  className?: string;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
  onTransitionEnd?: TransitionEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) backdropRef.current?.querySelector<HTMLElement>("[autofocus]")?.focus();
  }, [open]);

  return <div ref={backdropRef} className={`modal-backdrop${className ? ` ${className}` : ""}`} data-open={String(open)} hidden={!open} aria-hidden={!open} inert={!open} role="presentation" onMouseDown={onMouseDown} onTransitionEnd={onTransitionEnd}>{children}</div>;
}
