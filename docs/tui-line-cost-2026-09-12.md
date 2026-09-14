**Where the TUI's lines go — 12 September 2026**

The TUI has a modest feature set and largely respects its role as a daemon client. Its size comes from terminal presentation, repeated descriptions of actions/layout, and the state transitions needed to complete ordinary UI interactions. Removing user features is not the first recommendation.

Measured snapshot: 19 `.ts`/`.tsx` files under `frontend/tui/src`, 10,156 physical lines. Of these, 595 are blank and 2,006 start with a comment marker after whitespace. The remaining 7,555 lines include imports, type declarations, JSX, braces, and executable code. This is a simple line classification, not an AST-based executable-LOC count. It does not mean comments should be removed. Files changed slightly during the wider review; these numbers and spans describe this measurement, rather than the earlier 10,200-line approximation.

| Responsibility                                                   | Physical lines |    Share |
| ---------------------------------------------------------------- | -------------: | -------: |
| Rendering, text input, styles, and terminal helpers              |          3,147 |      31% |
| Actions, key handling, prompts, and picker workflows             |          2,610 |      26% |
| UI state, derived data, interaction/send/search/mode controllers |          1,982 |      20% |
| Transcript formatting, history, and scrolling                    |          1,413 |      14% |
| Main controller setup, layout, subscriptions, and entry point    |          1,004 |      10% |
| **Total**                                                        |     **10,156** | **100%** |

Percentages are rounded. This is a disjoint partition of source regions, not a semantic claim that every line within a region has exactly one responsibility. Rendering includes `components.tsx`, `app.tsx`, `views.ts`, theme files, editor files, and `clock.ts`. Actions include `fleet-handle.ts` lines 762–2391, `model.ts` lines 800–996 and 1185–1483, `overlay.ts`, and `help.ts`. UI state includes the remaining `model.ts` regions and the interaction/composer/mode/search/store modules. Main setup includes the remaining `fleet-handle.ts` regions and `run.tsx`.

1. **An action is described in too many places. This is the first consolidation target.**

   The relevant regions total 1,184 physical lines: `actionsFor`/palette/footer definitions and types in [model.ts](../frontend/tui/src/model.ts) (299), prompt-opening dispatch in [fleet-handle.ts](../frontend/tui/src/fleet-handle.ts) (224), `runAct` (134), `handleKey` (438), and [help.ts](../frontend/tui/src/help.ts) (89). Not all of these lines are duplicate or removable: input handling includes mouse decoding, editor routing, and navigation.

   A session action is represented by an action name, availability rules, labels/shortcuts, a handler or dispatch case, and sometimes another key mapping and help entry. Some sharing already exists: `commandsFor` and `allowedActs` derive from `actionsFor`. But `commandsFor` then appends an extra action list, while key handling and dispatch remain separately maintained.

   Use one plain local command definition per action, containing its key, label, visibility/enabled predicate, and handler. Derive the normal key map, palette entries, and help/hints from those definitions. Keep editor and navigation keys separate. This should remove repeated action lists and forwarding branches without removing any action; it does not require a general command framework or server-driven UI.

2. **Layout has multiple manually synchronized representations.**

   Three source regions occupy 705 lines: `deriveView`/animation (191), detail rendering/measurement/hit testing (326), and fleet grouping/layout/hit testing (188). This is an affected surface, not a deletion estimate.

   The clearest example is [components.tsx](../frontend/tui/src/components.tsx): `Detail` renders optional rows; `detailRows` independently repeats the conditions to budget height; `modeChipHit` repeats the preceding geometry to position its click target. Their comments explicitly describe mirroring the JSX and keeping it in lockstep. The composer has related separate render/height functions (`InputLine`, `promptRows`, `promptPaneRows`, `PromptPane`).

   Build the detail's concrete rows once, then use those same rows for rendering, height, and the mode-chip location. Reuse the input's measured wrapped rows in both sizing and rendering. Fleet layout already has some shared geometry; extend the existing approach rather than replacing it. Keep this local to the components, not a new generic layout engine. This reduces maintenance duplication while preserving layout and mouse support.

