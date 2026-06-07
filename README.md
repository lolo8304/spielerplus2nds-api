# FCRWW - SpielerPlus to NDS API

NestJS backend for the FCRWW SpielerPlus to NDS workflow. It scans the download folder, moves incoming SpielerPlus exports into team folders, archives replaced files, runs the NDS generator script, and parses the output into structured data for the React app.

## Requirements

- Node.js and npm
- macOS or a Unix-like environment with `unzip` available
- Read/write access to:
  - `/Users/Lolo/git/spielerplus2nds/data`
  - `/Users/Lolo/Downloads`
- NDS generator script:
  - `/Users/Lolo/git/spielerplus2nds/nds.sh`

## Installation

```sh
npm install
```

## Run

```sh
npm run start:dev
```

The API listens on `http://localhost:3001`.

## Build and lint

```sh
npm run build
npm run lint
```

## Features

- Serves app configuration, seasons, teams, folder paths, and download patterns.
- Watches `/Users/Lolo/Downloads` for new matching files.
- Lists pending download files matching known SpielerPlus export patterns.
- Moves selected download files into a team or subteam folder.
- Archives existing matching files in `_archive` before replacing them.
- Prevents `statistics-*.csv` files from being imported into subteams.
- Reads optional team `config.json` files for subteam definitions.
- Computes team metrics without running Generate:
  - players from `*_Teilnehmende_*.csv`
  - J+S trainers and assistants from `*_Leiterinnen_Leiter_*.xlsx`
  - trainings and tournaments from `*_Aktivitäten_*.xlsx`
  - summary rows from `*-to-import-1-all.csv`
- Aggregates parent team counts with configured subteams.
- Lets the frontend aggregate All counts from top-level teams only, avoiding subteam double counting.
- Runs the NDS generator script:
  - team: `nds.sh "<data-folder>/<season>" <team>`
  - all: `nds.sh "<data-folder>/<season>"`
- Parses generator output for:
  - missing persons
  - missing or wrong events
  - missing certifications
  - missing trainers for events
  - trainer conflicts
  - generated import file record count
- Enriches parsed warnings with source team context from:

```text
Nds Generator for team  'B'
```

## UI snapshots

The frontend README contains screenshots of the app states that consume this API:

- All dashboard with aggregate counts
- Missing data box and Generate output
- Team metric view

See:

```text
../spielerplus2nds-app/README.md
```

## Preconditions

The data root must use this structure:

```text
/Users/Lolo/git/spielerplus2nds/data/
  2026-1/
    B/
    C/
    Da/
    Db/
    Dc/
    Dd/
    E/
      config.json
      Ea/
      Eb/
    F/
    G/
```

Supported seasons are returned by `GET /config`, currently sorted newest first:

```text
2026-1
2025-2
2025-1
2024-2
2024-1
2023-2
2023-1
```

## API endpoints

- `GET /config`
  - returns title, folders, teams, seasons, default season, and download patterns
- `GET /teams?season=2026-1`
  - returns teams, subteams, folder paths, existence flags, and computed counts
- `GET /downloads`
  - returns matching pending files in `/Users/Lolo/Downloads`
- `GET /downloads/events`
  - server-sent events stream for download folder changes
- `POST /downloads/move`
  - body: `{ "filename": "...", "targetId": "G", "season": "2026-1" }`
  - moves the file to the selected target folder and returns refreshed downloads
- `GET /wildcards?season=2026-1&targetId=G`
  - returns parsed wildcard attendance rows
- `POST /generate`
  - body: `{ "season": "2026-1", "targetId": "G" }`
  - body for All: `{ "season": "2026-1", "targetId": "__all" }`

## Data structure

### Input files

Input files are expected in each team or subteam folder.

#### Participants

Filename pattern:

```text
*_Teilnehmende_*.csv
```

Used for:

- player count
- participant data used by the external NDS generator

Expected separator: semicolon.

Example:

```csv
PERSONENNUMMER;NAME;VORNAME;GEBURTSDATUM;GESCHLECHT;AHVN_NR;PEID;NATIONALITÄT;MUTTERSPRACHE;STRASSE;HAUSNUMMER;PLZ;ORT;LAND
100596018;Mannhart;Yanick;25.01.2021;M;756.4235.7971.19;;CH;DE;Grünaustrasse;4;8624;Grüt (Gossau ZH);CH
```

#### Trainers

Filename pattern:

```text
*_Leiterinnen_Leiter_*.xlsx
```

Used for:

- J+S trainer count
- assistant count
- trainer-name lookup for missing certifications
- available J+S trainer list for missing-trainer warnings

Expected first worksheet columns:

```text
Personennummer
Name
Vorname
Geburtsdatum
PLZ
Ort (rechtl. Sitz)
Funktion
```

Example rows:

```text
Personennummer | Name     | Vorname   | Funktion
2172010        | Civrilli | Abdülkadir| J+S-Leiter/-in
100544606      | Kryeziu  | Bekri     | Helfer/-in
```

Counting rules:

- `Funktion` containing `J+S-Leiter` counts as trainer.
- `Funktion` containing `Helfer` counts as assistant.
- Missing-trainer suggestions list only J+S trainers, not Helfer.

#### Activities

Filename pattern:

```text
*_Aktivitäten_*.xlsx
```

The filename matcher normalizes Unicode so both composed and decomposed umlaut variants are supported, for example:

```text
Aktivitäten
Aktivitäten
```

Used for:

