"use client";
import { useEffect, useRef } from "react";

export const ADD_INTENT_EVENT = "tally:add-intent";
export const ADD_INTENT_PARAM = "add";
export type AddIntent = "transaction" | "transfer" | "bill" | "debt" | "goal";

export function useAddIntent(target: AddIntent, open: () => void) {
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(ADD_INTENT_PARAM) === target) {
      params.delete(ADD_INTENT_PARAM);
      const query = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
      openRef.current();
    }
    const onIntent = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === target) openRef.current();
    };
    window.addEventListener(ADD_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(ADD_INTENT_EVENT, onIntent);
  }, [target]);
}
