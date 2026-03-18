// ---------------------------------------------------------------------------
// Dashboard pane-based state machine
//
// Pure, side-effect-free types and functions that govern keyboard-driven
// navigation within the pane-based dashboard layout. No Ink or React
// imports — fully testable in a Node environment.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three focusable panes in the dashboard layout. */
export type DashboardPane = 'findings' | 'detail' | 'specs';

/** Dashboard lifecycle phase. */
export type DashboardPhase = 'loading' | 'ready';

/** All actions that can drive a dashboard state transition. */
export type DashboardAction =
  | { type: 'PIPELINE_COMPLETE' }
  | { type: 'SELECT_FINDING'; index: number }
  | { type: 'FOCUS_NEXT_PANE' }
  | { type: 'FOCUS_PREV_PANE' }
  | { type: 'TOGGLE_SPECS' }
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' }
  | { type: 'QUIT' }
  | { type: 'BACK' };

/** Snapshot of the entire dashboard navigation state. */
export interface DashboardState {
  /** Current lifecycle phase. */
  phase: DashboardPhase;
  /** Currently focused pane. */
  activePane: DashboardPane;
  /** Index of the highlighted finding in the findings pane. */
  selectedIndex: number;
  /** Vertical scroll offset for the detail pane. */
  detailScrollOffset: number;
  /** When true, the specs pane is visible and focusable. */
  specsVisible: boolean;
  /** When true the TUI should exit on the next render cycle. */
  shouldExit: boolean;
}

// ---------------------------------------------------------------------------
// initialDashboardState
// ---------------------------------------------------------------------------

/**
 * Returns the default dashboard state — always begins in the loading phase
 * while the pipeline is running, with the findings pane initially focused.
 */
export function initialDashboardState(): DashboardState {
  return {
    phase: 'loading',
    activePane: 'findings',
    selectedIndex: 0,
    detailScrollOffset: 0,
    specsVisible: false,
    shouldExit: false,
  };
}

// ---------------------------------------------------------------------------
// dashboardTransition
// ---------------------------------------------------------------------------

/**
 * Pure reducer: given the current state and an action, returns the next state.
 * The input state is **never** mutated.
 *
 * Pane focus cycling (FOCUS_NEXT_PANE / FOCUS_PREV_PANE):
 *   - When `specsVisible` is true:  findings → detail → specs → findings
 *   - When `specsVisible` is false: findings → detail → findings
 *
 * @param state         - Current dashboard navigation state.
 * @param action        - The dispatched action.
 * @param findingsCount - Total number of findings (used to clamp MOVE_DOWN).
 * @returns             A new {@link DashboardState} object.
 */
export function dashboardTransition(
  state: DashboardState,
  action: DashboardAction,
  findingsCount: number,
): DashboardState {
  switch (action.type) {
    case 'PIPELINE_COMPLETE': {
      // Only meaningful from loading phase; no-op otherwise.
      if (state.phase !== 'loading') return state;
      return { ...state, phase: 'ready', activePane: 'findings' };
    }

    case 'QUIT': {
      return { ...state, shouldExit: true };
    }

    case 'BACK': {
      // No-op in the pane model — kept for backward compatibility.
      return state;
    }

    // The remaining actions are no-ops during the loading phase.
    default: {
      if (state.phase === 'loading') return state;
      return readyTransition(state, action, findingsCount);
    }
  }
}

/**
 * Handles transitions that are only valid when the dashboard is in the
 * `'ready'` phase (i.e. after the pipeline completes).
 */
