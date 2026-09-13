# angular-conventions - evidence appendix

The measured anecdotes behind this skill's rules, kept out of the run-time body so a routine load stops paying
for them. Audit material: read it to learn WHY a rule is shaped the way it is, never to run the skill.

## Intro - docs currency
- **For any API surface not pinned down here, reach for the context7 MCP or the Angular CLI MCP rather than memory, never by grepping node_modules** - measured: one agent run spent ~5.2k tokens grep/sed-ing minified `@angular/core` for a `LOCALE_ID` answer while both MCPs sat live and unused; the routing line then lived only in a broader web index skill that is not loaded once this leaf skill is, so the rule now sits in the leaf itself.
