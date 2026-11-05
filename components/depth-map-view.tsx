"use client";
import * as React from "react";
import { Icon, typeIconName } from "@/components/icons";
import { useApp } from "@/components/app-context";
import { useHideCompleted } from "@/hooks/use-roadmap-prefs";
import { catColor, statusLabel, typeColor } from "@/lib/beads-view";
import {
  buildDepthMap,
  layoutDepthMap,
  lineage,
  NODE_HEIGHT,
  NODE_WIDTH,
  type DepthMapEdge,
  type DepthMapNode,
  type MapState,
} from "@/lib/depth-map";

type Highlight = "all" | "next" | "done";

const CRITICAL = "#ef4444";
// Same meanings as every other view, so a colour never changes what it says.
const STATE_COLOR: Record<MapState, string> = {
  done: "var(--text-3)",
  doing: catColor("in_progress"),
  ready: catColor("open"),
  blocked: "var(--text-3)",
  frozen: catColor("deferred"),
};
const STATE_LABEL: Record<MapState, string> = {
  done: "Done",
  doing: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  frozen: "On hold",
};
/** Mixed towards the text colour, so small badges stay readable on any theme. */
const readable = (color: string) => `color-mix(in srgb, ${color} 45%, var(--map-text))`;

function nodeFill(state: MapState): string {
  if (state === "done") return "var(--surface-2)";
  if (state === "blocked") return "var(--surface)";
  return `color-mix(in srgb, ${STATE_COLOR[state]} 16%, var(--surface))`;
}

function badgeFor(state: MapState, status: string, rank: number | undefined, needsYou: boolean): string | null {
  if (needsYou) return "NEEDS YOU";
  if (state === "done") return "✓ DONE";
  if (state === "doing") return "IN PROGRESS";
  if (state === "frozen") return statusLabel(status).toUpperCase();
  return state === "ready" && rank ? `NEXT ${rank}` : null;
}

interface DepthNodeProps {
  id: string;
  title: string;
  status: string;
  issueType: string;
  state: MapState;
  x: number;
  y: number;
  rank?: number;
  unblocks: number;
  critical: boolean;
  inCycle: boolean;
  needsYou: boolean;
  outsideEpic: boolean;
  hiddenCount: number;
  epicTitle?: string;
  selected: boolean;
  dim: boolean;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}

// Primitive props only: a refetch builds new bead objects, and an unchanged node
// must not re-render.
const DepthNode = React.memo(function DepthNode({
  id, title, status, issueType, state, x, y, rank, unblocks, critical, inCycle, needsYou,
  outsideEpic, hiddenCount, epicTitle, selected, dim, onSelect, onOpen,
}: DepthNodeProps) {
  const pointerFocus = React.useRef(false);
  const badge = badgeFor(state, status, rank, needsYou);
  const done = state === "done";
  const color = needsYou ? "var(--brand)" : STATE_COLOR[state];
  const label = [
    `${id} ${title}`,
    STATE_LABEL[state],
    rank ? `next up number ${rank}` : null,
    needsYou ? "needs you" : null,
    critical ? "on the critical path" : null,
    inCycle ? "in a dependency cycle" : null,
    hiddenCount ? `${hiddenCount} hidden blockers` : null,
  ].filter(Boolean).join(", ");

  return (
    <div
      role="button"
      tabIndex={0}
      data-keyboard-bead-id={id}
      data-map-state={state}
      data-dim={dim ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      title={unblocks ? `${title}\nUnblocks ${unblocks}` : title}
      // Keyboard focus traces; a click decides for itself below, otherwise the
      // focus would select the bead and the click would immediately clear it.
      onPointerDown={() => { pointerFocus.current = true; }}
      onFocus={() => {
        if (!pointerFocus.current) onSelect(id);
        pointerFocus.current = false;
      }}
      onClick={() => onSelect(selected ? null : id)}
      onDoubleClick={() => onOpen(id)}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        transform: `translate(${x}px, ${y}px)`,
        background: nodeFill(state),
        borderColor: selected ? "var(--brand)" : done ? "var(--border)" : state === "blocked" ? "var(--border-strong)" : STATE_COLOR[state],
        borderStyle: state === "blocked" || outsideEpic ? "dashed" : "solid",
        opacity: dim ? 0.22 : 1,
      }}
      className={`absolute left-0 top-0 flex scroll-m-10 cursor-pointer flex-col overflow-hidden rounded-[8px] border py-[6px] pl-[11px] pr-[8px] focus-visible:outline-none motion-safe:transition-[transform,opacity] motion-safe:duration-200 ${
        selected ? "z-10 ring-2 ring-[var(--brand)]/40" : ""
      }`}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[4px]" style={{ background: color }} />
      <div className="flex min-w-0 items-center gap-[5px]">
        <Icon name={typeIconName(issueType)} size={11} style={{ color: done ? "var(--text-3)" : typeColor(issueType) }} className="flex-shrink-0" />
        <span data-contrast className="truncate font-mono text-[10.5px] text-[var(--map-text-2)]">{id}</span>
        {critical && <span aria-hidden className="text-[9px]" style={{ color: CRITICAL }}>●</span>}
        <span className="flex-1" />
        {badge && (
          <span
            data-contrast
            className="flex-shrink-0 text-[9.5px] font-[650] tracking-[.03em]"
            style={{ color: done ? "var(--map-text-2)" : readable(color) }}
          >
            {badge}
          </span>
        )}
      </div>
      <div
        data-contrast
        className={`mt-[2px] line-clamp-2 text-[11.5px] font-[550] leading-[1.25] [overflow-wrap:anywhere] ${
          done ? "text-[var(--map-text-2)] line-through" : "text-[var(--map-text)]"
        }`}
      >
        {title}
      </div>
      <div className="mt-auto flex min-w-0 items-center gap-[5px] text-[9.5px] leading-[1.2]">
        {epicTitle && <span data-contrast className="min-w-0 truncate text-[var(--map-text-2)]">{epicTitle}</span>}
        <span className="flex-1" />
        {outsideEpic && <NodeChip>Outside epic</NodeChip>}
        {inCycle && <NodeChip>CYCLE</NodeChip>}
        {hiddenCount > 0 && <NodeChip>+{hiddenCount} hidden</NodeChip>}
      </div>
    </div>
  );
});