function readyTransition(
  state: DashboardState,
  action: Exclude<DashboardAction, { type: 'PIPELINE_COMPLETE' | 'QUIT' | 'BACK' }>,
  findingsCount: number,
): DashboardState {
  switch (action.type) {
    case 'SELECT_FINDING': {
      return {
        ...state,
        selectedIndex: action.index,
        activePane: 'detail',
      };
    }

    case 'FOCUS_NEXT_PANE': {
      const next = nextPane(state.activePane, state.specsVisible);
      if (next === state.activePane) return state;
      return { ...state, activePane: next };
    }

    case 'FOCUS_PREV_PANE': {
      const prev = prevPane(state.activePane, state.specsVisible);
      if (prev === state.activePane) return state;
      return { ...state, activePane: prev };
    }

    case 'TOGGLE_SPECS': {
      const nowVisible = !state.specsVisible;
      // If hiding specs while the specs pane is focused, move focus to detail.
      const activePane =
        !nowVisible && state.activePane === 'specs' ? 'detail' : state.activePane;
      return { ...state, specsVisible: nowVisible, activePane };
    }

    case 'MOVE_UP': {
      if (state.activePane === 'findings') {
        return {
          ...state,
          selectedIndex: Math.max(0, state.selectedIndex - 1),
        };
      }
      if (state.activePane === 'detail') {
        return {
          ...state,
          detailScrollOffset: Math.max(0, state.detailScrollOffset - 1),
        };
      }
      // specs pane — no-op
      return state;
    }

    case 'MOVE_DOWN': {
      if (state.activePane === 'findings') {
        const max = Math.max(0, findingsCount - 1);
        return {
          ...state,
          selectedIndex: Math.min(max, state.selectedIndex + 1),
        };
      }
      if (state.activePane === 'detail') {
        return { ...state, detailScrollOffset: state.detailScrollOffset + 1 };
      }
      // specs pane — no-op
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Pane cycling helpers
// ---------------------------------------------------------------------------

/**
 * Returns the pane that follows `current` in the forward cycle order.
 *
 * Cycle (specsVisible = true):  findings → detail → specs → findings
 * Cycle (specsVisible = false): findings → detail → findings
 */
function nextPane(current: DashboardPane, specsVisible: boolean): DashboardPane {
  switch (current) {
    case 'findings':
      return 'detail';
    case 'detail':
      return specsVisible ? 'specs' : 'findings';
    case 'specs':
      return 'findings';
  }
}

/**
 * Returns the pane that precedes `current` in the forward cycle order
 * (i.e. the reverse direction).
 *
 * Reverse (specsVisible = true):  findings → specs → detail → findings
 * Reverse (specsVisible = false): findings → detail → findings
 */
function prevPane(current: DashboardPane, specsVisible: boolean): DashboardPane {
  switch (current) {
    case 'findings':
      return specsVisible ? 'specs' : 'detail';
    case 'detail':
      return 'findings';
    case 'specs':
      return 'detail';
  }
}

// ---------------------------------------------------------------------------
// mapKeyToDashboardAction
// ---------------------------------------------------------------------------

/**
 * Translates raw keyboard input into a {@link DashboardAction} (or `null` for
 * unmapped keys).
 *
 * Key mapping:
 * - `'q'`          → QUIT (any pane)
 * - `'tab'`        → FOCUS_NEXT_PANE
 * - `'shift+tab'`  → FOCUS_PREV_PANE
 * - `'t'`          → TOGGLE_SPECS
 * - `'upArrow'`/`'k'`   → MOVE_UP
 * - `'downArrow'`/`'j'` → MOVE_DOWN
 * - `'return'`/`'enter'` → SELECT_FINDING (only from `'findings'` pane)
 * - `'escape'`     → BACK
 *
 * @param key                  - Named key identifier (e.g. `'upArrow'`, `'return'`, `'tab'`, `'shift+tab'`).
 * @param input                - Raw character input (e.g. `'q'`, `'j'`, `'k'`, `'t'`).
 * @param activePane           - The currently focused pane.
 * @param currentSelectedIndex - Current selected finding index for SELECT_FINDING (defaults to 0).
 * @returns A {@link DashboardAction} or `null` when the key is not mapped.
 */
export function mapKeyToDashboardAction(
  key: string,
  input: string,
  activePane: DashboardPane,
  currentSelectedIndex = 0,
): DashboardAction | null {
  // q — quit from any pane
  if (input === 'q') return { type: 'QUIT' };

  // enter / return — open detail from findings pane only
  if (key === 'return' || key === 'enter') {
    if (activePane === 'findings') {
      return { type: 'SELECT_FINDING', index: currentSelectedIndex };
    }
    return null;
  }

  // escape — back (no-op in pane model, kept for compatibility)
  if (key === 'escape') return { type: 'BACK' };

  // tab — cycle forward through panes
  if (key === 'tab') return { type: 'FOCUS_NEXT_PANE' };

  // shift+tab — cycle backward through panes
  if (key === 'shift+tab') return { type: 'FOCUS_PREV_PANE' };

  // t — toggle specs pane visibility
  if (input === 't') return { type: 'TOGGLE_SPECS' };

  // up arrow or 'k'
  if (key === 'upArrow' || input === 'k') return { type: 'MOVE_UP' };

  // down arrow or 'j'
  if (key === 'downArrow' || input === 'j') return { type: 'MOVE_DOWN' };

  return null;
}
