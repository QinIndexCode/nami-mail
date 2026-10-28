import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import type { Contact } from "./types";

export function getTrailingRecipientQuery(value: string): string {
  return value.split(/[,;\s]+/).pop() ?? "";
}

export function applyRecipientToField(value: string, email: string): string {
  const match = value.match(/([\s,;]+)([^\s,;]*)$/);
  return match ? `${value.slice(0, value.length - match[0].length)}${match[1]}${email}` : email;
}

export interface UseRecipientSuggestionsOptions {
  isDemo?: boolean;
  limit?: number;
  onApplyRecipient: (updatedValue: string) => void;
  controlsId: string;
}

export function useRecipientSuggestions({
  isDemo = false,
  limit = 8,
  onApplyRecipient,
  controlsId,
}: UseRecipientSuggestionsOptions) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const { mounted, closing, beginClose } = usePopupExitTransition(open, () => setOpen(false));
  const searchRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);

  const fetchContacts = useCallback((needle: string) => {
    const requestId = ++searchRef.current;
    if (isDemo) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    void api.contacts(needle, limit).then((result) => {
      if (searchRef.current !== requestId) return;
      setSuggestions(result.items);
      setOpen(result.items.length > 0);
      setSuggestionIndex(0);
    }).catch(() => {
      if (searchRef.current !== requestId) return;
      setSuggestions([]);
      setOpen(false);
    });
  }, [isDemo, limit]);

  const search = useCallback((value: string) => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const needle = getTrailingRecipientQuery(value);
    if (isDemo || !needle) {
      searchRef.current += 1;
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      fetchContacts(needle);
    }, 180);
  }, [fetchContacts, isDemo]);

  const toggle = useCallback((currentValue: string) => {
    if (open) {
      beginClose();
      return;
    }
    const needle = getTrailingRecipientQuery(currentValue);
    fetchContacts(needle);
  }, [open, beginClose, fetchContacts]);

  const applyContact = useCallback((contact: Contact, currentValue: string) => {
    const updated = applyRecipientToField(currentValue, contact.email);
    onApplyRecipient(updated);
    setSuggestions([]);
    setOpen(false);
    searchRef.current += 1;
  }, [onApplyRecipient]);

  const suggestedIndex = suggestions.length > 0 ? Math.min(suggestionIndex, suggestions.length - 1) : 0;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>, currentValue: string) => {
    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        beginClose();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open || suggestions.length === 0) {
        if (!open && event.key === "ArrowDown") {
          event.preventDefault();
          fetchContacts(getTrailingRecipientQuery(currentValue));
        }
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSuggestionIndex((index) => (index + delta + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter" && open && suggestions.length > 0) {
      const active = suggestions[suggestedIndex];
      if (active) {
        event.preventDefault();
        applyContact(active, currentValue);
      }
    }
  }, [open, suggestions, suggestedIndex, beginClose, fetchContacts, applyContact]);

  const activeDescendantId = open && suggestions.length > 0
    ? controlsId === "compose-contact-suggestions"
      ? `compose-contact-suggestion-${suggestedIndex}`
      : `${controlsId}-suggestion-${suggestedIndex}`
    : undefined;

  return {
    suggestions,
    open,
    mounted,
    closing,
    suggestedIndex,
    activeDescendantId,
    search,
    toggle,
    applyContact,
    onKeyDown,
    setSuggestionIndex,
  };
}
