// Loaded via --import before the test runner starts (see the test* scripts in
// package.json). Pins the suite to colorless rendering:
//
// ink colors via chalk, whose support level is resolved once at import time
// from the *real* stdout's TTY-ness and the environment. Running the suite
// from an interactive terminal therefore leaks ANSI codes into the frames the
// TUI tests match against — and ink's per-line trimEnd can't strip trailing
// whitespace once it sits inside a styled span (the reset code becomes the
// line's last character), so several assertions only fail under color.
// NO_COLOR keeps frames byte-identical on every machine, TTY or not.
process.env.NO_COLOR = "1";
delete process.env.FORCE_COLOR; // FORCE_COLOR would override NO_COLOR
