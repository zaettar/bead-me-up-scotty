"use client";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { useRespondHuman, useDismissHuman } from "@/hooks/use-beads";
import { isSubmitKey } from "@/lib/keyboard-shortcuts";

/**
 * Shared by both surfaces that answer a `human`-flagged bead. The draft is
 * owned by the caller so the drawer can count it as unsaved text; it is cleared
 * only on success, so a failed request keeps what was typed.
 */
export function HumanResponse({
  id,
  text,
  onTextChange,
}: {
  id: string;
  text: string;
  onTextChange: (text: string) => void;
}) {
  const { readOnly } = useApp();
  const respond = useRespondHuman();
  const dismiss = useDismissHuman();
  const busy = respond.isPending || dismiss.isPending;
  const canRespond = !readOnly && !busy && !!text.trim();
  const clear = { onSuccess: () => onTextChange("") };
  const submit = () => respond.mutate({ id, text: text.trim() }, clear);

  return (
    <>
      <textarea
        disabled={readOnly}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (!isSubmitKey(e)) return;
          e.preventDefault();
          if (canRespond) submit();
        }}
        rows={2}
        placeholder="Answer the agent's question… (posts a comment; the bead stays open)"
        className="mb-2 w-full resize-y rounded-[9px] border border-border bg-[var(--surface-2)] p-[9px_11px] text-[13px] leading-[1.5] text-[var(--text)] outline-none focus:border-[var(--brand)]"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          disabled={readOnly || busy}
          onClick={() => dismiss.mutate({ id }, clear)}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          disabled={!canRespond}
          onClick={submit}
          className="flex h-8 items-center gap-[6px] rounded-lg px-3 text-[12.5px] font-[550] text-white disabled:opacity-50"
          style={{ background: "var(--brand)" }}
        >
          <Icon name="check" size={14} /> Respond
        </button>
      </div>
    </>
  );
}
