# Public API reports

API Extractor writes the reviewed public surface for every package entry point
to this directory. Run `pnpm build && pnpm api:report` after an intentional
public API change, then commit the updated reports.
