// ---------------------------------------------------------------------------
// Dashboard state machine tests
//
// Tests for src/tui/dashboard-state.ts. All functions are pure, so no mocking
// is required. Every test creates fresh state objects to verify immutability.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  initialDashboardState,
  dashboardTransition,
  mapKeyToDashboardAction,
  type DashboardState,
  type DashboardPane,
} from '../dashboard-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a state object starting from initialDashboardState with overrides applied. */
function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return { ...initialDashboardState(), ...overrides };
}

// ---------------------------------------------------------------------------
// initialDashboardState()
// ---------------------------------------------------------------------------

describe('initialDashboardState()', () => {
  it('returns phase "loading"', () => {
    expect(initialDashboardState().phase).toBe('loading');
  });

  it('returns activePane "findings"', () => {
    expect(initialDashboardState().activePane).toBe('findings');
  });

  it('returns selectedIndex 0', () => {
    expect(initialDashboardState().selectedIndex).toBe(0);
  });

  it('returns detailScrollOffset 0', () => {
    expect(initialDashboardState().detailScrollOffset).toBe(0);
  });

  it('returns specsVisible false', () => {
    expect(initialDashboardState().specsVisible).toBe(false);
  });

  it('returns shouldExit false', () => {
    expect(initialDashboardState().shouldExit).toBe(false);
  });

  it('returns the exact shape documented', () => {
    expect(initialDashboardState()).toEqual({
      phase: 'loading',
      activePane: 'findings',
      selectedIndex: 0,
      detailScrollOffset: 0,
      specsVisible: false,
      shouldExit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — PIPELINE_COMPLETE
// ---------------------------------------------------------------------------

describe('dashboardTransition() — PIPELINE_COMPLETE', () => {
  it('transitions from loading to ready', () => {
    const next = dashboardTransition(
      makeState({ phase: 'loading' }),
      { type: 'PIPELINE_COMPLETE' },
      5,
    );
    expect(next.phase).toBe('ready');
  });

  it('sets activePane to "findings" on completion', () => {
    const next = dashboardTransition(
      makeState({ phase: 'loading', activePane: 'detail' }),
      { type: 'PIPELINE_COMPLETE' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('is a no-op from ready phase', () => {
    const state = makeState({ phase: 'ready' });
    const next = dashboardTransition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).toBe(state);
  });

  it('returns a new reference when transitioning from loading', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).not.toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — SELECT_FINDING
// ---------------------------------------------------------------------------

describe('dashboardTransition() — SELECT_FINDING', () => {
  it('sets activePane to "detail"', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings' }),
      { type: 'SELECT_FINDING', index: 2 },
      5,
    );
    expect(next.activePane).toBe('detail');
  });

  it('updates selectedIndex from the action', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', selectedIndex: 0 }),
      { type: 'SELECT_FINDING', index: 3 },
      5,
    );
    expect(next.selectedIndex).toBe(3);
  });

  it('works from detail pane (allows re-selection)', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail' }),
      { type: 'SELECT_FINDING', index: 1 },
      5,
    );
    expect(next.activePane).toBe('detail');
    expect(next.selectedIndex).toBe(1);
  });

  it('works from specs pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'specs' }),
      { type: 'SELECT_FINDING', index: 0 },
      5,
    );
    expect(next.activePane).toBe('detail');
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'SELECT_FINDING', index: 1 }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — FOCUS_NEXT_PANE
// ---------------------------------------------------------------------------

describe('dashboardTransition() — FOCUS_NEXT_PANE', () => {
  it('cycles findings → detail', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings' }),
      { type: 'FOCUS_NEXT_PANE' },
      5,
    );
    expect(next.activePane).toBe('detail');
  });

  it('cycles detail → specs when specsVisible is true', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', specsVisible: true }),
      { type: 'FOCUS_NEXT_PANE' },
      5,
    );
    expect(next.activePane).toBe('specs');
  });

  it('cycles detail → findings when specsVisible is false', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', specsVisible: false }),
      { type: 'FOCUS_NEXT_PANE' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('cycles specs → findings', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'specs', specsVisible: true }),
      { type: 'FOCUS_NEXT_PANE' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('completes a full cycle with specsVisible true', () => {
    let state = makeState({ phase: 'ready', activePane: 'findings', specsVisible: true });
    state = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(state.activePane).toBe('detail');
    state = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(state.activePane).toBe('specs');
    state = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(state.activePane).toBe('findings');
  });

  it('completes a full cycle with specsVisible false', () => {
    let state = makeState({ phase: 'ready', activePane: 'findings', specsVisible: false });
    state = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(state.activePane).toBe('detail');
    state = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(state.activePane).toBe('findings');
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'FOCUS_NEXT_PANE' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — FOCUS_PREV_PANE
// ---------------------------------------------------------------------------

describe('dashboardTransition() — FOCUS_PREV_PANE', () => {
  it('cycles findings → specs when specsVisible is true', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', specsVisible: true }),
      { type: 'FOCUS_PREV_PANE' },
      5,
    );
    expect(next.activePane).toBe('specs');
  });

  it('cycles findings → detail when specsVisible is false', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', specsVisible: false }),
      { type: 'FOCUS_PREV_PANE' },
      5,
    );
    expect(next.activePane).toBe('detail');
  });

  it('cycles detail → findings', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail' }),
      { type: 'FOCUS_PREV_PANE' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('cycles specs → detail', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'specs', specsVisible: true }),
      { type: 'FOCUS_PREV_PANE' },
      5,
    );
    expect(next.activePane).toBe('detail');
  });

  it('FOCUS_PREV_PANE is the exact reverse of FOCUS_NEXT_PANE (specsVisible true)', () => {
    const initial = makeState({ phase: 'ready', activePane: 'findings', specsVisible: true });
    const forward = dashboardTransition(initial, { type: 'FOCUS_NEXT_PANE' }, 5);
    const back = dashboardTransition(forward, { type: 'FOCUS_PREV_PANE' }, 5);
    expect(back.activePane).toBe(initial.activePane);
  });

  it('FOCUS_PREV_PANE is the exact reverse of FOCUS_NEXT_PANE (specsVisible false)', () => {
    const initial = makeState({ phase: 'ready', activePane: 'findings', specsVisible: false });
    const forward = dashboardTransition(initial, { type: 'FOCUS_NEXT_PANE' }, 5);
    const back = dashboardTransition(forward, { type: 'FOCUS_PREV_PANE' }, 5);
    expect(back.activePane).toBe(initial.activePane);
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'FOCUS_PREV_PANE' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — TOGGLE_SPECS
// ---------------------------------------------------------------------------

describe('dashboardTransition() — TOGGLE_SPECS', () => {
  it('enables specs when currently hidden', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', specsVisible: false }),
      { type: 'TOGGLE_SPECS' },
      5,
    );
    expect(next.specsVisible).toBe(true);
  });

  it('disables specs when currently visible', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', specsVisible: true, activePane: 'findings' }),
      { type: 'TOGGLE_SPECS' },
      5,
    );
    expect(next.specsVisible).toBe(false);
  });

  it('does not change activePane when hiding specs from non-specs pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', specsVisible: true, activePane: 'findings' }),
      { type: 'TOGGLE_SPECS' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('moves focus to detail when hiding specs while specs is active', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', specsVisible: true, activePane: 'specs' }),
      { type: 'TOGGLE_SPECS' },
      5,
    );
    expect(next.activePane).toBe('detail');
    expect(next.specsVisible).toBe(false);
  });

  it('does not change activePane when showing specs', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', specsVisible: false, activePane: 'findings' }),
      { type: 'TOGGLE_SPECS' },
      5,
    );
    expect(next.activePane).toBe('findings');
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'TOGGLE_SPECS' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — MOVE_UP
// ---------------------------------------------------------------------------

describe('dashboardTransition() — MOVE_UP', () => {
  it('decrements selectedIndex in findings pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 3 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.selectedIndex).toBe(2);
  });

  it('clamps selectedIndex to 0 in findings pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 0 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.selectedIndex).toBe(0);
  });

  it('decrements detailScrollOffset in detail pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', detailScrollOffset: 5 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.detailScrollOffset).toBe(4);
  });

  it('clamps detailScrollOffset to 0 in detail pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', detailScrollOffset: 0 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.detailScrollOffset).toBe(0);
  });

  it('is a no-op in specs pane', () => {
    const state = makeState({ phase: 'ready', activePane: 'specs' });
    const next = dashboardTransition(state, { type: 'MOVE_UP' }, 5);
    expect(next).toBe(state);
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'MOVE_UP' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — MOVE_DOWN
// ---------------------------------------------------------------------------

describe('dashboardTransition() — MOVE_DOWN', () => {
  it('increments selectedIndex in findings pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 1 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.selectedIndex).toBe(2);
  });

  it('clamps selectedIndex to findingsCount - 1 in findings pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 4 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.selectedIndex).toBe(4); // max is 5-1=4
  });

  it('does not go below 0 when findingsCount is 0', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 0 }),
      { type: 'MOVE_DOWN' },
      0,
    );
    expect(next.selectedIndex).toBe(0);
  });

  it('increments detailScrollOffset in detail pane', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', detailScrollOffset: 3 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.detailScrollOffset).toBe(4);
  });

  it('increments detailScrollOffset beyond any cap (no upper bound)', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail', detailScrollOffset: 100 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.detailScrollOffset).toBe(101);
  });

  it('is a no-op in specs pane', () => {
    const state = makeState({ phase: 'ready', activePane: 'specs' });
    const next = dashboardTransition(state, { type: 'MOVE_DOWN' }, 5);
    expect(next).toBe(state);
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'MOVE_DOWN' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — QUIT
// ---------------------------------------------------------------------------

describe('dashboardTransition() — QUIT', () => {
  const phases = ['loading', 'ready'] as const;
  const panes: DashboardPane[] = ['findings', 'detail', 'specs'];

  for (const phase of phases) {
    it(`sets shouldExit from ${phase} phase`, () => {
      const next = dashboardTransition(makeState({ phase }), { type: 'QUIT' }, 5);
      expect(next.shouldExit).toBe(true);
    });
  }

  for (const activePane of panes) {
    it(`sets shouldExit from ${activePane} pane`, () => {
      const next = dashboardTransition(
        makeState({ phase: 'ready', activePane }),
        { type: 'QUIT' },
        5,
      );
      expect(next.shouldExit).toBe(true);
    });
  }

  it('preserves phase when quitting', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready' }),
      { type: 'QUIT' },
      5,
    );
    expect(next.phase).toBe('ready');
  });

  it('preserves activePane when quitting', () => {
    const next = dashboardTransition(
      makeState({ phase: 'ready', activePane: 'detail' }),
      { type: 'QUIT' },
      5,
    );
    expect(next.activePane).toBe('detail');
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — BACK (no-op)
// ---------------------------------------------------------------------------

describe('dashboardTransition() — BACK', () => {
  it('is a no-op from findings pane', () => {
    const state = makeState({ phase: 'ready', activePane: 'findings' });
    expect(dashboardTransition(state, { type: 'BACK' }, 5)).toBe(state);
  });

  it('is a no-op from detail pane', () => {
    const state = makeState({ phase: 'ready', activePane: 'detail' });
    expect(dashboardTransition(state, { type: 'BACK' }, 5)).toBe(state);
  });

  it('is a no-op from specs pane', () => {
    const state = makeState({ phase: 'ready', activePane: 'specs' });
    expect(dashboardTransition(state, { type: 'BACK' }, 5)).toBe(state);
  });

  it('is a no-op during loading phase', () => {
    const state = makeState({ phase: 'loading' });
    expect(dashboardTransition(state, { type: 'BACK' }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// dashboardTransition() — immutability
// ---------------------------------------------------------------------------

describe('dashboardTransition() — immutability', () => {
  it('does not mutate the input state on MOVE_DOWN', () => {
    const state = makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 2 });
    const original = { ...state };
    dashboardTransition(state, { type: 'MOVE_DOWN' }, 10);
    expect(state).toEqual(original);
  });

  it('does not mutate the input state on PIPELINE_COMPLETE', () => {
    const state = makeState({ phase: 'loading' });
    const original = { ...state };
    dashboardTransition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(state).toEqual(original);
  });

  it('returns a new object reference when a transition occurs', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).not.toBe(state);
  });

  it('does not mutate the input state on TOGGLE_SPECS', () => {
    const state = makeState({ phase: 'ready', specsVisible: false });
    const original = { ...state };
    dashboardTransition(state, { type: 'TOGGLE_SPECS' }, 5);
    expect(state).toEqual(original);
  });

  it('does not mutate the input state on SELECT_FINDING', () => {
    const state = makeState({ phase: 'ready', activePane: 'findings', selectedIndex: 0 });
    const original = { ...state };
    dashboardTransition(state, { type: 'SELECT_FINDING', index: 3 }, 5);
    expect(state).toEqual(original);
  });

  it('returns same reference for a confirmed no-op', () => {
    const state = makeState({ phase: 'loading' });
    const next = dashboardTransition(state, { type: 'MOVE_DOWN' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// mapKeyToDashboardAction()
// ---------------------------------------------------------------------------

describe('mapKeyToDashboardAction()', () => {
  // ── QUIT ─────────────────────────────────────────────────────────────────

  it('"q" maps to QUIT from findings pane', () => {
    expect(mapKeyToDashboardAction('', 'q', 'findings')).toEqual({ type: 'QUIT' });
  });

  it('"q" maps to QUIT from detail pane', () => {
    expect(mapKeyToDashboardAction('', 'q', 'detail')).toEqual({ type: 'QUIT' });
  });

  it('"q" maps to QUIT from specs pane', () => {
    expect(mapKeyToDashboardAction('', 'q', 'specs')).toEqual({ type: 'QUIT' });
  });

  // ── SELECT_FINDING ────────────────────────────────────────────────────────

  it('"return" maps to SELECT_FINDING from findings pane', () => {
    const action = mapKeyToDashboardAction('return', '', 'findings');
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 0 });
  });

  it('"enter" maps to SELECT_FINDING from findings pane', () => {
    const action = mapKeyToDashboardAction('enter', '', 'findings');
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 0 });
  });

  it('uses the provided selectedIndex for SELECT_FINDING', () => {
    const action = mapKeyToDashboardAction('return', '', 'findings', 4);
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 4 });
  });

  it('"return" is null from detail pane', () => {
    expect(mapKeyToDashboardAction('return', '', 'detail')).toBeNull();
  });

  it('"return" is null from specs pane', () => {
    expect(mapKeyToDashboardAction('return', '', 'specs')).toBeNull();
  });

  // ── BACK ─────────────────────────────────────────────────────────────────

  it('"escape" maps to BACK from findings pane', () => {
    expect(mapKeyToDashboardAction('escape', '', 'findings')).toEqual({ type: 'BACK' });
  });

  it('"escape" maps to BACK from detail pane', () => {
    expect(mapKeyToDashboardAction('escape', '', 'detail')).toEqual({ type: 'BACK' });
  });

  it('"escape" maps to BACK from specs pane', () => {
    expect(mapKeyToDashboardAction('escape', '', 'specs')).toEqual({ type: 'BACK' });
  });

  // ── FOCUS_NEXT_PANE ───────────────────────────────────────────────────────

  it('"tab" maps to FOCUS_NEXT_PANE', () => {
    expect(mapKeyToDashboardAction('tab', '', 'findings')).toEqual({
      type: 'FOCUS_NEXT_PANE',
    });
  });

  it('"tab" maps to FOCUS_NEXT_PANE from any pane', () => {
    const panes: DashboardPane[] = ['findings', 'detail', 'specs'];
    for (const pane of panes) {
      expect(mapKeyToDashboardAction('tab', '', pane)).toEqual({
        type: 'FOCUS_NEXT_PANE',
      });
    }
  });

  // ── FOCUS_PREV_PANE ───────────────────────────────────────────────────────

  it('"shift+tab" maps to FOCUS_PREV_PANE', () => {
    expect(mapKeyToDashboardAction('shift+tab', '', 'findings')).toEqual({
      type: 'FOCUS_PREV_PANE',
    });
  });

  it('"shift+tab" maps to FOCUS_PREV_PANE from any pane', () => {
    const panes: DashboardPane[] = ['findings', 'detail', 'specs'];
    for (const pane of panes) {
      expect(mapKeyToDashboardAction('shift+tab', '', pane)).toEqual({
        type: 'FOCUS_PREV_PANE',
      });
    }
  });

  // ── TOGGLE_SPECS ──────────────────────────────────────────────────────────

  it('"t" maps to TOGGLE_SPECS', () => {
    expect(mapKeyToDashboardAction('', 't', 'findings')).toEqual({
      type: 'TOGGLE_SPECS',
    });
  });

  it('"t" maps to TOGGLE_SPECS from any pane', () => {
    const panes: DashboardPane[] = ['findings', 'detail', 'specs'];
    for (const pane of panes) {
      expect(mapKeyToDashboardAction('', 't', pane)).toEqual({
        type: 'TOGGLE_SPECS',
      });
    }
  });

  // ── MOVE_UP ───────────────────────────────────────────────────────────────

  it('"upArrow" maps to MOVE_UP', () => {
    expect(mapKeyToDashboardAction('upArrow', '', 'findings')).toEqual({
      type: 'MOVE_UP',
    });
  });

  it('"k" input maps to MOVE_UP', () => {
    expect(mapKeyToDashboardAction('', 'k', 'findings')).toEqual({
      type: 'MOVE_UP',
    });
  });

  it('"upArrow" maps to MOVE_UP from any pane', () => {
    const panes: DashboardPane[] = ['findings', 'detail', 'specs'];
    for (const pane of panes) {
      expect(mapKeyToDashboardAction('upArrow', '', pane)).toEqual({
        type: 'MOVE_UP',
      });
    }
  });

  // ── MOVE_DOWN ─────────────────────────────────────────────────────────────

  it('"downArrow" maps to MOVE_DOWN', () => {
    expect(mapKeyToDashboardAction('downArrow', '', 'findings')).toEqual({
      type: 'MOVE_DOWN',
    });
  });

  it('"j" input maps to MOVE_DOWN', () => {
    expect(mapKeyToDashboardAction('', 'j', 'findings')).toEqual({
      type: 'MOVE_DOWN',
    });
  });

  it('"downArrow" maps to MOVE_DOWN from any pane', () => {
    const panes: DashboardPane[] = ['findings', 'detail', 'specs'];
    for (const pane of panes) {
      expect(mapKeyToDashboardAction('downArrow', '', pane)).toEqual({
        type: 'MOVE_DOWN',
      });
    }
  });

  // ── Unknown / unmapped keys ───────────────────────────────────────────────

  it('returns null for an unmapped key', () => {
    expect(mapKeyToDashboardAction('', 'x', 'findings')).toBeNull();
  });

  it('returns null for empty key and input', () => {
    expect(mapKeyToDashboardAction('', '', 'findings')).toBeNull();
  });

  it('returns null for a space character', () => {
    expect(mapKeyToDashboardAction('', ' ', 'findings')).toBeNull();
  });

  it('returns null for an unrecognised named key', () => {
    expect(mapKeyToDashboardAction('f5', '', 'findings')).toBeNull();
  });
});
