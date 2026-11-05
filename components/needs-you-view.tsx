"use client";
import * as React from "react";
import { GateApproval } from "@/components/gate-approval";
import { useApp } from "@/components/app-context";
import { useUrlState } from "@/hooks/use-url-state";
import { HumanResponse } from "@/components/human-response";
import { Icon, typeIconName } from "@/components/icons";
import { OriginBadge } from "@/components/board/bead-card";
import { beadOrigin } from "@/lib/attribution";
import {
  epicProgress,
  gateBlocks,
  typeColor,
  relTime,
  fmtDateTime,
} from "@/lib/beads-view";
import {
  groupNeedsYou,
  needsYouItems,
  needsYouPrefsFromParams,
  writeNeedsYouPrefs,
  NEEDS_YOU_SORTS,
  NEEDS_YOU_SORT_LABELS,
  type NeedsYouGroup,
  type NeedsYouItem,
  type NeedsYouPrefs,
  type NeedsYouShow,
  type NeedsYouSort,
} from "@/lib/needs-you";
import { reviewLinks } from "@/lib/review-links";
import { DescriptionContent } from "@/components/description-content";
import { ReviewLinkChips } from "@/components/review-link-chips";
import type { Bead } from "@/lib/schema";

/**
 * Mission Control — "Needs You" decision inbox. Surfaces two kinds of items
 * waiting on a person:
 *   1. Beads an agent flagged for a decision (the `human` label, via `bd human`)
 *      — answered inline (comment + clear the flag) or dismissed.
 *   2. Human-approval gates (`bd gate create --type human`), approved (closed,
 *      which unblocks dependents) from here so they don't sit invisibly waiting
 *      on the board (bead 8qc / gh-6). A gate that is still blocked is listed
 *      but can't be approved yet.
 * Items group under their parent. "Unblocked only" narrows the inbox to what a
 * person can act on immediately to release future work.
 */
