// ---------------------------------------------------------------------------
// State machine tests
//
// Tests for src/tui/state-machine.ts. All functions are pure, so no mocking
// is required. Every test creates fresh state objects to verify immutability.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  initialState,
  transition,
  mapKeyToAction,
  type TUIState,
  type TUIView,
} from '../state-machine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a state object starting from initialState with overrides applied. */
function makeState(overrides: Partial<TUIState> = {}): TUIState {
  return { ...initialState(), ...overrides };
}

// ---------------------------------------------------------------------------
// initialState()
// ---------------------------------------------------------------------------

describe('initialState()', () => {
  it('returns view "progress"', () => {
    expect(initialState().view).toBe('progress');
  });

  it('returns selectedIndex 0', () => {
    expect(initialState().selectedIndex).toBe(0);
  });

  it('returns detailScrollOffset 0', () => {
    expect(initialState().detailScrollOffset).toBe(0);
  });

  it('returns shouldExit false', () => {
    expect(initialState().shouldExit).toBe(false);
  });

  it('returns the exact shape documented', () => {
    expect(initialState()).toEqual({
      view: 'progress',
      selectedIndex: 0,
      detailScrollOffset: 0,
      shouldExit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// transition() — PIPELINE_COMPLETE
// ---------------------------------------------------------------------------

describe('transition() — PIPELINE_COMPLETE', () => {
  it('transitions from progress to dashboard', () => {
    const next = transition(makeState({ view: 'progress' }), { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next.view).toBe('dashboard');
  });

  it('is a no-op from dashboard', () => {
    const state = makeState({ view: 'dashboard' });
    const next = transition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).toBe(state); // same reference → pure no-op
  });

  it('is a no-op from detail', () => {
    const state = makeState({ view: 'detail' });
    const next = transition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).toBe(state);
  });

  it('is a no-op from specs', () => {
    const state = makeState({ view: 'specs' });
    const next = transition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — SELECT_FINDING
// ---------------------------------------------------------------------------

describe('transition() — SELECT_FINDING', () => {
  it('transitions from dashboard to detail', () => {
    const next = transition(
      makeState({ view: 'dashboard' }),
      { type: 'SELECT_FINDING', index: 2 },
      5,
    );
    expect(next.view).toBe('detail');
  });

  it('sets selectedIndex from the action', () => {
    const next = transition(
      makeState({ view: 'dashboard', selectedIndex: 0 }),
      { type: 'SELECT_FINDING', index: 3 },
      5,
    );
    expect(next.selectedIndex).toBe(3);
  });

  it('is a no-op from progress', () => {
    const state = makeState({ view: 'progress' });
    expect(transition(state, { type: 'SELECT_FINDING', index: 1 }, 5)).toBe(state);
  });

  it('is a no-op from detail', () => {
    const state = makeState({ view: 'detail' });
    expect(transition(state, { type: 'SELECT_FINDING', index: 1 }, 5)).toBe(state);
  });

  it('is a no-op from specs', () => {
    const state = makeState({ view: 'specs' });
    expect(transition(state, { type: 'SELECT_FINDING', index: 1 }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — BACK
// ---------------------------------------------------------------------------

describe('transition() — BACK', () => {
  it('transitions from detail to dashboard', () => {
    const next = transition(makeState({ view: 'detail' }), { type: 'BACK' }, 5);
    expect(next.view).toBe('dashboard');
  });

  it('resets detailScrollOffset when going back from detail', () => {
    const state = makeState({ view: 'detail', detailScrollOffset: 10 });
    const next = transition(state, { type: 'BACK' }, 5);
    expect(next.detailScrollOffset).toBe(0);
  });

  it('transitions from specs to dashboard', () => {
    const next = transition(makeState({ view: 'specs' }), { type: 'BACK' }, 5);
    expect(next.view).toBe('dashboard');
  });

  it('is a no-op from dashboard', () => {
    const state = makeState({ view: 'dashboard' });
    expect(transition(state, { type: 'BACK' }, 5)).toBe(state);
  });

  it('is a no-op from progress', () => {
    const state = makeState({ view: 'progress' });
    expect(transition(state, { type: 'BACK' }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — TAB
// ---------------------------------------------------------------------------

describe('transition() — TAB', () => {
  it('transitions from dashboard to specs', () => {
    const next = transition(makeState({ view: 'dashboard' }), { type: 'TAB' }, 5);
    expect(next.view).toBe('specs');
  });

  it('transitions from specs to dashboard', () => {
    const next = transition(makeState({ view: 'specs' }), { type: 'TAB' }, 5);
    expect(next.view).toBe('dashboard');
  });

  it('is a no-op from progress', () => {
    const state = makeState({ view: 'progress' });
    expect(transition(state, { type: 'TAB' }, 5)).toBe(state);
  });

  it('is a no-op from detail', () => {
    const state = makeState({ view: 'detail' });
    expect(transition(state, { type: 'TAB' }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — QUIT
// ---------------------------------------------------------------------------

describe('transition() — QUIT', () => {
  const views: TUIView[] = ['progress', 'dashboard', 'detail', 'specs'];

  for (const view of views) {
    it(`sets shouldExit from ${view}`, () => {
      const next = transition(makeState({ view }), { type: 'QUIT' }, 5);
      expect(next.shouldExit).toBe(true);
    });
  }

  it('preserves the current view when quitting', () => {
    const next = transition(makeState({ view: 'dashboard' }), { type: 'QUIT' }, 5);
    expect(next.view).toBe('dashboard');
  });
});

// ---------------------------------------------------------------------------
// transition() — MOVE_UP
// ---------------------------------------------------------------------------

describe('transition() — MOVE_UP', () => {
  it('decrements selectedIndex in dashboard', () => {
    const next = transition(makeState({ view: 'dashboard', selectedIndex: 3 }), { type: 'MOVE_UP' }, 5);
    expect(next.selectedIndex).toBe(2);
  });

  it('clamps selectedIndex to 0 in dashboard', () => {
    const next = transition(makeState({ view: 'dashboard', selectedIndex: 0 }), { type: 'MOVE_UP' }, 5);
    expect(next.selectedIndex).toBe(0);
  });

  it('decrements detailScrollOffset in detail', () => {
    const next = transition(
      makeState({ view: 'detail', detailScrollOffset: 5 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.detailScrollOffset).toBe(4);
  });

  it('clamps detailScrollOffset to 0 in detail', () => {
    const next = transition(
      makeState({ view: 'detail', detailScrollOffset: 0 }),
      { type: 'MOVE_UP' },
      5,
    );
    expect(next.detailScrollOffset).toBe(0);
  });

  it('is a no-op from progress', () => {
    const state = makeState({ view: 'progress' });
    expect(transition(state, { type: 'MOVE_UP' }, 5)).toBe(state);
  });

  it('is a no-op from specs', () => {
    const state = makeState({ view: 'specs' });
    expect(transition(state, { type: 'MOVE_UP' }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — MOVE_DOWN
// ---------------------------------------------------------------------------

describe('transition() — MOVE_DOWN', () => {
  it('increments selectedIndex in dashboard', () => {
    const next = transition(makeState({ view: 'dashboard', selectedIndex: 1 }), { type: 'MOVE_DOWN' }, 5);
    expect(next.selectedIndex).toBe(2);
  });

  it('clamps selectedIndex to findingsCount - 1 in dashboard', () => {
    const next = transition(makeState({ view: 'dashboard', selectedIndex: 4 }), { type: 'MOVE_DOWN' }, 5);
    expect(next.selectedIndex).toBe(4); // max is 5-1 = 4
  });

  it('does not go below 0 when findingsCount is 0', () => {
    const next = transition(makeState({ view: 'dashboard', selectedIndex: 0 }), { type: 'MOVE_DOWN' }, 0);
    expect(next.selectedIndex).toBe(0);
  });

  it('increments detailScrollOffset in detail', () => {
    const next = transition(
      makeState({ view: 'detail', detailScrollOffset: 3 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.detailScrollOffset).toBe(4);
  });

  it('increments detailScrollOffset beyond any cap (no upper bound)', () => {
    const next = transition(
      makeState({ view: 'detail', detailScrollOffset: 100 }),
      { type: 'MOVE_DOWN' },
      5,
    );
    expect(next.detailScrollOffset).toBe(101);
  });

  it('is a no-op from progress', () => {
    const state = makeState({ view: 'progress' });
    expect(transition(state, { type: 'MOVE_DOWN' }, 5)).toBe(state);
  });

  it('is a no-op from specs', () => {
    const state = makeState({ view: 'specs' });
    expect(transition(state, { type: 'MOVE_DOWN' }, 5)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// transition() — immutability
// ---------------------------------------------------------------------------

describe('transition() — immutability', () => {
  it('does not mutate the input state on MOVE_DOWN', () => {
    const state = makeState({ view: 'dashboard', selectedIndex: 2 });
    const frozen = Object.freeze({ ...state });
    // We don't freeze the original so we can read it after transition.
    const original = { ...state };
    transition(state, { type: 'MOVE_DOWN' }, 10);
    expect(state).toEqual(original); // unchanged
    expect(frozen).toEqual(original);
  });

  it('does not mutate the input state on PIPELINE_COMPLETE', () => {
    const state = makeState({ view: 'progress' });
    const original = { ...state };
    transition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(state).toEqual(original);
  });

  it('returns a new object reference when a transition occurs', () => {
    const state = makeState({ view: 'progress' });
    const next = transition(state, { type: 'PIPELINE_COMPLETE' }, 5);
    expect(next).not.toBe(state);
  });
});

// ---------------------------------------------------------------------------
// mapKeyToAction()
// ---------------------------------------------------------------------------

describe('mapKeyToAction()', () => {
  // ── QUIT ─────────────────────────────────────────────────────────────────

  it('"q" maps to QUIT from any view', () => {
    const views: TUIView[] = ['progress', 'dashboard', 'detail', 'specs'];
    for (const view of views) {
      expect(mapKeyToAction('', 'q', view)).toEqual({ type: 'QUIT' });
    }
  });

  // ── SELECT_FINDING ────────────────────────────────────────────────────────

  it('"return" key maps to SELECT_FINDING from dashboard', () => {
    const action = mapKeyToAction('return', '', 'dashboard');
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 0 });
  });

  it('"enter" key maps to SELECT_FINDING from dashboard', () => {
    const action = mapKeyToAction('enter', '', 'dashboard');
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 0 });
  });

  it('uses the provided selectedIndex for SELECT_FINDING', () => {
    const action = mapKeyToAction('return', '', 'dashboard', 3);
    expect(action).toEqual({ type: 'SELECT_FINDING', index: 3 });
  });

  it('"return" key is null from progress', () => {
    expect(mapKeyToAction('return', '', 'progress')).toBeNull();
  });

  it('"return" key is null from detail', () => {
    expect(mapKeyToAction('return', '', 'detail')).toBeNull();
  });

  it('"return" key is null from specs', () => {
    expect(mapKeyToAction('return', '', 'specs')).toBeNull();
  });

  // ── BACK ─────────────────────────────────────────────────────────────────

  it('"escape" maps to BACK', () => {
    expect(mapKeyToAction('escape', '', 'detail')).toEqual({ type: 'BACK' });
  });

  it('"escape" maps to BACK from dashboard', () => {
    expect(mapKeyToAction('escape', '', 'dashboard')).toEqual({ type: 'BACK' });
  });

  // ── TAB ──────────────────────────────────────────────────────────────────

  it('"tab" maps to TAB', () => {
    expect(mapKeyToAction('tab', '', 'dashboard')).toEqual({ type: 'TAB' });
  });

  // ── MOVE_UP ───────────────────────────────────────────────────────────────

  it('"upArrow" maps to MOVE_UP', () => {
    expect(mapKeyToAction('upArrow', '', 'dashboard')).toEqual({ type: 'MOVE_UP' });
  });

  it('"k" input maps to MOVE_UP', () => {
    expect(mapKeyToAction('', 'k', 'dashboard')).toEqual({ type: 'MOVE_UP' });
  });

  // ── MOVE_DOWN ─────────────────────────────────────────────────────────────

  it('"downArrow" maps to MOVE_DOWN', () => {
    expect(mapKeyToAction('downArrow', '', 'dashboard')).toEqual({ type: 'MOVE_DOWN' });
  });

  it('"j" input maps to MOVE_DOWN', () => {
    expect(mapKeyToAction('', 'j', 'dashboard')).toEqual({ type: 'MOVE_DOWN' });
  });

  // ── Unknown keys ─────────────────────────────────────────────────────────

  it('returns null for an unmapped key', () => {
    expect(mapKeyToAction('', 'x', 'dashboard')).toBeNull();
  });

  it('returns null for empty key and input', () => {
    expect(mapKeyToAction('', '', 'dashboard')).toBeNull();
  });

  it('returns null for a space character', () => {
    expect(mapKeyToAction('', ' ', 'dashboard')).toBeNull();
  });

  it('returns null for an unrecognised named key', () => {
    expect(mapKeyToAction('f5', '', 'dashboard')).toBeNull();
  });
});