- training count
- tournament count
- activity data used by the external NDS generator

Expected first worksheet columns:

```text
Datum
Wochentag
Aktivitätstyp
Zeit
Dauer
Ort
Status
Anzahl Überschneidungen
```

Counting rules:

- `Aktivitätstyp` containing `Training` counts as training.
- `Aktivitätstyp` containing `Wettkampf` counts as tournament.

Example:

```text
Datum     | Wochentag | Aktivitätstyp | Zeit  | Dauer              | Ort
7.1.2026 | Mittwoch  | Training      | 18:00 | 1 Stunde 30 Minuten| Buchholz, Uster
17.1.2026| Samstag   | Wettkampf     |       |                    |
```

#### Statistics

Filename pattern:

```text
statistics-*.csv
```

Rules:

- Can only be imported into top-level team folders.
- Cannot be imported into subteam folders.

#### Wildcard attendance

Filename:

```text
nds+anwesenheiten-always.csv
```

Used for the frontend Wildcards section.

Expected separator: semicolon.

Expected columns:

```text
PERSONENNUMMER;FUNKTION;DATUM;AKTIVITÄTSTYP;ZEIT;DAUER;ORT;Kommentar
```

Example:

```csv
PERSONENNUMMER;FUNKTION;DATUM;AKTIVITÄTSTYP;ZEIT;DAUER;ORT;Kommentar
59662;J+S-Leiter/-in;100%;TrainingWettkampf;*;*;*;Lolo
100226607;J+S-Leiter/-in;100%;Training;*;*;*;Arianit
```

#### Team configuration

Optional filename:

```text
config.json
```

Location: top-level team folder.

Used for:

- subteam discovery
- displaying indented subteams in the frontend
- enabling imports directly into subteam folders

Example:

```json
{
  "team": "E",
  "subteams": ["Ea", "Eb"],
  "features": ["splitPlayers", "splitTrainers", "split1418"]
}
```

Only `subteams` affects the current API/frontend behavior. `features` is tolerated but not used by the app.

### Generated files

Generated files are created by the external NDS script and read by this API.

#### Full import file

Filename pattern:

```text
*-to-import-1-all.csv
```

Used for:

- Summary metric
- generated import record count from script output

Expected separator: semicolon.

Expected columns:

```text
PERSONENNUMMER;FUNKTION;DATUM;AKTIVITÄTSTYP;ZEIT;DAUER;ORT
```

Example:

```csv
PERSONENNUMMER;FUNKTION;DATUM;AKTIVITÄTSTYP;ZEIT;DAUER;ORT
2172010;Leiter/in;03.06.2026;Training;18:00;90;Buchholz  Uster
100366190;Teilnehmer/in;03.06.2026;Training;18:00;90;Buchholz  Uster
```

The Summary count is the number of non-empty rows excluding the header.

Script output example:

```text
Write file data/2026-1/Dd/Dd-to-import-1-all.csv, records=395
```

#### Other generated import files

Known generated files include:

```text
*-to-import-2-auto.csv
*-to-import-3-manual.csv
*-to-summary.csv
```

They may be produced by the NDS script and are left in the team folder. The current UI focuses on `*-to-import-1-all.csv` for the Summary metric and generated record count.

## Parsed generator output

The API parses the full NDS script output.

### Missing persons

Input line example:

```text
IMPORTANT: NOT merged, Person not found Amir Siraj / 03.06.2026 - add it to NDS, export and try again
```

Parsed fields:

- team from the current `Nds Generator for team 'X'` line
- person name
- date of birth

### Missing events

Input line example:

```text
Add Event: 'training' type 'TRAINING '20.03.2026/Wettkampf' - Found activity with but activity is wrong
```

Parsed fields:

- team
- activity type
- date

Events are sorted with `WETTKAMPF` first, then `TRAINING`, both by date.

### Missing certifications

Input line example:

```text
Warning: No trainer info (in nds+certifications) for personenNummer: 100673078 on
```

Parsed fields:

- team
- person number
- trainer name from the matching `*_Leiterinnen_Leiter_*.xlsx`

Duplicate rows are collapsed by team and person number.

### Missing trainer for an event

Input line example:

```text
Issue at data No trainer found for date: 2026-05-26 , event types: WETTKAMPF - missing trainer
```

Parsed fields:

- team
- date
- activity type
- available J+S trainers from the matching team trainer file

### Trainer conflicts

Input line example:

```text
Issue at data Conflict for trainer Abdulkadir Civrilli (2172010) on 13.01.2026 18:00 (Db,TRAINING,-), 13.01.2026 18:00 (Dd,TRAINING,-) - time conflict
```

Parsed fields:

- source team from current generator section
- trainer
- person number
- date and time
- conflicting team
- activity

ANSI color codes in script output are stripped before parsing.

## Import and archive behavior

When a matching download file is moved into a target team folder:

1. The API determines the file pattern.
2. Existing files in the target folder matching that pattern are moved to `_archive`.
3. The archived filename receives an ISO timestamp.
4. The new file is moved into the target folder.
5. The refreshed download list is returned.

Example archive name:

```text
20260606_Leiterinnen_Leiter_3998350.2026-06-07T15-17-58.322Z.xlsx
```

## Notes

- The API intentionally reads `.xlsx` files directly via `unzip` and worksheet XML parsing instead of requiring a spreadsheet dependency.
- Folder constants are currently hard-coded in `src/app.service.ts`.
- The API is designed for local desktop use with trusted local files.
