// ---------------------------------------------------------------------------
// TUI navigation state machine
//
// Pure, side-effect-free types and functions that govern all keyboard-driven
// navigation within the TUI. No Ink or React imports — fully testable in a
// Node environment.
// ---------------------------------------------------------------------------

/** The set of screens the TUI can display. */
export type TUIView = 'progress' | 'dashboard' | 'detail' | 'specs';

/** All actions that can drive a state transition. */
export type TUIAction =
  | { type: 'PIPELINE_COMPLETE' }
  | { type: 'SELECT_FINDING'; index: number }
  | { type: 'BACK' }
  | { type: 'TAB' }
  | { type: 'QUIT' }
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' };

/** Snapshot of the entire TUI navigation state. */
export interface TUIState {
  /** The currently visible screen. */
  view: TUIView;
  /** Index of the highlighted finding in dashboard/detail views. */
  selectedIndex: number;
  /** Vertical scroll offset for the detail view. */
  detailScrollOffset: number;
  /** When true the TUI should exit on the next render cycle. */
  shouldExit: boolean;
}

// ---------------------------------------------------------------------------
// initialState
// ---------------------------------------------------------------------------

/**
 * Returns the default TUI state — always begins on the progress screen while
 * the pipeline is running.
 */
export function initialState(): TUIState {
  return {
    view: 'progress',
    selectedIndex: 0,
    detailScrollOffset: 0,
    shouldExit: false,
  };
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

/**
 * Pure reducer: given the current state and an action, returns the next state.
 * The input state is **never** mutated.
 *
 * @param state         - Current navigation state.
 * @param action        - The dispatched action.
 * @param findingsCount - Total number of findings (used to clamp MOVE_DOWN).
 * @returns             A new {@link TUIState} object.
 */
export function transition(
  state: TUIState,
  action: TUIAction,
  findingsCount: number,
): TUIState {
  switch (action.type) {
    case 'PIPELINE_COMPLETE': {
      // Only meaningful from progress; no-op elsewhere.
      if (state.view !== 'progress') return state;
      return { ...state, view: 'dashboard' };
    }

    case 'SELECT_FINDING': {
      // Only meaningful from dashboard; no-op elsewhere.
      if (state.view !== 'dashboard') return state;
      return { ...state, view: 'detail', selectedIndex: action.index };
    }

    case 'BACK': {
      if (state.view === 'detail') {
        // Return to dashboard and reset detail scroll.
        return { ...state, view: 'dashboard', detailScrollOffset: 0 };
      }
      if (state.view === 'specs') {
        return { ...state, view: 'dashboard' };
      }
      // No-op from dashboard or progress.
      return state;
    }

    case 'TAB': {
      if (state.view === 'dashboard') return { ...state, view: 'specs' };
      if (state.view === 'specs') return { ...state, view: 'dashboard' };
      // No-op from progress or detail.
      return state;
    }

    case 'QUIT': {
      return { ...state, shouldExit: true };
    }

    case 'MOVE_UP': {
      if (state.view === 'dashboard') {
        return {
          ...state,
          selectedIndex: Math.max(0, state.selectedIndex - 1),
        };
      }
      if (state.view === 'detail') {
        return {
          ...state,
          detailScrollOffset: Math.max(0, state.detailScrollOffset - 1),
        };
      }
      return state;
    }

    case 'MOVE_DOWN': {
      if (state.view === 'dashboard') {
        const max = Math.max(0, findingsCount - 1);
        return {
          ...state,
          selectedIndex: Math.min(max, state.selectedIndex + 1),
        };
      }
      if (state.view === 'detail') {
        return { ...state, detailScrollOffset: state.detailScrollOffset + 1 };
      }
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// mapKeyToAction
// ---------------------------------------------------------------------------

/**
 * Translates raw keyboard input into a {@link TUIAction} (or `null` for
 * unmapped keys).
 *
 * Callers typically derive `key` from the Ink key object as a string
 * identifier (e.g. `'upArrow'`, `'return'`, `'escape'`, `'tab'`) and pass
 * the raw character in `input`.
 *
 * For `SELECT_FINDING`, callers may optionally provide the current
 * `selectedIndex`; when omitted it defaults to `0` for compatibility with
 * simple tests and provisional call sites.
 *
 * @param key                  - Named key identifier (e.g. `'upArrow'`, `'return'`).
 * @param input                - Raw character input (e.g. `'q'`, `'j'`, `'k'`).
 * @param view                 - The currently active view.
 * @param currentSelectedIndex - Optional selected finding index for Enter/Return.
 * @returns A {@link TUIAction} or `null` when the key is not mapped.
 */
export function mapKeyToAction(
  key: string,
  input: string,
  view: TUIView,
  currentSelectedIndex = 0,
): TUIAction | null {
  // q — quit from any view
  if (input === 'q') return { type: 'QUIT' };

  // enter / return — open detail from dashboard
  if (key === 'return' || key === 'enter') {
    if (view === 'dashboard') {
      return { type: 'SELECT_FINDING', index: currentSelectedIndex };
    }
    return null;
  }

  // escape — go back
  if (key === 'escape') return { type: 'BACK' };

  // tab — toggle between dashboard and specs
  if (key === 'tab') return { type: 'TAB' };

  // up arrow or 'k'
  if (key === 'upArrow' || input === 'k') return { type: 'MOVE_UP' };

  // down arrow or 'j'
  if (key === 'downArrow' || input === 'j') return { type: 'MOVE_DOWN' };

  return null;
}
