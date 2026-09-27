# Product workflow

Marginalia is both a working reader and an ongoing product experiment. This document makes the reasoning behind product work visible alongside the code.

## Start with the decision, not the feature

Use one of four issue types:

- **User problem** — evidence that a reader is struggling to accomplish something.
- **Feature or improvement** — a proposed solution tied to a user problem and an observable outcome.
- **Experiment or spike** — a bounded test that reduces uncertainty before a larger build.
- **Bug** — behavior that differs from the intended product experience.

A feature request can begin as a rough idea. Before substantial implementation, the issue should make clear:

1. who experiences the problem;
2. what evidence suggests it matters;
3. what outcome the change should produce;
4. what alternatives or constraints matter;
5. how we will know whether the change worked.

Issues #8, #9, and #10 are useful examples of this style: they make the decision question, constraints, and completion criteria explicit.

## Project board

The public project board should make prioritization and uncertainty visible, not only implementation status.

Recommended fields:

| Field | Values / use |
| --- | --- |
| Status | Discovery · Ready · In progress · Validation · Done |
| Type | User problem · Feature · Experiment · Bug · Tech debt |
| Priority | P0 · P1 · P2 · P3 |
| Area | Reading · Chat/AI · Library/import · Local intelligence · Platform/deployment |
| Confidence | Low · Medium · High |
| Effort | S · M · L |

Recommended views:

- **Now** — Ready + In progress + Validation, ordered by priority.
- **Discovery** — user problems and experiments where the main task is learning.
- **Roadmap** — grouped by Area or milestone, including items not yet committed.
- **Recently shipped** — Done items, useful as a lightweight product changelog.

## Prioritization

Priority is not a promise. It is a current judgment based on:

- user impact and frequency;
- evidence strength;
- strategic fit with Marginalia's core reading-and-thinking experience;
- implementation and maintenance cost;
- privacy, security, reliability, and device constraints;
- opportunity cost relative to other work.

When an issue is intentionally deprioritized or closed, record why. "Not now" and "not enough evidence" are valid product decisions.

## Definition of ready

An issue is **Ready** when someone could begin work without first deciding what problem they are solving.

For features, that normally means the issue has:

- a clear user problem or linked problem issue;
- a hypothesis;
- bounded scope and non-goals;
- success criteria;
- major technical/product constraints called out.

For experiments, it means there is a decision rule: what result would cause us to proceed, change direction, or stop.

## Validation

Shipping is not the final state for meaningful product changes. Move an item to **Validation** when the implementation is live but the expected user outcome has not yet been checked.

Validation can be lightweight:

- use the feature during real reading;
- observe whether the original failure still occurs;
- collect qualitative feedback;
- compare error/usage telemetry where available;
- document surprising side effects.

Record the result on the issue. If the hypothesis was wrong, that is useful product evidence.

## Decision trail

Prefer linking work so a visitor can follow:

**user problem → experiment (when needed) → feature → pull request → validation result**

Not every change needs the full chain. The goal is to make important decisions inspectable, not to add process for its own sake.
