// Roadmap view. Isolated demo server only: project data is intercepted, never written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");
const shots = process.env.SCOTTY_SCREENSHOT_DIR;

const bead = (id, extra = {}) => ({
  id, title: `Title ${id}`, status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
});
const dep = (target, type = "blocks") => ({ depends_on_id: target, type });
const fixture = () => [
  bead("epic-a", { issue_type: "epic", title: "Launch epic" }),
  bead("root", { status: "closed", dependencies: [dep("epic-a", "parent-child")] }),
  bead("doing", { status: "in_progress", dependencies: [dep("root"), dep("epic-a", "parent-child")] }),
  bead("next", { priority: 1, dependencies: [dep("root"), dep("epic-a", "parent-child")] }),
  bead("waiting", { dependencies: [dep("doing"), dep("archived-open"), dep("gone")] }),
  bead("end", { title: "A long title that needs to wrap over more than a single line of the node", dependencies: [dep("waiting"), dep("next")] }),
  bead("gate", { issue_type: "gate", await_type: "human" }),
  bead("gated", { dependencies: [dep("gate")] }),
  bead("hold", { status: "deferred" }),
  bead("held", { dependencies: [dep("hold")] }),
  bead("cycle-a", { dependencies: [dep("cycle-b")] }),
  bead("cycle-b", { dependencies: [dep("cycle-a")] }),
  bead("alone"),
  bead("archived-open", { labels: ["archived"] }),
];

