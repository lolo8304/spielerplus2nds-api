import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import { watch, FSWatcher } from 'chokidar';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const DATA_FOLDER = '/Users/Lolo/git/spielerplus2nds/data';
export const DOWNLOAD_FOLDER = '/Users/Lolo/Downloads';
export const TEAMS = ['B', 'C', 'Da', 'Db', 'Dc', 'Dd', 'E', 'F', 'G'] as const;
export const DOWNLOAD_PATTERNS = [
  '*_Aktivitäten_*.xlsx',
  '*_Leiterinnen_*.xlsx',
  '*_Teilnehmende_*.csv',
  'statistics-*.csv',
];
export const DEFAULT_SEASON = '2026-1';
export const WILDCARDS_FILE = 'nds+anwesenheiten-always.csv';
export const NDS_SCRIPT = '/Users/Lolo/git/spielerplus2nds/nds.sh';
export const ALL_TARGET = '__all';
const execFileAsync = promisify(execFile);

export type Team = (typeof TEAMS)[number];

interface TeamConfig {
  team?: string;
  subteams?: string[];
  features?: string[];
}

export interface DownloadFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  pattern: string;
  guess?: DownloadGuess;
}

export interface DownloadGuess {
  targetId: string;
  team: Team;
  subteam?: string;
  name: string;
  folder: string;
  file: string;
  pattern: string;
  score: number;
  identityScore: number;
  sameRowsPercent: number;
  existingRowsMatchedPercent: number;
  downloadedRows: number;
  existingRows: number;
  matchingRows: number;
  addedRows: number;
  removedRows: number;
  teamIds: string[];
  teamNames: string[];
  candidates: DownloadGuessCandidate[];
}

export interface DownloadGuessCandidate {
  targetId: string;
  team: Team;
  subteam?: string;
  name: string;
  folder: string;
  file: string;
  pattern: string;
  score: number;
  identityScore: number;
  sameRowsPercent: number;
  existingRowsMatchedPercent: number;
  downloadedRows: number;
  existingRows: number;
  matchingRows: number;
  addedRows: number;
  removedRows: number;
  teamIds: string[];
  teamNames: string[];
}

interface DownloadCandidate {
  targetId: string;
  team: Team;
  subteam?: string;
  name: string;
  folder: string;
  file: string;
  pattern: string;
}

interface DownloadSnapshot {
  rows: Set<string>;
  rowCount: number;
  teamIds: Set<string>;
  teamNames: Set<string>;
}

export interface TeamStatus {
  id: string;
  team: Team;
  subteam?: string;
  name: string;
  folder: string;
  exists: boolean;
  level: number;
  counts: {
    players: number;
    trainers: number;
    assistants: number;
    trainings: number;
    tournaments: number;
    summary: number;
    files: number;
  };
}

export interface WildcardEntry {
  personNumber: string;
  function: string;
  date: string;
  activityType: string;
  name: string;
}

export interface MissingPerson {
  sourceTeam: string;
  name: string;
  dateOfBirth: string;
}

export interface MissingEvent {
  sourceTeam: string;
  type: string;
  date: string;
}

export interface MissingCertification {
  sourceTeam: string;
  personNumber: string;
  trainerName: string;
}

export interface MissingTrainer {
  sourceTeam: string;
  date: string;
  eventTypes: string;
  availableTrainers: string[];
}