function NodeChip({ children }: { children: React.ReactNode }) {
  return (
    <span data-contrast className="flex-shrink-0 rounded-full bg-[var(--surface-3)] px-[5px] py-[1px] font-[650] text-[var(--map-text-2)]">
      {children}
    </span>
  );
}

function edgeStyle(edge: DepthMapEdge, hot: boolean, faded: boolean): React.SVGProps<SVGPathElement> {
  const opacity = faded ? 0.1 : 1;
  if (hot) return { stroke: "var(--brand)", strokeWidth: 2 };
  if (edge.critical) return { stroke: CRITICAL, strokeWidth: 1.8, strokeDasharray: edge.met ? undefined : "4 4", opacity };
  if (edge.met) return { stroke: "var(--text-3)", strokeWidth: 1.2, opacity: faded ? 0.1 : 0.45 };
  return { stroke: "var(--border-strong)", strokeWidth: 1.4, strokeDasharray: "4 4", opacity };
}

function ToggleChip({ pressed, disabled, title, onClick, children }: {
  pressed: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`h-7 rounded-lg border px-[10px] text-[12px] font-[550] disabled:cursor-not-allowed disabled:opacity-50 ${
        pressed
          ? "border-[var(--brand)] bg-[var(--brand-weak)] text-[var(--brand)]"
          : "border-border bg-[var(--surface)] text-[var(--text-2)] hover:text-[var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ value, label, color }: { value: React.ReactNode; label: string; color?: string }) {
  return (
    <span className="inline-flex items-baseline gap-[5px] whitespace-nowrap text-[12px] text-[var(--text-2)]">
      {color && <span aria-hidden className="h-2 w-2 self-center rounded-[2px]" style={{ background: color }} />}
      <b className="text-[14px] font-[650] tabular-nums text-[var(--text)]">{value}</b>
      {label}
    </span>
  );
}

function Legend() {
  const swatch = (state: MapState, text: string) => (
    <span className="inline-flex items-center gap-[5px]">
      <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: STATE_COLOR[state] }} />
      {text}
    </span>
  );
  return (
    <div className="hidden flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-2)] md:flex">
      {swatch("done", "✓ Done")}
      {swatch("doing", "In progress")}
      {swatch("ready", "Next up")}
      {swatch("blocked", "Blocked (dashed)")}
      <span className="inline-flex items-center gap-[5px]">
        <span aria-hidden style={{ color: CRITICAL }}>●</span> Critical path
      </span>
      <span>Solid link: blocker done · dashed link: still waiting</span>
    </div>
  );
}

function BeadList({ ids, empty, known, onOpen }: {
  ids: string[];
  empty: string;
  known: (id: string) => { title: string; state?: string } | undefined;
  onOpen: (id: string) => void;
}) {
  if (!ids.length) return <p className="text-[12px] text-[var(--text-2)]">{empty}</p>;
  return (
    <ul className="flex flex-col gap-[2px]">
      {ids.map((id) => {
        const bead = known(id);
        return (
          <li key={id} className="min-w-0 text-[12px] leading-[1.35]">
            {bead ? (
              <button type="button" onClick={() => onOpen(id)} className="w-full truncate text-left text-[var(--text)] hover:underline">
                <span className="font-mono text-[11px] text-[var(--text-2)]">{id}</span> {bead.title}
                {bead.state && <span className="text-[var(--text-2)]"> · {bead.state}</span>}
              </button>
            ) : (
              <span className="text-[var(--text-2)]"><span className="font-mono text-[11px]">{id}</span> · not found</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DetailPanel({ node, needs, unblocks, onOpen, onClear }: {
  node: DepthMapNode;
  needs: string[];
  unblocks: string[];
  onOpen: (id: string) => void;
  onClear: () => void;
}) {
  const { index } = useApp();
  const known = (id: string) => {
    const bead = index.get(id);
    return bead ? { title: bead.title, state: statusLabel(bead.status) } : undefined;
  };
  return (
    <aside
      aria-label="Selected bead"
      className="max-h-[42%] flex-shrink-0 overflow-y-auto border-t border-border bg-[var(--surface)] p-4 md:max-h-none md:w-[300px] md:border-l md:border-t-0"
    >
      <div className="font-mono text-[11px] text-[var(--text-2)]">{node.bead.id} · {STATE_LABEL[node.state]}</div>
      <h2 className="mb-3 mt-1 text-[14px] font-[650] leading-snug text-[var(--text)]">{node.bead.title}</h2>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(node.bead.id)}
          className="h-8 rounded-lg px-3 text-[12.5px] font-[550] text-white"
          style={{ background: "var(--brand)" }}
        >
          Open bead
        </button>
        <button
          type="button"
          onClick={onClear}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)]"
        >
          Clear
        </button>
      </div>
      <div className="mb-1 text-[11px] font-semibold text-[var(--text-2)]">Needs</div>
      <div className="mb-3"><BeadList ids={needs} empty="Nothing." known={known} onOpen={onOpen} /></div>
      {node.hiddenBlockers.length > 0 && (
        <>
          <div className="mb-1 text-[11px] font-semibold text-[var(--text-2)]">Hidden blockers</div>
          <div className="mb-3"><BeadList ids={node.hiddenBlockers} empty="" known={known} onOpen={onOpen} /></div>
        </>
      )}
      <div className="mb-1 text-[11px] font-semibold text-[var(--text-2)]">Directly unblocks</div>
      <div className="mb-1"><BeadList ids={unblocks} empty="Nothing." known={known} onOpen={onOpen} /></div>
      {node.unblocks > 0 && (
        <p className="mb-3 text-[12px] text-[var(--text-2)]">
          {node.unblocks} open {node.unblocks === 1 ? "bead" : "beads"} downstream
        </p>
      )}
    </aside>
  );
}

/**
 * Roadmap: beads in columns by dependency depth, so a person can see what can
 * start now, what each item waits on, and which chain holds the project up
 * longest. Read-only by construction: all changes happen in the drawer.
 *
 * HTML nodes over one SVG edge layer, not React Flow: J/K/H/L need focusable
 * HTML elements, and native scrolling keeps its position across live refreshes.
 */
export function DepthMapView() {
  const { beads, projectId, selectedBeadId, selectBead, openDetail } = useApp();
  const [hideCompleted, setHideCompleted] = useHideCompleted(projectId);
  const [showUnlinked, setShowUnlinked] = React.useState(false);
  const [epicChoice, setEpicChoice] = React.useState("");
  const [highlightChoice, setHighlight] = React.useState<Highlight>("all");
  const highlight = hideCompleted && highlightChoice === "done" ? "all" : highlightChoice;

  const epics = React.useMemo(
    () =>
      beads
        .filter((bead) => bead.issue_type === "epic" && !(bead.labels ?? []).includes("archived"))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    [beads],
  );
  const epicId = epics.some((epic) => epic.id === epicChoice) ? epicChoice : "";

  const map = React.useMemo(
    () => buildDepthMap(beads, { hideCompleted, showUnlinked, epicId: epicId || undefined }),
    [beads, hideCompleted, showUnlinked, epicId],
  );
  const layout = React.useMemo(() => layoutDepthMap(map), [map]);
  const nodes = React.useMemo(() => map.columns.flat(), [map]);

  // Derived, not cleared: a bead that leaves the map simply stops being traced.
  const selected = nodes.find((node) => node.bead.id === selectedBeadId) ?? null;
  const tracedId = selected?.bead.id ?? null;
  const trace = React.useMemo(() => (tracedId ? lineage(map, tracedId) : null), [map, tracedId]);

  const scroller = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<{ id: string; x: number; y: number } | null>(null);
  // When a refresh moves the selected node, scroll with it so it stays put on screen.
  React.useLayoutEffect(() => {
    const position = tracedId ? layout.nodes.get(tracedId) : undefined;
    const last = anchor.current;
    if (position && last?.id === tracedId && scroller.current) {
      scroller.current.scrollLeft += position.x - last.x;
      scroller.current.scrollTop += position.y - last.y;
    }
    anchor.current = position && tracedId ? { id: tracedId, ...position } : null;
  }, [layout, tracedId]);

  const open = React.useCallback((id: string) => openDetail(id), [openDetail]);
  const matches = (node: DepthMapNode) =>
    highlight === "all" ||
    (highlight === "next" ? node.state === "ready" || node.state === "doing" : node.state === "done");
  const inTrace = (id: string) => id === tracedId || !!trace?.up.has(id) || !!trace?.down.has(id);

  const stateOf = React.useMemo(() => new Map(nodes.map((node) => [node.bead.id, node])), [nodes]);
  const total = map.counts.done + map.counts.doing + map.counts.ready + map.counts.blocked + map.counts.frozen;
  const hasMap = nodes.length > 0;

  // Traced and critical links paint last, so a busy map can't bury them.
  const paintedEdges = map.edges
    .map((edge) => {
      // Only links on the path through the selected bead, not every link
      // between two beads that happen to be in its lineage.
      const onSide = (side: Set<string>) =>
        (edge.from === tracedId || side.has(edge.from)) && (edge.to === tracedId || side.has(edge.to));
      const hot = !!trace && (onSide(trace.up) || onSide(trace.down));
      const from = stateOf.get(edge.from);
      const to = stateOf.get(edge.to);
      return { edge, hot, faded: trace ? !hot : !!from && !!to && !matches(from) && !matches(to) };
    })
    .sort((a, b) => Number(a.hot) - Number(b.hot) || Number(a.edge.critical) - Number(b.edge.critical));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Icon name="roadmap" size={18} className="text-[var(--text-2)]" />
            <h1 className="text-[15px] font-[650]">Roadmap</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Stat value={`${map.counts.done} of ${total}`} label="done" color={STATE_COLOR.done} />
            <Stat value={map.counts.doing} label="in progress" color={STATE_COLOR.doing} />
            <Stat value={map.counts.ready} label="ready" color={STATE_COLOR.ready} />
            <Stat value={map.counts.blocked} label="blocked" color={STATE_COLOR.blocked} />
            <Stat value={map.longestChain} label="on the longest chain" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-2)]">
            Scope
            <select
              value={epicId}
              onChange={(event) => setEpicChoice(event.target.value)}
              className="h-7 max-w-[220px] rounded-lg border border-border bg-[var(--surface)] px-2 text-[12px] text-[var(--text)]"
            >
              <option value="">All beads</option>
              {epics.map((epic) => (
                <option key={epic.id} value={epic.id}>{epic.id} · {epic.title}</option>
              ))}
            </select>
          </label>
          <div role="group" aria-label="Highlight in the map" className="flex items-center gap-1">
            <ToggleChip pressed={highlight === "all"} onClick={() => setHighlight("all")}>Everything</ToggleChip>
            <ToggleChip pressed={highlight === "next"} onClick={() => setHighlight("next")}>Next up</ToggleChip>
            <ToggleChip
              pressed={highlight === "done"}
              disabled={hideCompleted}
              title={hideCompleted ? "Completed work is hidden" : undefined}
              onClick={() => setHighlight("done")}
            >
              Done
            </ToggleChip>
          </div>
          <ToggleChip pressed={hideCompleted} onClick={() => setHideCompleted(!hideCompleted)}>Hide completed</ToggleChip>
        </div>
        <Legend />
        {map.cycles > 0 && (
          <p role="status" className="text-[12px] font-[550] text-[var(--text)]">
            <span style={{ color: CRITICAL }}>●</span>{" "}
            {map.cycles === 1 ? "1 dependency cycle" : `${map.cycles} dependency cycles`}: these beads wait on each
            other, so they can never clear on their own.
          </p>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <div
          ref={scroller}
          data-roadmap-scroller
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (!target.closest("[data-keyboard-bead-id], button")) selectBead(null);
          }}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {hasMap ? (
            <div style={{ width: layout.width, minWidth: "100%" }}>
              <div className="sticky top-0 z-20 h-8 border-b border-border bg-[var(--surface)]" style={{ width: layout.width, minWidth: "100%" }}>
                {map.columns.map((column, c) => (
                  <span
                    key={c}
                    className="absolute top-[9px] font-mono text-[10.5px] tracking-[.06em] text-[var(--text-2)]"
                    style={{ left: layout.columnX[c] }}
                  >
                    {c === 0 ? "NO BLOCKERS" : `DEPTH ${c}`} · {column.length}
                  </span>
                ))}
              </div>
              <div className="relative" style={{ width: layout.width, height: layout.height }}>
                <svg aria-hidden width={layout.width} height={layout.height} className="pointer-events-none absolute left-0 top-0">
                {paintedEdges.map(({ edge, hot, faded }) => (
                    <path
                      key={edge.id}
                      data-edge-id={edge.id}
                      data-hot={hot ? "true" : undefined}
                      d={layout.paths.get(edge.id)}
                      fill="none"
                      {...edgeStyle(edge, hot, faded)}
                    />
                  ))}
                </svg>
                {nodes.map((node) => {
                  const position = layout.nodes.get(node.bead.id)!;
                  return (
                    <DepthNode
                      key={node.bead.id}
                      id={node.bead.id}
                      title={node.bead.title}
                      status={node.bead.status}
                      issueType={node.bead.issue_type}
                      state={node.state}
                      x={position.x}
                      y={position.y}
                      rank={node.rank}
                      unblocks={node.unblocks}
                      critical={node.critical}
                      inCycle={node.inCycle}
                      needsYou={node.needsYou}
                      outsideEpic={node.outsideEpic}
                      hiddenCount={node.hiddenBlockers.length}
                      epicTitle={node.epic && node.epic.id !== node.bead.id ? node.epic.title : undefined}
                      selected={node.bead.id === tracedId}
                      dim={trace ? !inTrace(node.bead.id) : !matches(node)}
                      onSelect={selectBead}
                      onOpen={open}
                    />
                  );
                })}
                {map.unlinkedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowUnlinked(!showUnlinked)}
                    className="absolute h-7 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-[10px] text-[12px] font-[550] text-[var(--text-2)] hover:text-[var(--text)]"
                    style={{ left: layout.columnX[0], top: layout.footY }}
                  >
                    {showUnlinked ? `Collapse ${map.unlinkedCount} unlinked` : `+${map.unlinkedCount} unlinked`}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="p-10 text-center text-[13px] text-[var(--text-2)]">
              {map.unlinkedCount > 0 ? (
                <>
                  <p className="mb-3">None of these beads depend on each other yet.</p>
                  <button
                    type="button"
                    onClick={() => setShowUnlinked(true)}
                    className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text)] hover:bg-[var(--surface-3)]"
                  >
                    Show {map.unlinkedCount} unlinked
                  </button>
                </>
              ) : (
                "Nothing to map here yet."
              )}
            </div>
          )}
        </div>
        {selected && (
          <DetailPanel
            node={selected}
            needs={map.edges.filter((edge) => edge.to === tracedId).map((edge) => edge.from)}
            unblocks={map.edges.filter((edge) => edge.from === tracedId).map((edge) => edge.to)}
            onOpen={open}
            onClear={() => selectBead(null)}
          />
        )}
      </div>
    </div>
  );
}
