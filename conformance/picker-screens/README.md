# Picker screen captures

Raw `{label, cursor, lines}` screen captures taken from a live Claude Code
session on 2026-07-20, driven via pupptyeer against a real terminal. These are
the ground truth that `pickerOwnsInput(screen)` / `picker_owns_input(screen)`
are pinned against, in `packages/core/src/detect.test.ts`,
`packages/python/tests/test_detect.py`, and the
`conformance/cases/detect-picker-owns-input-*.json` corpus.

They exist because reasoning about this predicate went wrong twice. The first
implementation matched a row shape that ordinary typed text also has, which
would have rejected every prompt a user sent after any numbered list. Only a
real screen settled it.

- `screens.json`: states 1 through 5. Their `lines` arrays were filtered of
  blank lines before being saved, so a capture's `cursor.row` does not index
  into these arrays directly - the tests that use them reconstruct an aligned
  array and verify `lines[cursor.row]` lands on the intended row.
- `screens2.json`: states 6 and 7. These kept the raw, unfiltered grid, so
  `cursor.row` indexes directly into `lines`.
- `screens3.json`: a later run that recaptured the staged-text state as a raw
  grid (`2raw-staged-numbered-text`), so the one state whose classification
  actually depends on `cursor.row` lining up with `lines` is pinned against a
  real grid rather than a reconstructed one. This is the fixture the
  `state2-staged-numbered-text` conformance case is built from.

States covered:

1. `1-idle-input-box`: live empty input, cursor visible on the bare `❯` row.
2. `2-staged-numbered-text`: text typed but not submitted (`❯ 1. Fix the
   login bug`), cursor visible on that same row.
3. `3-after-clear`: back to an empty input row.
4. `4-after-submitting-numbered-list`: a submitted numbered message
   (`❯ 1. Reply with only the word alpha`) stays in scrollback while a
   separate, live empty `❯` row sits below it with the cursor on it.
5. `5-askuserquestion-picker-open`: a real `AskUserQuestion` picker.
   `cursor.visible` is `false`; the highlighted option renders as `❯ 1. Red`
   and the other options carry no glyph at all.
6. `6-mid-turn-busy`: the live empty `❯` input row is present, cursor visible
   on it, while the session is mid-turn and busy.
7. `7-tool-permission-prompt`: a misnomer, kept for provenance. It intended to
   capture an open tool-permission prompt but landed after the tool call had
   already been approved and run, so no numbered accept/deny row is on screen.
   A second attempt (`screens3.json`, `--permission-mode default`) also failed
   to produce one: the command ran without ever asking.

## Unverified state

**A real tool-permission prompt has never been captured**, across two
deliberate attempts. The predicate is expected to classify it as a picker,
since it renders numbered options and replaces the input box the same way the
`AskUserQuestion` picker does, but that is reasoning, not evidence, and it is
recorded here as unverified rather than claimed as covered. It matters less
than it sounds: the harness spawns sessions with `bypassPermissions` by
default, so tool-permission prompts are not the common case, and the reported
defect was about `AskUserQuestion`, which IS captured and pinned (state 5).

If someone captures one later, add it here and add the conformance case.