const themes = [...readFileSync(new URL("../lib/themes.ts", import.meta.url), "utf8").matchAll(/\{ id: "([a-z-]+)", name:/g)].map((m) => m[1]);
assert.equal(themes.length, 9, "all themes found");

const browser = await chromium.launch();
try {
  async function open({ beads, viewport = { width: 1400, height: 900 }, theme, url = "/p/demo?view=roadmap" }) {
    const context = await browser.newContext({ viewport });
    if (theme) await context.addInitScript((id) => localStorage.setItem("bmus.theme.demo", id), theme);
    const page = await context.newPage();
    const state = { beads, writes: [], errors: [] };
    page.on("pageerror", (error) => state.errors.push(error.message));
    await page.route("**/api/p/demo/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") state.writes.push(`${request.method()} ${path}`);
      if (path.endsWith("/beads/stream")) return route.abort();
      if (path.endsWith("/beads")) {
        return route.fulfill({ json: { beads: state.beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300, lanePrefix: null } } });
      }
      const single = state.beads.find((b) => path.endsWith(`/beads/${b.id}`));
      return route.fulfill({ json: single ?? {} });
    });
    await page.goto(`${base}${url}`);
    return { page, state, context };
  }
  const nodeOf = (page, id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
  const ids = (page) => page.locator("[data-keyboard-bead-id]").evaluateAll((els) => els.map((el) => el.dataset.keyboardBeadId).sort());
  const transforms = (page) => page.locator("[data-keyboard-bead-id]").evaluateAll((els) => els.map((el) => el.style.transform));
  const ready = (page) => page.locator("[data-roadmap-scroller] [data-keyboard-bead-id]").first().waitFor();
  const panel = (page) => page.getByRole("complementary", { name: "Selected bead" });
  const rail = (page) => page.getByRole("region", { name: "Next up list" });
  const railRow = (page, id) => page.locator(`[data-rail-id="${id}"]`);
  const railIds = (page) => page.locator("[data-rail-id]").evaluateAll((els) => els.map((el) => el.dataset.railId));
  const dimmed = (page) => page.locator('[data-keyboard-bead-id][data-dim="true"]').count();

  // Columns, headers, states and edges.
  {
    const { page, state, context } = await open({ beads: fixture() });
    await ready(page);
    assert.deepEqual(await ids(page), ["cycle-a", "cycle-b", "doing", "end", "gate", "gated", "held", "hold", "next", "root", "waiting"]);
    for (const heading of ["NO BLOCKERS", "DEPTH 1", "DEPTH 2", "DEPTH 3"]) {
      await page.getByText(new RegExp(`^${heading} ·`)).first().waitFor();
    }
    assert.equal(await page.locator("[data-edge-id]").count(), 9);
    assert.equal(await nodeOf(page, "root").getAttribute("data-map-state"), "done", "completed work stays on the map");
    assert.match(await nodeOf(page, "root").innerText(), /✓ DONE/);
    assert.match(await nodeOf(page, "doing").innerText(), /IN PROGRESS/);
    assert.match(await nodeOf(page, "next").innerText(), /NEXT 1/);
    assert.match(await nodeOf(page, "gate").innerText(), /NEEDS YOU/);
    assert.match(await nodeOf(page, "waiting").innerText(), /\+2 hidden/);
    assert.match(await nodeOf(page, "cycle-a").innerText(), /CYCLE/);
    assert.match(await nodeOf(page, "next").innerText(), /Launch epic/);
    await page.getByText(/1 dependency cycle/).waitFor();
    await page.getByRole("button", { name: "+1 unlinked" }).click();
    await nodeOf(page, "alone").waitFor();
    await page.getByRole("button", { name: "Collapse 1 unlinked" }).click();
    await nodeOf(page, "alone").waitFor({ state: "detached" });
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  // Navigation: sidebar, shortcut and palette all reach it.
  {
    const { page, context } = await open({ beads: fixture(), url: "/p/demo" });
    await page.locator("article").first().waitFor();
    await page.keyboard.press("g");
    await page.keyboard.press("m");
    await page.getByRole("heading", { name: "Roadmap", exact: true }).waitFor();
    assert.match(page.url(), /view=roadmap/);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: "Roadmap", exact: true }).click();
    await page.getByRole("heading", { name: "Roadmap", exact: true }).waitFor();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder(/./).last().fill("Roadmap");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Roadmap", exact: true }).waitFor();
    await context.close();
  }

  // Click traces, canvas and re-click clear, double-click opens the drawer.
  {
    const { page, context } = await open({ beads: fixture() });
    await ready(page);
    await nodeOf(page, "waiting").click();
    await panel(page).waitFor();
    assert.equal(await nodeOf(page, "waiting").getAttribute("aria-current"), "true");
    assert.equal(await nodeOf(page, "gate").getAttribute("data-dim"), "true", "outside the lineage dims");
    assert.equal(await nodeOf(page, "root").getAttribute("data-dim"), null, "upstream stays lit");
    assert.equal(await nodeOf(page, "end").getAttribute("data-dim"), null, "downstream stays lit");
    assert.equal(await page.locator('[data-edge-id="waiting->doing:blocks"]').getAttribute("data-hot"), "true");
    assert.equal(await page.locator('[data-edge-id="next->root:blocks"]').getAttribute("data-hot"), null, "a side branch is not on the path");
    const text = await panel(page).innerText();
    assert.match(text, /Needs/);
    assert.match(text, /doing/);
    assert.match(text, /Hidden blockers/);
    assert.match(text, /archived-open/);
    assert.match(text, /gone · not found/);
    assert.match(text, /Directly unblocks/);
    assert.match(text, /1 open bead downstream/);
    await page.locator("[data-roadmap-scroller]").click({ position: { x: 500, y: 620 } });
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await dimmed(page), 0, "clearing removes the trace");
    await nodeOf(page, "next").click();
    await panel(page).waitFor();
    await nodeOf(page, "next").click();
    await panel(page).waitFor({ state: "detached" });
    await nodeOf(page, "end").dblclick();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await nodeOf(page, "end").click({ force: true });
    if (!(await panel(page).count())) await nodeOf(page, "end").click();
    await panel(page).getByRole("button", { name: "Open bead" }).click();
    await page.getByRole("dialog").waitFor();
    await context.close();
  }

  // J/K/H/L move and trace, Enter opens the drawer.
  {
    const { page, context } = await open({ beads: fixture() });
    await ready(page);
    const current = () => page.locator('[data-keyboard-bead-id][aria-current="true"]').getAttribute("data-keyboard-bead-id");
    await page.keyboard.press("j");
    const first = await current();
    await page.keyboard.press("j");
    const second = await current();
    assert.notEqual(first, second);
    await panel(page).waitFor();
    await page.keyboard.press("k");
    assert.equal(await current(), first);
    await page.keyboard.press("l");
    const right = await current();
    assert.notEqual(right, first);
    const x = (id) => nodeOf(page, id).evaluate((el) => el.getBoundingClientRect().x);
    assert.ok((await x(right)) > (await x(first)), "L moves to the right");
    await page.keyboard.press("h");
    assert.ok((await x(await current())) < (await x(right)), "H moves to the left");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await context.close();
  }

  // Highlight chips dim without moving anything; Hide completed removes and is remembered.
  {
    const { page, context } = await open({ beads: fixture() });
    await ready(page);
    const before = await transforms(page);
    await page.getByRole("button", { name: "Next up", exact: true }).click();
    assert.equal(await nodeOf(page, "root").getAttribute("data-dim"), "true");
    assert.equal(await nodeOf(page, "next").getAttribute("data-dim"), null);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(await nodeOf(page, "root").getAttribute("data-dim"), null);
    assert.equal(await nodeOf(page, "next").getAttribute("data-dim"), "true");
    assert.deepEqual(await transforms(page), before, "chips never move nodes");
    await page.getByRole("button", { name: "Hide completed", exact: true }).click();
    await nodeOf(page, "root").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Done", exact: true }).isDisabled(), true);
    assert.equal(await dimmed(page), 0, "the done highlight falls away");
    assert.match(await page.getByText(/of \d+/).first().innerText(), /^1 of/, "the done count survives hiding");
    await page.reload();
    await ready(page);
    assert.equal(await nodeOf(page, "root").count(), 0, "the toggle is remembered");
    await page.getByRole("button", { name: "Hide completed", exact: true }).click();
    await nodeOf(page, "root").waitFor();
    await context.close();
  }

  // Next up rail: order matches the badges, needs-you stays separate.
  {
    const beads = [
      ...fixture(),
      bead("second", { priority: 1 }), bead("second-end", { dependencies: [dep("second")] }),
      bead("question", { labels: ["human"], priority: 1 }),
      bead("late-loose", { priority: 4 }),
    ];
    const { page, state, context } = await open({ beads });
    await ready(page);
    await railRow(page, "next").waitFor();
    assert.deepEqual(await railIds(page), ["question", "gate", "next", "second", "alone", "late-loose"]);
    const ranked = await rail(page).getByRole("list", { name: "Ready, in order" }).locator("[data-rail-id]").evaluateAll((els) => els.map((el) => [el.dataset.railId, el.innerText.match(/NEXT (\d+)/)?.[1]]));
    assert.deepEqual(ranked.map(([, n]) => n), ["1", "2", "3", "4"], "numbered without holes");
    for (const [id, n] of ranked.slice(0, 2)) assert.match(await nodeOf(page, id).innerText(), new RegExp(`NEXT ${n}\\b`), `${id} badge matches the rail`);
    assert.match(await rail(page).getByRole("list", { name: "Needs you" }).innerText(), /NEEDS YOU[\s\S]*NEEDS YOU/);
    assert.match(await railRow(page, "alone").innerText(), /Unlinked/);

    // Selecting traces it, and scrolls the map to it.
    await railRow(page, "next").click();
    await panel(page).waitFor();
    assert.equal(await nodeOf(page, "next").getAttribute("aria-current"), "true");
    assert.equal(await railRow(page, "next").getAttribute("aria-current"), "true");
    assert.equal(await nodeOf(page, "gate").getAttribute("data-dim"), "true");

    // A collapsed bead expands so it can be traced, keeping its number.
    assert.equal(await nodeOf(page, "alone").count(), 0);
    await railRow(page, "alone").click();
    await nodeOf(page, "alone").waitFor();
    assert.equal(await nodeOf(page, "alone").getAttribute("aria-current"), "true");
    assert.match(await nodeOf(page, "alone").innerText(), /NEXT 3\b/);
    const inView = await nodeOf(page, "alone").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const area = document.querySelector("[data-roadmap-scroller]").getBoundingClientRect();
      return box.top >= area.top && box.bottom <= area.bottom && box.left >= area.left && box.right <= area.right;
    });
    assert.equal(inView, true, "the map scrolls to the selected bead");

    // Keyboard: rows are tab stops, J/K stay on the map, and the rail follows.
    await railRow(page, "second").focus();
    await page.keyboard.press("Enter");
    assert.equal(await nodeOf(page, "second").getAttribute("aria-current"), "true");
    await page.keyboard.press("j");
    const moved = await page.evaluate(() => document.activeElement?.dataset.keyboardBeadId);
    assert.ok(moved && moved !== "second", "J moves on to the next map node");
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-rail-id")), false, "J never lands in the rail");
    assert.equal(await page.locator("[data-rail-id][data-keyboard-bead-id]").count(), 0, "rail rows aren't keyboard candidates");
    await railRow(page, "next").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("o");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await railRow(page, "second").dblclick();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // A refresh doesn't drag the map back to the last revealed bead.
    await page.evaluate(() => document.querySelector("[data-roadmap-scroller]").scrollTo(0, 0));
    await page.evaluate(() => document.querySelector("[data-roadmap-scroller]").scrollTo(0, 60));
    state.beads = [...beads, bead("newcomer")];
    await railRow(page, "newcomer").waitFor();
    assert.equal(await page.evaluate(() => document.querySelector("[data-roadmap-scroller]").scrollTop), 60, "a refresh keeps the scroll position");

    // It collapses, the column gives the room back, and that is remembered.
    await page.locator("[data-roadmap-scroller]").click({ position: { x: 500, y: 700 } });
    await panel(page).waitFor({ state: "detached" });
    const wide = await page.locator("[data-roadmap-scroller]").evaluate((el) => el.clientWidth);
    await page.getByRole("button", { name: "Hide the Next up list" }).click();
    await railRow(page, "next").waitFor({ state: "detached" });
    assert.ok((await page.locator("[data-roadmap-scroller]").evaluate((el) => el.clientWidth)) > wide + 100, "the map gets the room");
    await page.reload();
    await ready(page);
    assert.equal(await railRow(page, "next").count(), 0, "collapsed is remembered");
    await page.getByRole("button", { name: "Show the Next up list" }).click();
    await railRow(page, "next").waitFor();
    assert.deepEqual(state.writes, [], "the rail never writes");
    await context.close();
  }

  // A project of loose beads still has a next step; nothing ready says so.
  {
    const { page, context } = await open({ beads: [bead("one"), bead("two", { priority: 0 })] });
    await railRow(page, "two").waitFor();
    assert.deepEqual(await railIds(page), ["two", "one"]);
    await railRow(page, "two").click();
    await nodeOf(page, "two").waitFor();
    await context.close();
    const busy = await open({ beads: [bead("working", { status: "in_progress" }), bead("waiting", { dependencies: [dep("working")] })] });
    await busy.page.getByText("Nothing is ready right now.").waitFor();
    await busy.context.close();
  }

  // Epic scope.
  {
    const { page, context } = await open({ beads: fixture() });
    await ready(page);
    await page.getByLabel("Scope").selectOption("epic-a");
    await nodeOf(page, "gate").waitFor({ state: "detached" });
    assert.deepEqual(await ids(page), ["doing", "end", "next", "root", "waiting"]);
    assert.match(await nodeOf(page, "waiting").innerText(), /Outside epic/);
    await context.close();
  }

  // Empty states.
  {
    const { page, context } = await open({ beads: [bead("one"), bead("two")] });
    await page.getByText("None of these beads depend on each other yet.").waitFor();
    await page.getByRole("button", { name: "Show 2 unlinked" }).click();
    await nodeOf(page, "one").waitFor();
    await context.close();
    const empty = await open({ beads: [] });
    await empty.page.getByText("Nothing to map here yet.").waitFor();
    await empty.context.close();
  }

  // Live updates: an unchanged poll keeps every node, and a change keeps your place.
  {
    const chain = (closed) => [
      ...Array.from({ length: 30 }, (_, i) => bead(`s${i}`, { dependencies: [dep(`t${i}`)] })),
      ...Array.from({ length: 30 }, (_, i) => bead(`t${i}`)),
      bead("a", { status: closed ? "closed" : "open" }),
      bead("b", { dependencies: [dep("a")] }),
      bead("c", { dependencies: [dep("b")] }),
      bead("d", { dependencies: [dep("c")] }),
      bead("e", { dependencies: [dep("d")] }),
      bead("f", { dependencies: [dep("e")] }),
      bead("g", { dependencies: [dep("f")] }),
      bead("h", { dependencies: [dep("g")] }),
    ];
    const { page, state, context } = await open({ beads: chain(false), viewport: { width: 1200, height: 500 } });
    await ready(page);
    await page.getByRole("button", { name: "Hide completed", exact: true }).click();
    const polled = () => page.waitForResponse((r) => r.url().endsWith("/api/p/demo/beads"));
    await page.evaluate(() => {
      document.querySelector("[data-roadmap-scroller]").scrollTo(180, 900);
      for (const el of document.querySelectorAll("[data-keyboard-bead-id]")) el.__kept = true;
    });
    await polled();
    await polled();
    const unchanged = await page.evaluate(() => ({
      kept: [...document.querySelectorAll("[data-keyboard-bead-id]")].every((el) => el.__kept),
      top: document.querySelector("[data-roadmap-scroller]").scrollTop,
      left: document.querySelector("[data-roadmap-scroller]").scrollLeft,
    }));
    assert.deepEqual(unchanged, { kept: true, top: 900, left: 180 }, "an unchanged poll is invisible");

    await nodeOf(page, "e").evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
    await nodeOf(page, "e").click();
    await panel(page).waitFor();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    const onScreen = () => nodeOf(page, "e").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
    const start = await onScreen();
    const moved = await transforms(page);
    state.beads = chain(true);
    await page.waitForFunction((was) => JSON.stringify([...document.querySelectorAll("[data-keyboard-bead-id]")].map((el) => el.style.transform).sort()) !== was, JSON.stringify([...moved].sort()));
    await page.waitForTimeout(350);
    const end = await onScreen();
    assert.ok(Math.abs(end.x - start.x) <= 2 && Math.abs(end.y - start.y) <= 2, `selected node stays put: ${JSON.stringify({ start, end })}`);
    assert.equal(await nodeOf(page, "a").count(), 0);

    state.beads = chain(true).filter((b) => b.id !== "e");
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await dimmed(page), 0, "a bead leaving the map clears its trace");
    await context.close();
  }

  // Never writes.
  {
    const { page, state, context } = await open({ beads: fixture() });
    await ready(page);
    await nodeOf(page, "waiting").click();
    await page.getByRole("button", { name: "Next up", exact: true }).click();
    await page.getByRole("button", { name: "Hide completed", exact: true }).click();
    await page.getByRole("button", { name: "Hide completed", exact: true }).click();
    await page.keyboard.press("j");
    assert.deepEqual(state.writes, []);
    await context.close();
  }

  // Narrow screens: only the map scrolls sideways.
  {
    const { page, context } = await open({ beads: fixture(), viewport: { width: 390, height: 780 } });
    await ready(page);
    await nodeOf(page, "waiting").click();
    await panel(page).waitFor();
    const sizes = await page.evaluate(() => {
      const map = document.querySelector("[data-roadmap-scroller]");
      return { page: document.documentElement.scrollWidth, width: innerWidth, map: map.scrollWidth, shown: map.clientWidth };
    });
    assert.ok(sizes.page <= sizes.width, `page scrolls sideways: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.map > sizes.shown, "the map scrolls instead");
    const bottom = await panel(page).evaluate((el) => el.getBoundingClientRect().bottom);
    assert.ok(bottom <= 780, "the panel docks inside the screen");
    const top = (locator) => locator.evaluate((el) => el.getBoundingClientRect().top);
    const map = page.locator("[data-roadmap-scroller]");
    assert.ok((await top(rail(page))) < (await top(map)), "the rail stacks above the map");
    assert.ok((await top(map)) < (await top(panel(page))), "the panel docks below the map");
    assert.equal(await railRow(page, "next").isVisible(), false, "the rail folds to its header while the panel is open");
    assert.ok((await map.evaluate((el) => el.clientHeight)) >= 160, "the map keeps usable height");
    await panel(page).getByRole("button", { name: "Clear" }).click();
    await railRow(page, "next").waitFor();
    await railRow(page, "next").click();
    await panel(page).waitFor();
    assert.equal(await nodeOf(page, "next").getAttribute("aria-current"), "true");
    await context.close();

    // Tablet width: the rail and panel don't squeeze the map to nothing.
    const tablet = await open({ beads: fixture(), viewport: { width: 820, height: 1000 } });
    await ready(tablet.page);
    await nodeOf(tablet.page, "waiting").click();
    await panel(tablet.page).waitFor();
    assert.ok((await tablet.page.locator("[data-roadmap-scroller]").evaluate((el) => el.clientWidth)) >= 500, "the map keeps its width");
    await tablet.context.close();
  }

  // Every theme: no errors, AA text, and states that don't rely on colour.
  const contrast = {};
  for (const theme of themes) {
    const { page, state, context } = await open({ beads: fixture(), theme });
    await ready(page);
    await page.waitForTimeout(250);
    const failures = await page.evaluate(() => {
      const parse = (value) => {
        const numbers = value.match(/[\d.]+(?:e-?\d+)?/g).map(Number);
        const scale = value.startsWith("color(") ? 1 : 1 / 255;
        return { rgb: numbers.slice(0, 3).map((n) => n * scale), alpha: numbers[3] ?? 1 };
      };
      const luminance = ([r, g, b]) => {
        const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const background = (el) => {
        for (let current = el; current; current = current.parentElement) {
          const fill = parse(getComputedStyle(current).backgroundColor);
          if (fill.alpha > 0.99) return fill.rgb;
        }
        return [1, 1, 1];
      };
      const bad = [];
      for (const el of document.querySelectorAll("[data-contrast]")) {
        const text = parse(getComputedStyle(el).color).rgb;
        const [a, b] = [luminance(text), luminance(background(el))].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        if (ratio < 4.5) bad.push(`${el.textContent.slice(0, 24)}: ${ratio.toFixed(2)}`);
      }
      return [...new Set(bad)];
    });
    if (failures.length) contrast[theme] = failures;
    // Done is green, muted, and unlike on-hold or blocked work.
    const look = await page.evaluate(() => {
      const channels = (value) => {
        const numbers = value.match(/[\d.]+(?:e-?\d+)?/g).map(Number).slice(0, 3);
        return value.startsWith("color(") ? numbers : numbers.map((n) => n / 255);
      };
      const fill = (id) => getComputedStyle(document.querySelector(`[data-keyboard-bead-id="${id}"]`)).backgroundColor;
      const probe = document.createElement("div");
      probe.style.background = "var(--surface-2)";
      document.body.append(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const greenness = (value) => { const [r, g, b] = channels(value); return g - (r + b) / 2; };
      const bar = (id) => getComputedStyle(document.querySelector(`[data-keyboard-bead-id="${id}"] > span[aria-hidden]`)).backgroundColor;
      const [r, g, b] = channels(bar("root"));
      return {
        tint: greenness(fill("root")) - greenness(surface),
        barGreen: g > r && g > b,
        fills: new Set([fill("root"), fill("hold"), fill("waiting"), fill("next")]).size,
        swatch: [...document.querySelectorAll("span[aria-hidden]")].some((el) => getComputedStyle(el).backgroundColor === bar("root") && !el.closest("[data-keyboard-bead-id]")),
      };
    });
    assert.ok(look.tint > 0.005, `${theme} done fill is tinted green: ${look.tint}`);
    assert.equal(look.barGreen, true, `${theme} done bar is green`);
    assert.equal(look.fills, 4, `${theme} done, on hold, blocked and ready all differ`);
    assert.equal(look.swatch, true, `${theme} legend and stats use the same green`);
    assert.equal(await nodeOf(page, "root").evaluate((el) => el.style.borderStyle), "solid", "done is not dashed");
    assert.match(await nodeOf(page, "root").innerText(), /✓ DONE/);
    assert.equal(await nodeOf(page, "root").locator(".line-through").count(), 1, "done stays struck through");
    assert.ok(Math.abs((await page.locator('[data-edge-id="next->root:blocks"]').evaluate((el) => Number(el.getAttribute("opacity")))) - 0.6) < 0.01, "met links are muted");
    assert.deepEqual(state.errors, [], `${theme} errors`);
    const blocked = nodeOf(page, "waiting");
    assert.equal(await blocked.evaluate((el) => el.style.borderStyle), "dashed", "blocked is dashed");
    if (shots) await page.screenshot({ path: `${shots}/roadmap-${theme}.png` });
    await context.close();
  }

  assert.deepEqual(contrast, {}, "node text meets AA in every theme");

  // Scale: 500 nodes and about 1,000 edges.
  {
    const beads = Array.from({ length: 500 }, (_, i) => bead(`n${i}`, {
      priority: i % 5,
      status: i % 7 === 0 ? "closed" : "open",
      dependencies: i >= 25 ? [dep(`n${i - 25 + (i % 5)}`), dep(`n${i - 25 + ((i + 3) % 11)}`), dep(`n${i - 25 + ((i + 7) % 17)}`)] : [],
    }));
    const started = Date.now();
    const { page, state, context } = await open({ beads });
    await ready(page);
    const render = Date.now() - started;
    const count = await page.locator("[data-keyboard-bead-id]").count();
    const edges = await page.locator("[data-edge-id]").count();
    const reachable = await page.evaluate(() => [...document.querySelectorAll("[data-keyboard-bead-id]")].every((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }));
    assert.equal(reachable, true, "every node stays a keyboard candidate");
    const frames = await page.evaluate(() => new Promise((done) => {
      const map = document.querySelector("[data-roadmap-scroller]");
      const times = [];
      let last = performance.now();
      const tick = (now) => {
        times.push(now - last);
        last = now;
        map.scrollTop += 40;
        map.scrollLeft += 12;
        if (times.length < 120) requestAnimationFrame(tick);
        else done(times.slice(1));
      };
      requestAnimationFrame(tick);
    }));
    frames.sort((a, b) => a - b);
    const median = frames[Math.floor(frames.length / 2)];
    const p95 = frames[Math.floor(frames.length * 0.95)];
    const selectStart = await page.evaluate(() => performance.now());
    await nodeOf(page, "n250").evaluate((el) => el.click());
    await panel(page).waitFor();
    const select = (await page.evaluate(() => performance.now())) - selectStart;
    console.log(`Scale: ${count} nodes, ${edges} edges; load ${render}ms; scroll frames median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms; trace ${select.toFixed(0)}ms`);
    assert.ok(count >= 480 && edges >= 1000, "fixture reaches the target size");
    assert.ok(median < 34, `scrolling stays smooth: ${median}`);
    assert.deepEqual(state.errors, []);
    await context.close();
  }

  console.log("Roadmap view checks passed");
} finally {
  await browser.close();
}