export interface TrainerConflict {
  sourceTeam: string;
  trainer: string;
  personNumber: string;
  date: string;
  time: string;
  teams: Array<{
    team: string;
    activityType: string;
  }>;
}

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private watcher?: FSWatcher;
  private readonly trainerNameCache = new Map<string, Map<string, string>>();
  private readonly qualifiedTrainerCache = new Map<string, string[]>();
  private readonly downloadEvents = new Subject<{
    type: string;
    files: DownloadFile[];
  }>();

  async onModuleInit() {
    await fs.ensureDir(DOWNLOAD_FOLDER);

    this.watcher = watch(DOWNLOAD_FOLDER, {
      depth: 0,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 800,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath) => void this.emitIfRelevant(filePath, 'changed'))
      .on('unlink', (filePath) => void this.emitIfRelevant(filePath, 'changed'))
      .on(
        'change',
        (filePath) => void this.emitIfRelevant(filePath, 'changed'),
      );
  }

  async onModuleDestroy() {
    await this.watcher?.close();
    this.downloadEvents.complete();
  }

  getConfig() {
    return {
      title: 'FCRWW - SpielerPlus to NDS.',
      dataFolder: DATA_FOLDER,
      downloadFolder: DOWNLOAD_FOLDER,
      teams: TEAMS,
      defaultTeamFolder: this.getTeamFolder(DEFAULT_SEASON, TEAMS[0]),
      downloadPatterns: DOWNLOAD_PATTERNS,
      seasons: this.getSeasons(),
      defaultSeason: DEFAULT_SEASON,
    };
  }

  getDownloadEvents() {
    return this.downloadEvents.asObservable();
  }

  async listDownloads(season = DEFAULT_SEASON): Promise<DownloadFile[]> {
    this.assertSeason(season);

    const entries = await fs.readdir(DOWNLOAD_FOLDER);
    const files = await Promise.all(
      entries.map(async (name) => {
        const filePath = path.join(DOWNLOAD_FOLDER, name);
        const stat = await fs.stat(filePath).catch(() => null);
        const pattern = this.matchPattern(name);

        if (!stat?.isFile() || !pattern) {
          return null;
        }

        return {
          name,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          pattern,
        };
      }),
    );

    const downloads = await Promise.all(
      files
        .filter((file): file is DownloadFile => Boolean(file))
        .map(async (file) => ({
          ...file,
          guess: await this.guessDownloadTarget(file, season),
        })),
    );

    return downloads.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async listTeamStatuses(season = DEFAULT_SEASON): Promise<TeamStatus[]> {
    this.assertSeason(season);

    const nestedStatuses = await Promise.all(
      TEAMS.map(async (team) => {
        const status = await this.getTeamStatus(season, team);
        const config = await this.readTeamConfig(season, team);
        const subteamStatuses = await Promise.all(
          this.getConfiguredSubteams(config).map((subteam) =>
            this.getTeamStatus(season, team, subteam),
          ),
        );
        const parentStatus =
          subteamStatuses.length > 0
            ? {
                ...status,
                counts: this.sumCounts([
                  status.counts,
                  ...subteamStatuses.map(
                    (subteamStatus) => subteamStatus.counts,
                  ),
                ]),
              }
            : status;

        return [parentStatus, ...subteamStatuses];
      }),
    );

    return nestedStatuses.flat();
  }

  async moveDownload(
    filename: string,
    targetId: string,
    season = DEFAULT_SEASON,
  ) {
    this.assertSafeFilename(filename);
    this.assertSeason(season);
    const targetFolder = await this.resolveFolderTarget(season, targetId);

    const pattern = this.matchPattern(filename);
    if (!pattern) {
      throw new BadRequestException(
        'File does not match an allowed download pattern.',
      );
    }

    if (this.isStatisticsFile(filename) && targetFolder.subteam) {
      throw new BadRequestException(
        'statistics-*.csv files can only be moved to the top-level team folder.',
      );
    }

    const source = path.join(DOWNLOAD_FOLDER, filename);
    const sourceExists = await fs.pathExists(source);
    if (!sourceExists) {
      throw new BadRequestException('Download file no longer exists.');
    }

    const teamFolder = targetFolder.folder;
    await fs.ensureDir(teamFolder);

    const target = path.join(teamFolder, filename);
    const archivedFiles = await this.archiveExistingPatternFiles(
      teamFolder,
      pattern,
    );

    await fs.move(source, target, { overwrite: false });
    const downloads = await this.listDownloads(season);
    this.downloadEvents.next({ type: 'moved', files: downloads });

    return {
      moved: true,
      filename,
      season,
      team: targetFolder.team,
      subteam: targetFolder.subteam,
      targetId: targetFolder.id,
      target,
      archivedPrevious: archivedFiles.length > 0,
      archivedFiles,
      downloads,
    };
  }

  async clearDownload(filename: string, season = DEFAULT_SEASON) {
    this.assertSafeFilename(filename);
    this.assertSeason(season);

    const pattern = this.matchPattern(filename);
    if (!pattern) {
      throw new BadRequestException(
        'File does not match an allowed download pattern.',
      );
    }

    const source = path.join(DOWNLOAD_FOLDER, filename);
    const sourceExists = await fs.pathExists(source);
    if (!sourceExists) {
      throw new BadRequestException('Download file no longer exists.');
    }

    await fs.remove(source);
    const downloads = await this.listDownloads(season);
    this.downloadEvents.next({ type: 'cleared', files: downloads });

    return {
      cleared: true,
      filename,
      season,
      downloads,
    };
  }

  async listWildcards(
    season = DEFAULT_SEASON,
    targetId = '',
  ): Promise<WildcardEntry[]> {
    this.assertSeason(season);

    if (!targetId) {
      return [];
    }

    const targetFolder = await this.resolveFolderTarget(season, targetId);
    const filePath = path.join(targetFolder.folder, WILDCARDS_FILE);
    const exists = await fs.pathExists(filePath);

    if (!exists) {
      return [];
    }

    const content = await fs.readFile(filePath, 'utf8');
    const [headerLine, ...lines] = content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    if (!headerLine) {
      return [];
    }

    const headers = headerLine
      .replace(/^\uFEFF/, '')
      .split(';')
      .map((header) => header.trim());

    return lines
      .map((line) => this.parseWildcardLine(headers, line))
      .filter((entry): entry is WildcardEntry => Boolean(entry));
  }

  async generate(season = DEFAULT_SEASON, targetId = '') {
    this.assertSeason(season);
    const seasonFolder = path.join(DATA_FOLDER, season);
    const targetFolder =
      targetId === ALL_TARGET
        ? null
        : await this.resolveFolderTarget(season, targetId);

    if (targetFolder?.subteam) {
      throw new BadRequestException(
        'Generate can only run for top-level teams.',
      );
    }

    const runOutput = await this.runNds(seasonFolder, targetFolder?.team);
    const personsOutput = this.filterNdsOutput(runOutput, 'Person');
    const eventsOutput = this.filterNdsOutput(runOutput, 'Event');

    return {
      season,
      team: targetFolder?.team ?? 'All',
      targetId: targetFolder?.id ?? ALL_TARGET,
      command: targetFolder
        ? `nds "${seasonFolder}" ${targetFolder.team}`
        : `nds "${seasonFolder}"`,
      run: {
        output: runOutput,
        importFile: this.parseImportFile(runOutput),
      },
      persons: {
        output: personsOutput,
        missing: this.parseMissingPersons(runOutput),
      },
      events: {
        output: eventsOutput,
        missing: this.parseMissingEvents(runOutput),
      },
      certifications: {
        missing: await this.parseMissingCertifications(seasonFolder, runOutput),
      },
      trainers: {
        missing: await this.parseMissingTrainers(seasonFolder, runOutput),
      },
      conflicts: this.parseTrainerConflicts(runOutput),
    };
  }

  private async getTeamStatus(
    season: string,
    team: Team,
    subteam?: string,
  ): Promise<TeamStatus> {
    const folder = this.getTeamFolder(season, team, subteam);
    const exists = await fs.pathExists(folder);
    const entries = exists ? await fs.readdir(folder) : [];
    const files = (
      await Promise.all(
        entries.map(async (entry) => {
          const filePath = path.join(folder, entry);
          const stat = await fs.stat(filePath).catch(() => null);
          return stat?.isFile() ? entry : null;
        }),
      )
    ).filter((entry): entry is string => Boolean(entry));

    const [playerCount, trainerCounts, activityCounts, summaryCount] =
      await Promise.all([
        this.countCsvRows(
          this.findLatestFile(folder, files, /Teilnehmende.*\.csv$/i),
        ),
        this.countTrainerRoles(
          this.findLatestFile(folder, files, /Leiter.*\.xlsx$/i),
        ),
        this.countActivities(
          this.findLatestFile(folder, files, /Aktivitäten.*\.xlsx$/i),
        ),
        this.countCsvRows(
          this.findLatestFile(folder, files, /to-import-1-all\.csv$/i),
        ),
      ]);

    return {
      id: this.getTargetId(team, subteam),
      team,
      subteam,
      name: subteam ?? team,
      folder,
      exists,
      level: subteam ? 1 : 0,
      counts: {
        players: playerCount,
        trainers: trainerCounts.trainers,
        assistants: trainerCounts.assistants,
        trainings: activityCounts.trainings,
        tournaments: activityCounts.tournaments,
        summary: summaryCount,
        files: files.length,
      },
    };
  }

  private sumCounts(counts: TeamStatus['counts'][]) {
    return counts.reduce(
      (total, count) => ({
        players: total.players + count.players,
        trainers: total.trainers + count.trainers,
        assistants: total.assistants + count.assistants,
        trainings: total.trainings + count.trainings,
        tournaments: total.tournaments + count.tournaments,
        summary: total.summary + count.summary,
        files: total.files + count.files,
      }),
      {
        players: 0,
        trainers: 0,
        assistants: 0,
        trainings: 0,
        tournaments: 0,
        summary: 0,
        files: 0,
      },
    );
  }

  private findLatestFile(folder: string, files: string[], pattern: RegExp) {
    const matchingFiles = files
      .filter((file) => pattern.test(file.normalize('NFC')))
      .sort((left, right) => right.localeCompare(left))
      .map((file) => path.join(folder, file));

    return matchingFiles.length > 0 ? matchingFiles[0] : '';
  }

  private async guessDownloadTarget(
    file: DownloadFile,
    season: string,
  ): Promise<DownloadGuess | undefined> {
    const downloaded = await this.readDownloadSnapshot(file.path, file.pattern);
    if (downloaded.rowCount === 0) {
      return undefined;
    }

    const candidates = await this.getDownloadCandidates(season, file.pattern);
    const guesses = (
      await Promise.all(
        candidates.map(async (candidate) => {
          const existing = await this.readDownloadSnapshot(
            candidate.file,
            candidate.pattern,
          );
          if (existing.rowCount === 0) {
            return null;
          }

          const matchingRows = this.countSetIntersection(
            downloaded.rows,
            existing.rows,
          );
          const addedRows = Math.max(0, downloaded.rowCount - matchingRows);
          const removedRows = Math.max(0, existing.rowCount - matchingRows);
          const hasMatchingTeamId = this.hasSetIntersection(
            downloaded.teamIds,
            existing.teamIds,
          );
          const hasMatchingTeamName = this.hasSetIntersection(
            downloaded.teamNames,
            existing.teamNames,
          );
          const score = matchingRows / downloaded.rowCount;
          const sameRowsPercent = this.toPercent(score);
          const existingRowsMatchedPercent = this.toPercent(
            matchingRows / existing.rowCount,
          );
          const identityScore = hasMatchingTeamId
            ? 1
            : hasMatchingTeamName
              ? 0.85
              : 0;

          return {
            ...candidate,
            score: Number(score.toFixed(4)),
            sameRowsPercent,
            existingRowsMatchedPercent,
            identityScore,
            downloadedRows: downloaded.rowCount,
            existingRows: existing.rowCount,
            matchingRows,
            addedRows,
            removedRows,
            teamIds: Array.from(downloaded.teamIds).sort(),
            teamNames: Array.from(downloaded.teamNames).sort(),
          };
        }),
      )
    )
      .filter((guess): guess is DownloadGuessCandidate => Boolean(guess))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.identityScore - left.identityScore ||
          right.matchingRows - left.matchingRows ||
          left.addedRows - right.addedRows ||
          left.removedRows - right.removedRows,
      );

    const [bestGuess] = guesses;
    if (
      !bestGuess ||
      (bestGuess.score === 0 && bestGuess.identityScore === 0)
    ) {
      return undefined;
    }

    return {
      ...bestGuess,
      candidates: guesses.slice(0, 5),
    };
  }

  private async getDownloadCandidates(
    season: string,
    pattern: string,
  ): Promise<DownloadCandidate[]> {
    const targetPattern = this.getCandidateFileRegex(pattern);
    const includeSubteams =
      !this.patternToRegex('statistics-*.csv').test(pattern);
    const nestedCandidates: Array<Array<DownloadCandidate | null>> =
      await Promise.all(
        TEAMS.map(async (team) => {
          const config = await this.readTeamConfig(season, team);
          const targetIds = [
            this.getTargetId(team),
            ...(includeSubteams
              ? this.getConfiguredSubteams(config).map((subteam) =>
                  this.getTargetId(team, subteam),
                )
              : []),
          ];

          return Promise.all(
            targetIds.map(async (targetId) => {
              const target = await this.resolveFolderTarget(season, targetId);
              const entries = await fs
                .readdir(target.folder)
                .catch((): string[] => []);
              const files = (
                await Promise.all(
                  entries.map(async (entry) => {
                    const filePath = path.join(target.folder, entry);
                    const stat = await fs.stat(filePath).catch(() => null);
                    return stat?.isFile() ? entry : null;
                  }),
                )
              ).filter((entry): entry is string => Boolean(entry));
              const latestFile = this.findLatestFile(
                target.folder,
                files,
                targetPattern,
              );

              if (!latestFile) {
                return null;
              }

              return {
                targetId: target.id,
                team: target.team,
                subteam: target.subteam,
                name: target.subteam ?? target.team,
                folder: target.folder,
                file: latestFile,
                pattern,
              };
            }),
          );
        }),
      );

    return nestedCandidates
      .flat()
      .filter((candidate): candidate is DownloadCandidate =>
        Boolean(candidate),
      );
  }

  private getCandidateFileRegex(pattern: string) {
    if (this.patternToRegex('*_Teilnehmende_*.csv').test(pattern)) {
      return /Teilnehmende.*\.csv$/i;
    }

    if (this.patternToRegex('*_Leiterinnen_*.xlsx').test(pattern)) {
      return /Leiter.*\.xlsx$/i;
    }

    if (this.patternToRegex('*_Aktivitäten_*.xlsx').test(pattern)) {
      return /Aktivitäten.*\.xlsx$/i;
    }

    if (this.patternToRegex('statistics-*.csv').test(pattern)) {
      return /^statistics-.*\.csv$/i;
    }

    return this.patternToRegex(pattern);
  }

  private async readDownloadSnapshot(
    filePath: string,
    pattern: string,
  ): Promise<DownloadSnapshot> {
    if (/\.xlsx$/i.test(filePath)) {
      return this.readXlsxSnapshot(filePath);
    }

    return this.readCsvSnapshot(filePath, pattern);
  }

  private async readCsvSnapshot(
    filePath: string,
    pattern: string,
  ): Promise<DownloadSnapshot> {
    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    const lines = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const [headerLine, ...rowLines] = lines;
    const headers = headerLine ? this.parseCsvLine(headerLine) : [];
    const teamIdIndex = headers.findIndex((header) => header === 'team_id');
    const teamNameIndex = headers.findIndex((header) => header === 'team_name');
    const ignoredIndexes = new Set(
      this.getIgnoredCsvColumns(pattern)
        .map((ignoredColumn) =>
          headers.findIndex((header) => header === ignoredColumn),
        )
        .filter((index) => index >= 0),
    );
    const rows = new Set<string>();
    const teamIds = new Set<string>();
    const teamNames = new Set<string>();

    for (const rowLine of rowLines) {
      const normalizedLine = rowLine.normalize('NFC');
      const values = this.parseCsvLine(normalizedLine);
      const rowKey =
        ignoredIndexes.size > 0
          ? values
              .filter((_, index) => !ignoredIndexes.has(index))
              .map((value) => value.trim().normalize('NFC'))
              .join('\u001F')
          : normalizedLine;
      const teamId = teamIdIndex >= 0 ? values[teamIdIndex]?.trim() : '';
      const teamName =
        teamNameIndex >= 0
          ? values[teamNameIndex]?.trim().normalize('NFC')
          : '';

      rows.add(rowKey);

      if (teamId) {
        teamIds.add(teamId);
      }

      if (teamName) {
        teamNames.add(teamName);
      }
    }

    return {
      rows,
      rowCount: rows.size,
      teamIds,
      teamNames,
    };
  }

  private async readXlsxSnapshot(filePath: string): Promise<DownloadSnapshot> {
    const rows = await this.readXlsxRows(filePath).catch(
      (): Record<string, string>[] => [],
    );
    const rowKeys = new Set<string>();

    for (const row of rows) {
      rowKeys.add(this.createRowObjectKey(row));
    }

    return {
      rows: rowKeys,
      rowCount: rowKeys.size,
      teamIds: new Set<string>(),
      teamNames: new Set<string>(),
    };
  }

  private createRowObjectKey(row: Record<string, string>) {
    return Object.keys(row)
      .sort((left, right) => left.localeCompare(right))
      .map(
        (key) =>
          `${key.trim().normalize('NFC')}=${(row[key] ?? '').trim().normalize('NFC')}`,
      )
      .join('\u001F');
  }

  private getIgnoredCsvColumns(pattern: string) {
    if (this.patternToRegex('statistics-*.csv').test(pattern)) {
      return ['search_params'];
    }

    return [];
  }

  private parseCsvLine(line: string) {
    const values: string[] = [];
    let value = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const nextCharacter = line[index + 1];

      if (character === '"' && quoted && nextCharacter === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === ';' && !quoted) {
        values.push(value);
        value = '';
      } else {
        value += character;
      }
    }

    values.push(value);
    return values;
  }

  private countSetIntersection(left: Set<string>, right: Set<string>) {
    let count = 0;

    for (const value of left) {
      if (right.has(value)) {
        count += 1;
      }
    }

    return count;
  }

  private hasSetIntersection(left: Set<string>, right: Set<string>) {
    for (const value of left) {
      if (right.has(value)) {
        return true;
      }
    }

    return false;
  }

  private toPercent(value: number) {
    return Number((value * 100).toFixed(1));
  }

  private async countCsvRows(filePath: string) {
    if (!filePath || !(await fs.pathExists(filePath))) {
      return 0;
    }

    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    const rows = content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    return Math.max(0, rows.length - 1);
  }

  private async countTrainerRoles(filePath: string) {
    const counts = { trainers: 0, assistants: 0 };

    if (!filePath || !(await fs.pathExists(filePath))) {
      return counts;
    }

    const rows = await this.readXlsxRows(filePath).catch(
      (): Record<string, string>[] => [],
    );

    for (const row of rows) {
      const functionValue = row.Funktion ?? '';

      if (/J\+S-Leiter/i.test(functionValue)) {
        counts.trainers += 1;
      } else if (/Helfer/i.test(functionValue)) {
        counts.assistants += 1;
      }
    }

    return counts;
  }

  private async countActivities(filePath: string) {
    const counts = { trainings: 0, tournaments: 0 };

    if (!filePath || !(await fs.pathExists(filePath))) {
      return counts;
    }

    const rows = await this.readXlsxRows(filePath).catch(
      (): Record<string, string>[] => [],
    );

    for (const row of rows) {
      const activityType = row.Aktivitätstyp ?? '';

      if (/Wettkampf/i.test(activityType)) {
        counts.tournaments += 1;
      } else if (/Training/i.test(activityType)) {
        counts.trainings += 1;
      }
    }

    return counts;
  }

  private async emitIfRelevant(filePath: string, type: string) {
    if (!this.matchPattern(path.basename(filePath))) {
      return;
    }

    this.downloadEvents.next({ type, files: await this.listDownloads() });
  }

  private async archiveExistingPatternFiles(folder: string, pattern: string) {
    const entries = await fs.readdir(folder);
    const matchingFiles = (
      await Promise.all(
        entries.map(async (entry) => {
          const filePath = path.join(folder, entry);
          const stat = await fs.stat(filePath).catch(() => null);
          return stat?.isFile() && this.patternToRegex(pattern).test(entry)
            ? entry
            : null;
        }),
      )
    ).filter((entry): entry is string => Boolean(entry));

    if (matchingFiles.length === 0) {
      return [];
    }

    const archiveFolder = path.join(folder, '_archive');
    await fs.ensureDir(archiveFolder);
    const timestamp = new Date().toISOString().replace(/:/g, '-');

    return Promise.all(
      matchingFiles.map(async (file) => {
        const parsed = path.parse(file);
        const archivedName = `${parsed.name}.${timestamp}${parsed.ext}`;
        const archivedPath = path.join(archiveFolder, archivedName);
        await fs.move(path.join(folder, file), archivedPath, {
          overwrite: false,
        });
        return archivedName;
      }),
    );
  }

  private parseWildcardLine(headers: string[], line: string) {
    const values = line.split(';');
    const record = headers.reduce<Record<string, string>>(
      (current, header, index) => {
        current[header] = values[index]?.trim() ?? '';
        return current;
      },
      {},
    );

    const personNumber = record.PERSONENNUMMER?.trim();
    const functionName = record.FUNKTION?.trim();
    const date = record.DATUM?.trim();
    const activityType = record.AKTIVITÄTSTYP?.trim();
    const name = record.Kommentar?.trim();

    if (!personNumber && !functionName && !date && !activityType && !name) {
      return null;
    }

    return {
      personNumber,
      function: functionName,
      date,
      activityType,
      name,
    };
  }

  private async runNds(seasonFolder: string, team?: Team) {
    const args = team ? [seasonFolder, team] : [seasonFolder];

    try {
      const result = await execFileAsync(NDS_SCRIPT, args, {
        maxBuffer: 1024 * 1024 * 10,
        timeout: 1000 * 60 * 5,
      });
      return this.cleanNdsOutput(`${result.stdout}${result.stderr}`);
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      const output = this.cleanNdsOutput(
        `${execError.stdout ?? ''}${execError.stderr ?? ''}`,
      );

      if (execError.code === 1 && output.length === 0) {
        return '';
      }

      throw new BadRequestException(
        ['nds run failed', execError.message, output]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  private cleanNdsOutput(output: string) {
    return output
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('[INFO]'))
      .join('\n')
      .trim();
  }

  private filterNdsOutput(output: string, pattern: string) {
    return output
      .split(/\r?\n/)
      .filter((line) => line.includes(pattern))
      .join('\n')
      .trim();
  }

  private parseTrainerConflicts(output: string): TrainerConflict[] {
    const conflicts: TrainerConflict[] = [];
    let sourceTeam = '';

    for (const rawLine of output.split(/\r?\n/)) {
      const line = this.stripAnsi(rawLine);
      const teamMatch = line.match(/Nds Generator for team\s+'([^']+)'/i);

      if (teamMatch) {
        sourceTeam = teamMatch[1].trim();
      }

      const match = line.match(
        /Conflict for trainer\s+(.+?)\s+\(([^)]+)\)\s+on\s+(.+?)\s+-\s+time conflict/i,
      );

      if (!match) {
        continue;
      }

      const entries = Array.from(
        match[3].matchAll(
          /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+\(([^,]+),([^,]+),[^)]*\)/g,
        ),
      );

      if (entries.length === 0) {
        continue;
      }

      conflicts.push({
        sourceTeam,
        trainer: match[1].trim(),
        personNumber: match[2].trim(),
        date: entries[0][1],
        time: entries[0][2],
        teams: entries.map((entry) => ({
          team: entry[3].trim(),
          activityType: entry[4].trim(),
        })),
      });
    }

    return conflicts;
  }

  private stripAnsi(value: string) {
    const escapeCharacter = String.fromCharCode(27);
    return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, 'g'), '');
  }

  private parseMissingPersons(output: string): MissingPerson[] {
    const persons: MissingPerson[] = [];
    let sourceTeam = '';

    for (const rawLine of output.split(/\r?\n/)) {
      const line = this.stripAnsi(rawLine);
      const teamMatch = line.match(/Nds Generator for team\s+'([^']+)'/i);

      if (teamMatch) {
        sourceTeam = teamMatch[1].trim();
      }

      const match = line.match(
        /Person not found\s+(.+?)\s*\/\s*(\d{2}\.\d{2}\.\d{4})/i,
      );

      if (!match) {
        continue;
      }

      persons.push({
        sourceTeam,
        name: match[1].trim(),
        dateOfBirth: match[2],
      });
    }

    return persons;
  }

  private parseImportFile(output: string) {
    const matches = Array.from(
      output.matchAll(
        /Write file\s+(.+?-to-import-1-all\.csv),\s*records=(\d+)/gi,
      ),
    );

    if (matches.length === 0) {
      return null;
    }

    if (matches.length === 1) {
      return {
        file: matches[0][1].trim(),
        records: Number(matches[0][2]),
      };
    }

    return {
      file: 'All teams',
      records: matches.reduce((sum, match) => sum + Number(match[2]), 0),
    };
  }

  private async parseMissingCertifications(
    seasonFolder: string,
    output: string,
  ): Promise<MissingCertification[]> {
    const certifications: MissingCertification[] = [];
    const seen = new Set<string>();
    let sourceTeam = '';

    for (const rawLine of output.split(/\r?\n/)) {
      const line = this.stripAnsi(rawLine);
      const teamMatch = line.match(/Nds Generator for team\s+'([^']+)'/i);

      if (teamMatch) {
        sourceTeam = teamMatch[1].trim();
      }

      const match = line.match(
        /Warning:\s*No trainer info\s+\(in nds\+certifications\)\s+for personenNummer:\s*(\d+)/i,
      );

      if (!match) {
        continue;
      }

      const trainerNames = await this.getTrainerNames(seasonFolder, sourceTeam);
      const certificationKey = `${sourceTeam}/${match[1]}`;

      if (seen.has(certificationKey)) {
        continue;
      }

      seen.add(certificationKey);

      certifications.push({
        sourceTeam,
        personNumber: match[1],
        trainerName: trainerNames.get(match[1]) ?? '',
      });
    }

    return certifications;
  }

  private async getTrainerNames(seasonFolder: string, sourceTeam: string) {
    const cacheKey = `${seasonFolder}/${sourceTeam}`;
    const cache = this.trainerNameCache.get(cacheKey);

    if (cache) {
      return cache;
    }

    const names = await this.readTrainerNames(seasonFolder, sourceTeam);
    this.trainerNameCache.set(cacheKey, names);
    return names;
  }

  private async parseMissingTrainers(
    seasonFolder: string,
    output: string,
  ): Promise<MissingTrainer[]> {
    const trainers: MissingTrainer[] = [];
    const seen = new Set<string>();
    let sourceTeam = '';

    for (const rawLine of output.split(/\r?\n/)) {
      const line = this.stripAnsi(rawLine);
      const teamMatch = line.match(/Nds Generator for team\s+'([^']+)'/i);

      if (teamMatch) {
        sourceTeam = teamMatch[1].trim();
      }

      const match = line.match(
        /No trainer found for date:\s*(\d{4}-\d{2}-\d{2})\s*,\s*event types:\s*([A-ZÄÖÜ,\s]+)/i,
      );

      if (!match) {
        continue;
      }

      const eventTypes = match[2].trim();
      const key = `${sourceTeam}/${match[1]}/${eventTypes}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      trainers.push({
        sourceTeam,
        date: match[1],
        eventTypes,
        availableTrainers: await this.getQualifiedTrainerNames(
          seasonFolder,
          sourceTeam,
        ),
      });
    }

    return trainers;
  }

  private async getQualifiedTrainerNames(
    seasonFolder: string,
    sourceTeam: string,
  ) {
    const cacheKey = `${seasonFolder}/${sourceTeam}`;
    const cache = this.qualifiedTrainerCache.get(cacheKey);

    if (cache) {
      return cache;
    }

    const names = await this.readQualifiedTrainerNames(
      seasonFolder,
      sourceTeam,
    );
    this.qualifiedTrainerCache.set(cacheKey, names);
    return names;
  }

  private async readQualifiedTrainerNames(
    seasonFolder: string,
    sourceTeam: string,
  ) {
    const folders = await this.findSourceTeamFolders(seasonFolder, sourceTeam);
    const files = (
      await Promise.all(
        folders.map(async (folder) => {
          const entries = await fs.readdir(folder).catch((): string[] => []);
          return Promise.all(
            entries
              .filter((entry) => /Leiter.*\.xlsx$/i.test(entry))
              .map(async (entry) => {
                const filePath = path.join(folder, entry);
                const stat = await fs.stat(filePath).catch(() => null);
                return stat?.isFile()
                  ? { filePath, modifiedAt: stat.mtime.getTime() }
                  : null;
              }),
          );
        }),
      )
    )
      .flat()
      .filter((entry): entry is { filePath: string; modifiedAt: number } =>
        Boolean(entry),
      )
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    for (const file of files) {
      const rows = await this.readXlsxRows(file.filePath).catch(
        (): Record<string, string>[] => [],
      );
      const names = rows
        .filter((row) => {
          const functionValue = row.Funktion ?? '';
          return (
            /J\+S-Leiter/i.test(functionValue) && !/Helfer/i.test(functionValue)
          );
        })
        .map((row) =>
          [row.Vorname?.trim(), row.Name?.trim()].filter(Boolean).join(' '),
        )
        .filter((name) => name.length > 0);

      if (names.length > 0) {
        return Array.from(new Set(names));
      }
    }

    return [];
  }

  private async readTrainerNames(seasonFolder: string, sourceTeam: string) {
    const names = new Map<string, string>();
    const folders = await this.findSourceTeamFolders(seasonFolder, sourceTeam);
    const files = (
      await Promise.all(
        folders.map(async (folder) => {
          const entries = await fs.readdir(folder).catch((): string[] => []);
          return Promise.all(
            entries
              .filter((entry) => /Leiter.*\.xlsx$/i.test(entry))
              .map(async (entry) => {
                const filePath = path.join(folder, entry);
                const stat = await fs.stat(filePath).catch(() => null);
                return stat?.isFile()
                  ? { filePath, modifiedAt: stat.mtime.getTime() }
                  : null;
              }),
          );
        }),
      )
    )
      .flat()
      .filter((entry): entry is { filePath: string; modifiedAt: number } =>
        Boolean(entry),
      )
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    for (const file of files) {
      const rows = await this.readXlsxRows(file.filePath).catch(
        (): Record<string, string>[] => [],
      );

      for (const row of rows) {
        const personNumber = row.Personennummer?.trim();
        const firstName = row.Vorname?.trim();
        const lastName = row.Name?.trim();

        if (personNumber && (firstName || lastName)) {
          names.set(
            personNumber,
            [firstName, lastName].filter(Boolean).join(' '),
          );
        }
      }

      if (names.size > 0) {
        return names;
      }
    }

    return names;
  }

  private async findSourceTeamFolders(
    seasonFolder: string,
    sourceTeam: string,
  ) {
    if (!sourceTeam) {
      return [];
    }

    const directFolder = path.join(seasonFolder, sourceTeam);

    if (await fs.pathExists(directFolder)) {
      return [directFolder];
    }

    const teamFolders = await fs
      .readdir(seasonFolder)
      .catch((): string[] => []);
    const nestedFolders = await Promise.all(
      teamFolders.map(async (teamFolder) => {
        const folder = path.join(seasonFolder, teamFolder, sourceTeam);
        return (await fs.pathExists(folder)) ? folder : null;
      }),
    );

    return nestedFolders.filter((folder): folder is string => Boolean(folder));
  }

  private async readXlsxRows(filePath: string) {
    const [sharedStringsXml, sheetXml] = await Promise.all([
      this.unzipEntry(filePath, 'xl/sharedStrings.xml'),
      this.unzipEntry(filePath, 'xl/worksheets/sheet1.xml'),
    ]);
    const sharedStrings = this.parseSharedStrings(sharedStringsXml);
    const rawRows = this.parseSheetRows(sheetXml, sharedStrings);
    const headers = rawRows[0] ?? {};

    return rawRows.slice(1).map((row) => {
      const namedRow: Record<string, string> = {};

      for (const [column, header] of Object.entries(headers)) {
        if (header) {
          namedRow[header] = row[column] ?? '';
        }
      }

      return namedRow;
    });
  }

  private async unzipEntry(filePath: string, entry: string) {
    const { stdout } = await execFileAsync('unzip', ['-p', filePath, entry], {
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout;
  }

  private parseSharedStrings(xml: string) {
    return Array.from(xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)).map((match) =>
      Array.from(match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
        .map((textMatch) => this.decodeXml(textMatch[1]))
        .join(''),
    );
  }

  private parseSheetRows(xml: string, sharedStrings: string[]) {
    return Array.from(xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)).map(
      (rowMatch) => {
        const row: Record<string, string> = {};

        for (const cellMatch of rowMatch[1].matchAll(
          /<c\b([^>]*)>([\s\S]*?)<\/c>/g,
        )) {
          const ref = cellMatch[1].match(/\br="([A-Z]+)\d+"/)?.[1];
          const type = cellMatch[1].match(/\bt="([^"]+)"/)?.[1];
          const value = cellMatch[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];

          if (!ref || value === undefined) {
            continue;
          }

          row[ref] =
            type === 's'
              ? (sharedStrings[Number(value)] ?? '')
              : this.decodeXml(value);
        }

        return row;
      },
    );
  }

  private decodeXml(value: string) {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  private parseMissingEvents(output: string): MissingEvent[] {
    const events: MissingEvent[] = [];
    let sourceTeam = '';

    for (const rawLine of output.split(/\r?\n/)) {
      const line = this.stripAnsi(rawLine);
      const teamMatch = line.match(/Nds Generator for team\s+'([^']+)'/i);

      if (teamMatch) {
        sourceTeam = teamMatch[1].trim();
      }

      const match = line.match(
        /Add Event:\s*'[^']*'\s+type\s+'?([A-ZÄÖÜ]+)\s+'?(\d{2}\.\d{2}\.\d{4})/i,
      );

      if (!match) {
        continue;
      }

      events.push({
        sourceTeam,
        type: match[1].trim().toUpperCase(),
        date: match[2],
      });
    }

    return events.sort((left, right) => {
      const priorityDiff =
        this.getEventSortPriority(left.type) -
        this.getEventSortPriority(right.type);

      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return this.parseSwissDate(left.date) - this.parseSwissDate(right.date);
    });
  }

  private getEventSortPriority(type: string) {
    if (/WETTKAMPF/i.test(type)) {
      return 0;
    }

    if (/TRAINING/i.test(type)) {
      return 1;
    }

    return 2;
  }

  private parseSwissDate(date: string) {
    const match = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }

    return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  }

  private getTeamFolder(season: string, team: Team, subteam?: string) {
    return subteam
      ? path.join(DATA_FOLDER, season, team, subteam)
      : path.join(DATA_FOLDER, season, team);
  }

  private getTargetId(team: Team, subteam?: string) {
    return subteam ? `${team}/${subteam}` : team;
  }

  private async resolveFolderTarget(season: string, targetId: string) {
    const [team, subteam, extra] = targetId.split('/');
    this.assertTeam(team);

    if (extra || (subteam && path.basename(subteam) !== subteam)) {
      throw new BadRequestException('Invalid team folder target.');
    }

    if (subteam) {
      const config = await this.readTeamConfig(season, team);
      const configuredSubteams = this.getConfiguredSubteams(config);

      if (!configuredSubteams.includes(subteam)) {
        throw new BadRequestException('Unknown subteam.');
      }
    }

    return {
      id: this.getTargetId(team, subteam),
      team,
      subteam,
      folder: this.getTeamFolder(season, team, subteam),
    };
  }

  private async readTeamConfig(
    season: string,
    team: Team,
  ): Promise<TeamConfig> {
    const configPath = path.join(
      this.getTeamFolder(season, team),
      'config.json',
    );
    const exists = await fs.pathExists(configPath);

    if (!exists) {
      return {};
    }

    try {
      return (await fs.readJson(configPath)) as TeamConfig;
    } catch {
      return {};
    }
  }

  private getConfiguredSubteams(config: TeamConfig) {
    return (config.subteams ?? []).filter(
      (subteam) =>
        typeof subteam === 'string' &&
        subteam.length > 0 &&
        path.basename(subteam) === subteam,
    );
  }

  private getSeasons() {
    const seasons: string[] = [];
    for (let year = 2026; year >= 2023; year -= 1) {
      seasons.push(`${year}-1`);
      seasons.push(`${year}-2`);
    }
    return seasons
      .filter((season) => season !== '2026-2')
      .sort((left, right) => {
        const [leftYear, leftSeason] = left.split('-').map(Number);
        const [rightYear, rightSeason] = right.split('-').map(Number);

        return rightYear - leftYear || rightSeason - leftSeason;
      });
  }

  private assertTeam(team: string): asserts team is Team {
    if (!TEAMS.includes(team as Team)) {
      throw new BadRequestException('Unknown team.');
    }
  }

  private assertSeason(season: string) {
    if (!this.getSeasons().includes(season)) {
      throw new BadRequestException('Unknown season.');
    }
  }

  private assertSafeFilename(filename: string) {
    if (!filename || path.basename(filename) !== filename) {
      throw new BadRequestException('Invalid filename.');
    }
  }

  private matchPattern(filename: string) {
    return DOWNLOAD_PATTERNS.find((pattern) =>
      this.patternToRegex(pattern).test(filename),
    );
  }

  private isStatisticsFile(filename: string) {
    return this.patternToRegex('statistics-*.csv').test(filename);
  }

  private patternToRegex(pattern: string) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }
}
