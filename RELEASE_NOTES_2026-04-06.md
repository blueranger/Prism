# Prism Release Notes

## 2026-04-06

This release turns Prism from a conversation workspace with note export into a more complete wiki compiler and backfill system for personal knowledge bases.

### Highlights

- Added a source-driven wiki compiler with review-first `Compile Plan` and `Compiler Summary` artifacts
- Added Obsidian wiki infrastructure generation, including:
  - `SCHEMA.md`
  - `PRISM_WIKI.md`
  - `index.md`
  - `log.md`
- Added page-kind-aware routing for:
  - `source`
  - `context`
  - `observation`
  - `evergreen`
  - `concept`
  - `topic`
  - `project`
  - `partner`
  - `entity`
- Added multi-artifact wiki maintenance so one source can update multiple wiki targets
- Added compile history, compiler summaries, and saved markdown records for plans and summaries

### Backfill Planner

- Added `Backfill Planner` in Library to turn conversation archives into a staged wiki backfill workflow
- Added reviewable actions per conversation:
  - `Compile now`
  - `Archive only`
  - `Skip`
- Added background backfill execution with:
  - batch processing
  - per-batch wiki lint
  - adaptive tuning notes
  - progress tracking
  - pause / resume
  - cancel
  - retry failed items
  - crash-safe resume from persisted state

### Wiki Quality Improvements

- Improved taxonomy cleanup between `partner`, `entity`, `project`, `topic`, and `concept`
- Improved content-aware index summaries
- Improved raw source handling so imported conversations are preserved in `Sources/`
- Added safer relocate-and-replace behavior for wrongly routed draft pages
- Improved rubric alignment for:
  - Context notes
  - Observation notes
  - Evergreen notes

### UI Updates

- Upgraded Library from mode-first note export toward source-first wiki compilation
- Added compile review UI and compile history
- Added active background backfill console with:
  - current session
  - processed / remaining counts
  - current batch progress
  - tuning notes
- Removed duplicate background-run entry point in the backfill modal and consolidated execution under `Apply Backfill Plan`

### Platform / Integration Additions

- Added browser sync extension scaffolding for:
  - ChatGPT
  - Claude
  - Gemini
- Added memory, observer, trigger, web context, costs, and related API / UI groundwork to support future workflows

### Safety Notes

- Local `.env` files and nested `.env` files remain git-ignored
- SQLite database files remain git-ignored
- Obsidian vault contents are not tracked by this repo unless intentionally copied into the repository
- This release was reviewed to avoid committing runtime keys or local vault data