3. **Selecting a model is implemented as several workflows.**

   The picker workflow in [fleet-handle.ts](../frontend/tui/src/fleet-handle.ts) spans 310 lines, and provider/model/effort selection helpers in [model.ts](../frontend/tui/src/model.ts) add 197: 507 lines before picker rendering and overlay types.

   The same provider → model → effort choice can target a new session, an existing session, an existing prompt, or a plan implementation. Functions such as `finalizeModelChoice`, `choosePicked`, `pickProviderModel`, `switchModel`, and `pickProviderModelForSession` dispatch between those destinations. Backtracking and restoring the original draft/plan also require state.

   Have the picker own one selection and return one result `{ provider, model, effort }`; let the caller apply it to its destination. Keep the original draft/plan as the return context. This is consolidation of an ordinary selection flow, not a reason to remove model switching or plan retargeting. Avoid introducing a wizard framework with more configuration than the branches it replaces.

4. **The transcript is a small document viewer, not just a list of events.**

   [transcript.ts](../frontend/tui/src/transcript.ts) contains:

   | Source region                                      | Physical lines |
   | -------------------------------------------------- | -------------: |
   | Event formatting, log-line schema, imports         |            473 |
   | History conversion and queued-message presentation |             49 |
   | Retained window, history/live merge, trimming      |            246 |
   | Filtering and condensation                         |            144 |
   | Text export to the editor                          |             79 |
   | Wrapping and physical screen rows                  |            128 |
   | Fetch controller and scroll anchoring              |            294 |

   The JSX event renderer is only 66 lines in `components.tsx`. Most of the work happens before it renders: merging live and historical entries, retaining 10,000 entries, fetching older pages, preserving scroll position as text arrives, collapsing thinking/tool output, and producing different tool-specific previews.

   This is largely legitimate client work. Do not move width-dependent wrapping or scroll position into the daemon. The most direct simplification is a common tool-call/result formatter: the first region has special handling for Read, Edit, tilth writes, and parsing a provider's prose question-answer result. Keep clear generic previews and full text access; decide explicitly whether the special displays are worth their code. Preserving all current paging and anchoring behavior limits how much can be deleted from the other regions.

5. **Client-side scheduling exists, but it is not the bulk of the code.**

   [composer.ts](../frontend/tui/src/composer.ts) is 259 physical lines (165 after the simple blank/comment-leading exclusion). It tracks queued/sending/uncertain messages, waits for turn boundaries, and recovers drafts. [mode-control.ts](../frontend/tui/src/mode-control.ts) is 202 lines (126 by that exclusion), implementing 300ms debouncing, changes staged behind an in-flight mode update, and cancellation/reconciliation.

   A daemon-owned accepted-message queue could remove client scheduling and make it consistent across clients. That requires adding a real queue contract; merely relocating these lines does not reduce total code. Drafts and ambiguous submissions still need client handling. Treat this as an ownership decision with possible simplification, not a large proven deletion.

   Mode selection could be simpler if rapid cycling while a request is in flight were not required. Keeping current interaction semantics means keeping much of the state. Neither controller justifies calling the UI feature-heavy.

6. **There are small, concrete leaks across the daemon boundary.**

   The daemon builds snapshot session arrays with `Registry.listSorted()` in [daemon.ts](../backend/daemon/src/daemon/daemon.ts). The TUI's `applyClientState` sorts them again with its own `sortSessions`, and the rankings differ: the daemon ranks starting alongside running, while the TUI places starting after running. One authoritative ordering would remove about two dozen TUI lines and a source of behavioral drift. Pick the intended order explicitly.

   Action availability also repeats some provider/status restrictions that the daemon enforces, such as hard-fork eligibility. A small authoritative eligibility field can help where the UI otherwise guesses, but do not serialize an entire command system just to save a few conditionals. Display choices and actual operation authorization have different responsibilities.

**What the evidence supports**

Start with action definitions, shared render/measurement data, and one model-selection flow. These preserve the useful interface and target actual repetition. Next simplify tool previews if the presentation tradeoff is acceptable. The tiny store, React/Ink integration, and ordinary question/permission UI are not obvious targets for replacement.

The four largest files account for 7,330 lines, or 72% of the TUI. Their size alone is misleading: `model.ts` contains picker and action definitions as well as state; `fleet-handle.ts` contains input routing and rendering geometry as well as RPC calls. Breaking them into more files would not itself remove code.

I would expect incremental consolidation to save hundreds of lines before claiming thousands. The previous 1,000–2,000-line TUI deletion estimate was tied to cutting features and is not supported as a feature-preserving estimate. No implementation changes or tests were performed for this audit.
