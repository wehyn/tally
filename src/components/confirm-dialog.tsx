"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, Trash2, UserMinus, X } from "lucide-react";

export type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  intent?: "delete" | "leave" | "member";
  onConfirm: () => void | Promise<void>;
};

type ConfirmDialogProps = {
  request: ConfirmationRequest;
  onClose: () => void;
};

export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  }, [onClose, busy]);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    cancelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!buttons?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  async function confirm() {
    if (busyRef.current) return;
    dialogRef.current?.focus();
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await request.onConfirm();
      closeRef.current();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete this action. Please try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const Icon = request.intent === "leave" ? LogOut : request.intent === "member" ? UserMinus : Trash2;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="modal-backdrop confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) closeRef.current();
    }}>
      <section className="modal-card confirm-card" ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" aria-busy={busy}>
        <div className="confirm-heading">
          <span className={`confirm-icon ${request.intent ?? "delete"}`}><Icon size={18} aria-hidden="true"/></span>
          <div className="confirm-copy">
            <h2 id="confirm-dialog-title">{request.title}</h2>
            <p id="confirm-dialog-description">{request.description}</p>
          </div>
          <button className="modal-close" type="button" aria-label="Close confirmation" disabled={busy} onClick={() => closeRef.current()}><X size={16}/></button>
        </div>
        {error && <p className="error-text confirm-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button className="button" type="button" ref={cancelRef} disabled={busy} onClick={() => closeRef.current()}>Cancel</button>
          <button className="button button-danger confirm-submit" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? (request.busyLabel ?? "Working…") : request.confirmLabel}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
