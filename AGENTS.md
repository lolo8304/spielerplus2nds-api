# AGENTS.md

## Project Role

This repository is the NestJS backend/BFF for the SpielerPlus to NDS workflow.
It serves the React app, administers files in the Java generator data folder,
watches downloads, moves and archives SpielerPlus exports, starts the Java
generator, and parses generator output into structured API responses.

The full system has three repositories:

- `spielerplus2nds-app`: React frontend.
- `spielerplus2nds-api`: NestJS BFF in this repository.
- `spielerplus2nds`: Java NDS generator, shell scripts, and season/team data
  folders.

This API owns the boundary between browser UI and local filesystem/process
access. Keep file operations and generator invocation here, not in the frontend.

## Working Agreement

- Expect the user to make changes at the same time. Always inspect and work with
  the current git state, including uncommitted changes, before editing.
- Treat all existing git changes as intentional context unless the user asks for
  a revert.
- The user is also working on the code. Always take all current changes into
  account.
- Do not start dev servers or background services for testing. The user keeps
  them running in watch mode.
- Use the running API at `http://localhost:3000`.
- Use the running frontend at `http://localhost:3001`.
- Keep final responses short and focused on what changed and what was checked.

## Git Workflow

- The repository's integration branch is `main`.
- Normal development should account for all current git changes, including
  uncommitted user edits.
- If the user says `commit + push`, create a branch from `main` with a name based
  on the overall changes, commit the relevant changes there, push the branch, and
  merge it back to `main` automatically.

## Ports And Locations

- Frontend app: `http://localhost:3001`
- API: `http://localhost:3000`
- Java generator repository: `/Users/Lolo/git/spielerplus2nds`
- Java generator command wrapper:
  `/Users/Lolo/git/spielerplus2nds/nds.sh`
- Java generator run location: `/Users/Lolo/git/spielerplus2nds`
- Java installed app binary:
  `/Users/Lolo/git/spielerplus2nds/app/build/install/app/bin/app`
- Data folder root: `/Users/Lolo/git/spielerplus2nds/data`
- Downloads folder: `/Users/Lolo/Downloads`
- Example season folder: `/Users/Lolo/git/spielerplus2nds/data/2026-1`
- Example team folder: `/Users/Lolo/git/spielerplus2nds/data/2026-1/B`

## Local Commands

- Install: `npm install`
- Dev server: `npm run start:dev`
- Build: `npm run build`
- Lint/fix: `npm run lint`
- Unit tests: `npm run test`
- E2E tests: `npm run test:e2e`
- Format: `npm run format`

The active local API for this workspace listens on `http://localhost:3000`.

## Runtime Assumptions

Important constants currently live in `src/app.service.ts`:

- Data folder: `/Users/Lolo/git/spielerplus2nds/data`
- Downloads folder: `/Users/Lolo/Downloads`
- NDS script: `/Users/Lolo/git/spielerplus2nds/nds.sh`
- Default season: `2026-1`
- All target id: `__all`
- Teams: `B`, `C`, `Da`, `Db`, `Dc`, `Dd`, `E`, `F`, `G`

The service requires read/write access to the data and download folders. The
generator script expects the Java project to be installed/built so that
`./app/build/install/app/bin/app` exists in `../spielerplus2nds`.

## Domain Model

The system optimizes generation/conversion of NDS attendance import data based
on:

- SpielerPlus participant/player exports: `*_Teilnehmende_*.csv`
- SpielerPlus trainer exports: `*_Leiterinnen_Leiter_*.xlsx`
- SpielerPlus activity exports: `*_Aktivitäten_*.xlsx`
- SpielerPlus attendance/statistics exports: `statistics-*.csv`
- Wildcard/manual attendance rows: `nds+anwesenheiten-always.csv`
- Java generator output and warnings.

Data is organized in the Java repository by season and team:

```text
/Users/Lolo/git/spielerplus2nds/data/
  2026-1/
    B/
    C/
    Da/
    Db/
    E/
      config.json
      Ea/
      Eb/
```

Team `config.json` files are maintained through this API boundary and are used
to discover subteams and features such as `splitPlayers`, `splitTrainers`, and
`split1418`.

## API Contract

Current endpoints:

- `GET /config`
- `GET /teams?season=...`
- `GET /downloads?season=...`
- `GET /downloads/events`
- `GET /wildcards?season=...&targetId=...`
- `POST /downloads/move`
- `POST /downloads/clear`
- `POST /generate`

Keep DTO shapes compatible with the frontend types in
`../spielerplus2nds-app/src/App.tsx`.

## File Handling Rules

- Always validate season names and filenames before constructing paths.
- Never allow arbitrary path traversal from request bodies or query strings.
- Only accept known download patterns:
  - `*_Aktivitäten_*.xlsx`
  - `*_Leiterinnen_*.xlsx`
  - `*_Teilnehmende_*.csv`
  - `statistics-*.csv`
- Normalize Unicode filenames where matching matters. SpielerPlus exports may
  use composed or decomposed umlauts.
- Archive existing matching files in `_archive` before replacing them.
- `statistics-*.csv` can only be moved into top-level team folders, never
  subteams.
- Subteam folders are valid import targets for participant, trainer, and
  activity exports.
- Generate can only run for top-level teams or `__all`.

## Generator Contract

The API invokes the Java generator through `nds.sh`:

```sh
nds.sh "<data-folder>/<season>" <team>
nds.sh "<data-folder>/<season>"
```

The no-team form generates all teams. The API parses stdout for:

- Missing persons.
- Missing or wrong events.
- Missing trainer certifications.
- Missing trainers for events.
- Trainer conflicts.
- Generated import file and record count.

The Java output includes team markers like:

```text
Nds Generator for team  'B'
```

Preserve this source-team context when parsing warnings for the frontend.

## Implementation Guidelines

- Keep filesystem logic in `AppService` or focused helpers; do not duplicate
  path rules in controllers.
- Use `fs-extra`, `path`, `chokidar`, and `execFile` as currently established.
- Prefer structured XLSX/CSV parsing helpers over regex-only row parsing when
  the file format becomes more complex.
- Keep expensive file scans bounded to the active season and known teams.
- Treat generated files as mutable operational data. Avoid broad deletes or
  rewrites unless the endpoint explicitly does that.
- When changing output parsing, add focused tests with representative Java
  stdout samples.

## Verification

Run the narrowest useful checks for the change:

```sh
npm run build
npm run test
npm run test:e2e
```

For file movement and generation flows, verify manually against a non-critical
season/team folder or test fixture before touching current production data. Do
not start services for this; use the already-running API on
`http://localhost:3000`.
