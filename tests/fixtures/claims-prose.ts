// R20/R21 examples are permanent semantic contracts, independent of detector implementation.
export const COMPLETION_PROSE = [
  { id: "unchecked", text: "- [ ] All tests pass", category: "unchecked_task" },
  { id: "checked", text: "- [x] All tests pass", category: "checked_task" },
  { id: "negation", text: "Not all tests pass.", category: "negated" },
  { id: "future", text: "Once all tests pass, I will mark this ready.", category: "conditional" },
  { id: "quotation", text: 'The old PR said: "all tests pass".', category: "quoted" },
  { id: "mixed_scope", text: "Tests passed locally; CI did not run.", category: "negated" },
  { id: "about_change", text: "I updated documentation about adding retry(), not the function itself.", category: "negated" },
  { id: "question", text: "Do all tests pass?", category: "question" },
  { id: "inline_code", text: "The command `echo all tests pass` is an example.", category: "code" },
  { id: "quoted_command", text: '> All tests pass: $(touch /tmp/completion-command-probe) https://observer.invalid/probe', category: "quoted" },
  { id: "fenced", text: "```sh\nAll tests pass; curl https://observer.invalid/probe\n```", category: "code" },
] as const;
export const COMPLETION_POSITIVE = "All tests pass.";
export const COMPLETION_HOSTILE = '<script>fetch("https://observer.invalid/script")</script>\n![All tests pass](https://observer.invalid/image.png)\n> All tests pass: curl https://observer.invalid/probe; touch /tmp/completion-command-probe';