export function NeedsYouView() {
  const { beads, index } = useApp();
  const { searchParams, updateUrl } = useUrlState();
  const prefs = React.useMemo(() => needsYouPrefsFromParams(searchParams), [searchParams]);
  const setPrefs = (next: Partial<NeedsYouPrefs>) =>
    updateUrl((params) => writeNeedsYouPrefs(params, { ...prefs, ...next }));

  const items = React.useMemo(() => needsYouItems(beads, index), [beads, index]);
  const groups = React.useMemo(
    () =>
      groupNeedsYou(
        prefs.show === "unblocked" ? items.filter((i) => !i.blocked) : items,
        index,
        prefs.sort,
      ),
    [items, index, prefs.show, prefs.sort],
  );
  const total = items.length;
  const unblocked = items.filter((i) => !i.blocked).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-6 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="user" size={18} className="text-[var(--text-2)]" />
          <h1 className="text-[15px] font-[650]">Needs You</h1>
          <span className="text-[12px] text-[var(--text-3)]">
            · {summary(total, unblocked, prefs.show)}
          </span>
        </div>
        {total > 0 && (
          <>
            <span className="flex-1" />
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-2)]">
              Sort by
              <select
                value={prefs.sort}
                onChange={(e) => setPrefs({ sort: e.target.value as NeedsYouSort })}
                className="h-8 rounded-[8px] border border-border bg-[var(--surface-2)] px-2 text-[var(--text)]"
              >
                {NEEDS_YOU_SORTS.map((sort) => (
                  <option key={sort} value={sort}>{NEEDS_YOU_SORT_LABELS[sort]}</option>
                ))}
              </select>
            </label>
            <div role="group" aria-label="Show" className="flex items-center gap-[6px]">
              <ShowButton label="All" selected={prefs.show === "all"} onClick={() => setPrefs({ show: "all" })} />
              <ShowButton
                label="Unblocked only"
                selected={prefs.show === "unblocked"}
                onClick={() => setPrefs({ show: "unblocked" })}
              />
            </div>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {total === 0 ? (
          <div className="p-10 text-center text-[13px] text-[var(--text-3)]">
            🎉 Nothing needs you right now. Agents flag beads here with{" "}
            <span className="font-mono">bd human</span>, and human-approval gates
            (<span className="font-mono">bd gate create --type human</span>) show
            up here too.
          </div>
        ) : groups.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-[var(--text-3)]">
            <p className="mb-3">
              Everything waiting on you is blocked by other work, so there is nothing
              you can act on right now.
            </p>
            <button
              onClick={() => setPrefs({ show: "all" })}
              className="h-8 rounded-[8px] border border-border px-3 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
            >
              Show all {total}
            </button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {groups.map((group) => (
              <GroupSection key={group.parent?.id ?? "no-epic"} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function summary(total: number, unblocked: number, show: NeedsYouShow): string {
  if (total === 0) return "nothing waiting";
  if (show === "unblocked") return `${unblocked} of ${total} unblocked`;
  const blocked = total - unblocked;
  return `${total} waiting on you${blocked ? ` · ${blocked} blocked` : ""}`;
}

function ShowButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={selected}
      onClick={onClick}
      className="h-8 rounded-[8px] border border-border px-3 text-[12px] aria-pressed:border-[var(--brand)] aria-pressed:bg-[var(--brand-weak)] aria-pressed:text-[var(--brand)]"
    >
      {label}
    </button>
  );
}

function GroupSection({ group }: { group: NeedsYouGroup }) {
  const { beads, openDetail } = useApp();
  const { parent, items } = group;
  const progress = parent?.issue_type === "epic" ? epicProgress(parent.id, beads) : null;
  const headingId = React.useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1">
        {parent && (
          <Icon name={typeIconName(parent.issue_type)} size={14} style={{ color: typeColor(parent.issue_type) }} />
        )}
        {parent && (
          <button
            onClick={() => openDetail(parent.id)}
            className="font-mono text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
          >
            {parent.id}
          </button>
        )}
        <h2 id={headingId} className="min-w-0 text-[13px] font-[650] text-[var(--text)]">
          {parent ? (
            <button onClick={() => openDetail(parent.id)} className="text-left hover:underline">
              {parent.title}
            </button>
          ) : (
            "No epic"
          )}
        </h2>
        <span className="text-[11.5px] text-[var(--text-3)]">{items.length} waiting</span>
        {progress && (
          <>
            <span className="flex-1" />
            <span className="flex items-center gap-2 text-[11.5px] text-[var(--text-3)]">
              <span className="h-[5px] w-16 overflow-hidden rounded-full bg-[var(--surface-3)]">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${progress.pct}%`,
                    background: progress.pct === 100 ? "#16a34a" : "var(--brand)",
                  }}
                />
              </span>
              {progress.closed}/{progress.total} done
            </span>
          </>
        )}
      </div>
      {items.map((item) =>
        item.kind === "gate" ? (
          <GateCard key={item.bead.id} item={item} />
        ) : (
          <NeedsYouCard key={item.bead.id} item={item} />
        ),
      )}
    </section>
  );
}

/** Names what is holding an item up. Renders nothing for an unblocked item. */
function BlockedNote({ item }: { item: NeedsYouItem }) {
  const { index, openDetail } = useApp();
  if (!item.blocked) return null;
  return (
    <p className="mb-2 flex flex-wrap items-center gap-x-[6px] gap-y-1 text-[12px] leading-[1.5] text-[var(--text-2)]">
      <span className="rounded-full border border-border bg-[var(--surface-2)] px-2 py-[1px] text-[10px] font-[650] uppercase tracking-wide">
        Blocked
      </span>
      {item.blockers.length > 0 && <span>by</span>}
      {item.blockers.map((id, i) => (
        <React.Fragment key={id}>
          {index.has(id) ? (
            <button onClick={() => openDetail(id)} className="font-mono text-[var(--text)] hover:underline">
              {id}
            </button>
          ) : (
            <span className="font-mono">{id}</span>
          )}
          {i < item.blockers.length - 1 && <span className="-ml-[6px]">,</span>}
        </React.Fragment>
      ))}
    </p>
  );
}

/**
 * The full description, rendered as markdown like the detail drawer: the
 * person is deciding from this card, so a clamped plain-text excerpt hides
 * the context they need.
 */
function CardDescription({ bead }: { bead: Bead }) {
  const { projectId } = useApp();
  if (!bead.description) return null;
  return (
    <DescriptionContent
      text={bead.description}
      projectId={projectId}
      className="mb-3 text-[12.5px] leading-[1.5] text-[var(--text-2)]"
    />
  );
}

function ReviewLinks({ bead }: { bead: Bead }) {
  const links = reviewLinks(bead);
  if (!links.length) return (
    <p className="mb-3 text-[12px] text-[var(--text-3)]">
      No supporting links found. Review the bead details before deciding.
    </p>
  );
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] font-semibold text-[var(--text-3)]">Links &amp; attachments</div>
      <ReviewLinkChips links={links} />
    </div>
  );
}

/**
 * A ready human-approval gate. "Approve" closes the gate (via `bd close`), which
 * resolves it and unblocks every bead depending on it.
 */
function GateCard({ item }: { item: NeedsYouItem }) {
  const gate = item.bead;
  const { beads, openDetail, selectedBeadId, selectBead } = useApp();
  const blocks = React.useMemo(() => gateBlocks(gate.id, beads), [gate.id, beads]);

  return (
    <div
      role="button"
      tabIndex={0}
      data-keyboard-bead-id={gate.id}
      aria-current={selectedBeadId === gate.id ? "true" : undefined}
      onFocus={() => selectBead(gate.id)}
      className={`rounded-[12px] border bg-[var(--surface)] p-4 focus-visible:outline-none ${
        selectedBeadId === gate.id
          ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/30"
          : "border-border"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon name="gate" size={15} style={{ color: "var(--brand)" }} />
        <button
          onClick={() => openDetail(gate.id)}
          className="font-mono text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
        >
          {gate.id}
        </button>
        <span className="rounded-full border border-border bg-[var(--surface-2)] px-2 py-[1px] text-[10px] font-[650] uppercase tracking-wide text-[var(--text-2)]">
          Approval gate
        </span>
        <span className="flex-1" />
        <span title={fmtDateTime(gate.updated_at)} className="text-[11px] text-[var(--text-3)]">
          {relTime(gate.updated_at)}
        </span>
      </div>
      <button
        onClick={() => openDetail(gate.id)}
        className="mb-2 block text-left text-[14px] font-[600] leading-snug text-[var(--text)] hover:underline"
      >
        {gate.title}
      </button>
      <BlockedNote item={item} />
      <CardDescription bead={gate} />
      <ReviewLinks bead={gate} />
      {blocks.length > 0 && (
        <p className="mb-3 text-[12px] leading-[1.5] text-[var(--text-2)]">
          Approving unblocks{" "}
          {blocks.map((b, i) => (
            <React.Fragment key={b.id}>
              {i > 0 && ", "}
              <button
                onClick={() => openDetail(b.id)}
                className="font-mono text-[var(--text)] hover:underline"
              >
                {b.id}
              </button>
            </React.Fragment>
          ))}
          .
        </p>
      )}
      {item.blocked && (
        <p className="mb-2 text-right text-[12px] text-[var(--text-3)]">
          This gate can be approved once its blockers are resolved.
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <GateApproval id={gate.id} disabled={item.blocked} />
      </div>
    </div>
  );
}

function NeedsYouCard({ item }: { item: NeedsYouItem }) {
  const bead = item.bead;
  const { humanAllowlist, openDetail, selectedBeadId, selectBead } = useApp();
  const [text, setText] = React.useState("");
  const o = beadOrigin(bead, humanAllowlist);

  return (
    <div
      role="button"
      tabIndex={0}
      data-keyboard-bead-id={bead.id}
      aria-current={selectedBeadId === bead.id ? "true" : undefined}
      onFocus={() => selectBead(bead.id)}
      className={`rounded-[12px] border bg-[var(--surface)] p-4 focus-visible:outline-none ${
        selectedBeadId === bead.id
          ? "border-[var(--brand)] ring-2 ring-[var(--brand)]/30"
          : "border-border"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon name={typeIconName(bead.issue_type)} size={14} style={{ color: typeColor(bead.issue_type) }} />
        <button
          onClick={() => openDetail(bead.id)}
          className="font-mono text-[11px] text-[var(--text-3)] hover:text-[var(--text)]"
        >
          {bead.id}
        </button>
        <OriginBadge origin={o} title={o === "human" ? "Human" : "Agent"} />
        <span className="flex-1" />
        <span title={fmtDateTime(bead.updated_at)} className="text-[11px] text-[var(--text-3)]">
          {relTime(bead.updated_at)}
        </span>
      </div>
      <button
        onClick={() => openDetail(bead.id)}
        className="mb-2 block text-left text-[14px] font-[600] leading-snug text-[var(--text)] hover:underline"
      >
        {bead.title}
      </button>
      <BlockedNote item={item} />
      <CardDescription bead={bead} />
      <ReviewLinks bead={bead} />
      <HumanResponse id={bead.id} text={text} onTextChange={setText} />
    </div>
  );
}
