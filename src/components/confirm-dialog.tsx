"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, Trash2, UserMinus, X } from "lucide-react";
import { ModalPresence } from "./modal-presence";

export type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  intent?: "delete" | "leave" | "member";
  onConfirm: () => void | Promise<void>;
};

type ConfirmDialogProps = {
  request: ConfirmationRequest | null;
  onClose: () => void;
};

export function ConfirmDialog({ request, onClose }: ConfirmDialogProps) {
  const [requestState, setRequestState] = useState<{ request: ConfirmationRequest | null; error: string }>({ request, error: "" });
  if (request && requestState.request !== request) setRequestState({ request, error: "" });
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const activeRequest = request ?? requestState.request;
  const visibleError = requestState.request === activeRequest ? requestState.error : "";

  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  }, [onClose, busy]);

  useEffect(() => {
    if (!request || !activeRequest) return;
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
  }, [request, activeRequest]);

  async function confirm() {
    const requestToConfirm = activeRequest;
    if (busyRef.current || !requestToConfirm) return;
    dialogRef.current?.focus();
    busyRef.current = true;
    setBusy(true);
    setRequestState((current) => ({ ...current, error: "" }));
    try {
      await requestToConfirm.onConfirm();
      closeRef.current();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not complete this action. Please try again.";
      setRequestState((current) => current.request === requestToConfirm ? { ...current, error: message } : current);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const Icon = activeRequest?.intent === "leave" ? LogOut : activeRequest?.intent === "member" ? UserMinus : Trash2;
  if (typeof document === "undefined") return null;
  if (!activeRequest) return null;

  return createPortal(
    <ModalPresence open={Boolean(request)} className="confirm-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busyRef.current) closeRef.current();
    }} onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && !request && requestState.request) setRequestState({ request: null, error: "" });
    }}>
      <section className="modal-card confirm-card" ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" aria-busy={busy}>
        <div className="confirm-heading">
          <span className={`confirm-icon ${activeRequest.intent ?? "delete"}`}><Icon size={18} aria-hidden="true"/></span>
          <div className="confirm-copy">
            <h2 id="confirm-dialog-title">{activeRequest.title}</h2>
            <p id="confirm-dialog-description">{activeRequest.description}</p>
          </div>
          <button className="modal-close" type="button" aria-label="Close confirmation" disabled={busy} onClick={() => closeRef.current()}><X size={16}/></button>
        </div>
        {visibleError && <p className="error-text confirm-error" role="alert">{visibleError}</p>}
        <div className="confirm-actions">
          <button className="button" type="button" ref={cancelRef} disabled={busy} onClick={() => closeRef.current()}>Cancel</button>
          <button className="button button-danger confirm-submit" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? (activeRequest.busyLabel ?? "Working…") : activeRequest.confirmLabel}</button>
        </div>
      </section>
    </ModalPresence>,
    document.body,
  );
}
