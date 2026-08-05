/**
 * Container-image search input used inside the InspectorPanel.
 *
 * Picks the active registry from the registry store, debounces the
 * query (350ms), calls `commands.searchRegistryImages`, renders a
 * dropdown of matches under the input. Self-contained — extracted
 * from InspectorPanel.tsx so the parent file isn't ~200 LOC larger
 * than it needs to be.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { commands } from "@/lib/commands";
import { DEFAULT_REGISTRIES, useRegistryStore } from "@/stores/registryStore";
import type {
  RegistryImageResult,
  RegistrySearchRequest,
} from "@/generated/types";

const SEARCH_MIN_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 350;

interface ImageSearchInputProps {
  id: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder?: string;
}

export function ImageSearchInput({
  id,
  value,
  onChange,
  placeholder,
}: ImageSearchInputProps) {
  const [results, setResults] = useState<RegistryImageResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [focused, setFocused] = useState(false);
  const registries = useRegistryStore((state) => state.registries);
  const selectedRegistryId = useRegistryStore(
    (state) => state.selectedRegistryId
  );
  const setSelectedRegistryId = useRegistryStore(
    (state) => state.setSelectedRegistryId
  );
  const blurTimeoutRef = useRef<number | null>(null);

  const availableRegistries = registries.length
    ? registries
    : DEFAULT_REGISTRIES;
  const selectedRegistry = useMemo(() => {
    return (
      availableRegistries.find(
        (registry) => registry.id === selectedRegistryId
      ) ?? availableRegistries[0]
    );
  }, [availableRegistries, selectedRegistryId]);

  useEffect(() => {
    if (
      !availableRegistries.some(
        (registry) => registry.id === selectedRegistryId
      )
    ) {
      setSelectedRegistryId(
        availableRegistries[0]?.id ?? DEFAULT_REGISTRIES[0].id
      );
    }
  }, [availableRegistries, selectedRegistryId, setSelectedRegistryId]);

  useEffect(() => {
    const query = value.trim();
    if (query.length < SEARCH_MIN_LENGTH) {
      // Genuine reset-on-input-change: clear stale search state when
      // the user shortens the query below the threshold. Could be
      // derived from `value` at render time but `results` is also
      // mutated by the async fetch below, so it has to live in state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const request: RegistrySearchRequest = {
          query,
          registry: {
            ...selectedRegistry,
            baseUrl: selectedRegistry.baseUrl || null,
            host: selectedRegistry.host || null,
            project: selectedRegistry.project || null,
            accountId: selectedRegistry.accountId || null,
            region: selectedRegistry.region || null,
          },
          auth: null,
          useSavedAuth: true,
        };
        const response = await commands.searchRegistryImages(request);
        if (cancelled) return;
        setResults(response);
        setStatus("idle");
      } catch {
        if (cancelled) return;
        setResults([]);
        setStatus("error");
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [value, selectedRegistry]);

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current !== null) {
        window.clearTimeout(blurTimeoutRef.current);
      }
    };
  }, []);

  const handleFocus = () => {
    if (blurTimeoutRef.current !== null) {
      window.clearTimeout(blurTimeoutRef.current);
    }
    setFocused(true);
  };

  const handleBlur = () => {
    if (blurTimeoutRef.current !== null) {
      window.clearTimeout(blurTimeoutRef.current);
    }
    blurTimeoutRef.current = window.setTimeout(() => setFocused(false), 150);
  };

  const showResults =
    focused &&
    value.trim().length >= SEARCH_MIN_LENGTH &&
    (status !== "idle" || results.length > 0);

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] font-normal text-fg-mut">
            Registry
          </Label>
          <Link
            to="/settings"
            className="text-[11px] text-info hover:underline"
          >
            Manage
          </Link>
        </div>
        <Select
          value={selectedRegistryId}
          onValueChange={setSelectedRegistryId}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select registry" />
          </SelectTrigger>
          <SelectContent>
            {availableRegistries.map((registry) => (
              <SelectItem key={registry.id} value={registry.id}>
                {registry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {showResults && (
        // A results list that hangs over the field it belongs to is an
        // overlay, so it takes the one documented elevation: raised fill,
        // hairline, shadow.
        <div className="rounded-lg border border-hair bg-raise p-1 text-fg-mid shadow-pop">
          {status === "loading" && (
            <div className="px-2 py-1 text-[11px] text-fg-mut">
              Searching {selectedRegistry.label}…
            </div>
          )}
          {status === "error" && (
            <div className="px-2 py-1 text-[11px] text-err">
              Search failed. Check registry settings.
            </div>
          )}
          {status === "idle" && results.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-fg-mut">
              No matches found.
            </div>
          )}
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              className="flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left transition-colors hover:bg-hover"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(result.name);
                setFocused(false);
              }}
            >
              <span className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-fg">{result.name}</span>
                {result.isOfficial && (
                  <span className="text-[10px] uppercase tracking-[0.05em] text-fg-fnt">
                    official
                  </span>
                )}
              </span>
              {result.description && (
                <span className="truncate text-[11px] text-fg-mut">
                  {result.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
